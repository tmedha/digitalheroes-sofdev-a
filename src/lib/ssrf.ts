import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "../errors.js";

/**
 * The service fetches URLs chosen by untrusted callers, which makes it a
 * server-side request forgery vector by default: `http://169.254.169.254/` or
 * `http://10.0.0.5:6379/` would let a caller reach cloud metadata and internal
 * services from inside our network.
 *
 * Every hop of every outbound request goes through `assertUrlIsFetchable`,
 * which requires a http(s) URL whose hostname resolves exclusively to public
 * unicast addresses.
 */

/** ipaddr.js range names that must never be reachable from user input. */
const BLOCKED_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal", // includes 169.254.169.254, the cloud metadata endpoint
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
]);

export interface UrlGuardOptions {
  /** Skip address classification. Only ever true for local test fixtures. */
  allowPrivateAddresses: boolean;
}

function blocked(message: string): AppError {
  return new AppError("BLOCKED_URL", message);
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  return !BLOCKED_RANGES.has(parsed.range());
}

/**
 * Parses and normalises user input into a URL we are willing to fetch.
 * Throws `VALIDATION_ERROR` for malformed input and `BLOCKED_URL` for
 * well-formed URLs pointing somewhere we refuse to go.
 */
export function parseTargetUrl(raw: string): URL {
  const trimmed = raw.trim();
  let url: URL;
  const malformed = (): AppError =>
    new AppError("VALIDATION_ERROR", "url must be a valid absolute URL", {
      details: [{ field: "url", message: `Could not parse ${JSON.stringify(raw)} as a URL` }],
    });

  try {
    url = new URL(trimmed);
  } catch {
    // A bare "example.com" is common and unambiguous, so upgrade it rather
    // than bouncing the caller for a missing scheme. Input that already
    // carries a scheme is not eligible: prefixing "https://" onto broken
    // input like "http://" would silently invent a different target.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) throw malformed();
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      throw malformed();
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw blocked(`Only http and https URLs can be audited (received ${url.protocol.replace(":", "")})`);
  }
  if (url.username || url.password) {
    throw blocked("URLs containing credentials are not accepted");
  }
  if (!url.hostname) {
    throw blocked("URL is missing a hostname");
  }

  // The fragment never reaches the origin server; dropping it also stops
  // `#a` and `#b` from occupying two cache entries for one fetch.
  url.hash = "";
  return url;
}

/**
 * Resolves the hostname and rejects the URL unless every address it maps to is
 * public. Returns the resolved addresses so callers can log what they hit.
 */
export async function assertUrlIsFetchable(url: URL, options: UrlGuardOptions): Promise<string[]> {
  if (options.allowPrivateAddresses) return [];

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) {
      throw blocked(`Refusing to fetch a non-public address (${hostname})`);
    }
    return [hostname];
  }

  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw blocked("Refusing to fetch localhost");
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (cause) {
    throw new AppError("UPSTREAM_UNREACHABLE", `DNS lookup failed for ${hostname}`, {
      retryable: true,
      cause,
    });
  }

  if (addresses.length === 0) {
    throw new AppError("UPSTREAM_UNREACHABLE", `DNS lookup returned no addresses for ${hostname}`, {
      retryable: true,
    });
  }

  // All-or-nothing: a hostname with even one private answer is rejected, so a
  // split-horizon record cannot smuggle us onto an internal address.
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw blocked(`Refusing to fetch ${hostname}: it resolves to a non-public address (${address})`);
    }
  }

  return addresses.map((entry) => entry.address);
}

/**
 * Cache key for a target URL. Host casing and the default port are normalised
 * so trivially different spellings of one address share a cache entry, but the
 * path and query are left untouched because they change what is served.
 */
export function cacheKeyForUrl(url: URL): string {
  const normalised = new URL(url.toString());
  normalised.hostname = normalised.hostname.toLowerCase();
  normalised.protocol = normalised.protocol.toLowerCase();
  if (
    (normalised.protocol === "http:" && normalised.port === "80") ||
    (normalised.protocol === "https:" && normalised.port === "443")
  ) {
    normalised.port = "";
  }
  if (normalised.pathname === "") normalised.pathname = "/";
  return normalised.toString();
}
