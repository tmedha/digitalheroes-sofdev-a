import { AppError } from "../errors.js";
import { assertUrlIsFetchable, parseTargetUrl } from "./ssrf.js";

/**
 * The outbound side of the service. Everything that can go wrong with fetching
 * a stranger's URL is contained here: hostile redirect chains, responses that
 * never end, bodies large enough to exhaust memory, and origins that accept a
 * connection then go quiet.
 */

export interface FetchPageOptions {
  timeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  allowPrivateAddresses: boolean;
  userAgent: string;
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  redirects: RedirectHop[];
  body: string;
  bytes: number;
  contentType: string | null;
  /** Time from first connect to fully-read body. */
  durationMs: number;
  /** Addresses the hostname resolved to, for logs. */
  resolvedAddresses: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isHtmlLike(contentType: string | null): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    essence === "text/html" ||
    essence === "application/xhtml+xml" ||
    essence === "text/plain" ||
    essence.endsWith("+xml")
  );
}

function charsetFromContentType(contentType: string | null): string {
  const match = contentType?.match(/charset\s*=\s*"?([\w-]+)"?/i);
  const charset = match?.[1]?.toLowerCase();
  if (!charset) return "utf-8";
  try {
    new TextDecoder(charset);
    return charset;
  } catch {
    return "utf-8";
  }
}

/** Reads the body, aborting as soon as it exceeds the cap. */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: number; buffer: Uint8Array }> {
  // Trust a declared oversize length and skip the download entirely.
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(
      "RESPONSE_TOO_LARGE",
      `Response body is ${declaredLength} bytes, which exceeds the ${maxBytes} byte limit`,
    );
  }

  if (!response.body) return { bytes: 0, buffer: new Uint8Array(0) };

  // undici types the stream loosely; the chunks are Uint8Array in practice.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError("RESPONSE_TOO_LARGE", `Response body exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: total, buffer };
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * Fetches a page under a single wall-clock budget covering every redirect hop
 * and the body read. Redirects are followed manually so each hop is re-checked
 * against the SSRF guard — a public URL that 302s to 169.254.169.254 must not
 * slip through, which is exactly what `redirect: "follow"` would allow.
 */
export async function fetchPage(rawUrl: string, options: FetchPageOptions): Promise<FetchedPage> {
  const requestedUrl = parseTargetUrl(rawUrl);
  const startedAt = Date.now();

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.timeoutMs);
  deadline.unref();

  const redirects: RedirectHop[] = [];
  let currentUrl = requestedUrl;

  try {
    for (let hop = 0; ; hop += 1) {
      const resolvedAddresses = await assertUrlIsFetchable(currentUrl, {
        allowPrivateAddresses: options.allowPrivateAddresses,
      });

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": options.userAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
          },
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new AppError(
            "UPSTREAM_TIMEOUT",
            `Timed out after ${options.timeoutMs}ms fetching ${currentUrl.toString()}`,
            { retryable: true, cause },
          );
        }
        throw new AppError(
          "UPSTREAM_UNREACHABLE",
          `Could not connect to ${currentUrl.host}: ${cause instanceof Error ? cause.message : "unknown error"}`,
          { retryable: true, cause },
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});

        if (!location) {
          // A redirect status with no target is a dead end, not a redirect.
          throw new AppError(
            "UPSTREAM_UNREACHABLE",
            `${currentUrl.toString()} returned ${response.status} without a Location header`,
          );
        }
        if (hop >= options.maxRedirects) {
          throw new AppError(
            "TOO_MANY_REDIRECTS",
            `Exceeded the ${options.maxRedirects} redirect limit while fetching ${requestedUrl.toString()}`,
          );
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new AppError(
            "UPSTREAM_UNREACHABLE",
            `${currentUrl.toString()} redirected to an invalid location (${location})`,
          );
        }
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          throw new AppError(
            "BLOCKED_URL",
            `Refusing to follow a redirect to a non-http(s) URL (${nextUrl.protocol.replace(":", "")})`,
          );
        }
        nextUrl.hash = "";

        redirects.push({
          from: currentUrl.toString(),
          to: nextUrl.toString(),
          status: response.status,
        });
        currentUrl = nextUrl;
        continue;
      }

      const contentType = response.headers.get("content-type");
      if (!isHtmlLike(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(
          "UNSUPPORTED_CONTENT_TYPE",
          `Expected an HTML document but ${currentUrl.toString()} returned ${contentType ?? "no content type"}`,
        );
      }

      let bytes: number;
      let buffer: Uint8Array;
      try {
        ({ bytes, buffer } = await readBodyWithLimit(response, options.maxBodyBytes));
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new AppError(
            "UPSTREAM_TIMEOUT",
            `Timed out after ${options.timeoutMs}ms reading the response from ${currentUrl.toString()}`,
            { retryable: true, cause },
          );
        }
        throw cause;
      }

      const decoder = new TextDecoder(charsetFromContentType(contentType), { fatal: false });

      return {
        requestedUrl: requestedUrl.toString(),
        finalUrl: currentUrl.toString(),
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        redirects,
        body: decoder.decode(buffer),
        bytes,
        contentType,
        durationMs: Date.now() - startedAt,
        resolvedAddresses,
      };
    }
  } finally {
    clearTimeout(deadline);
  }
}
