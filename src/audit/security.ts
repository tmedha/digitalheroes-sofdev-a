import type { Check, SecuritySnapshot } from "./types.js";
import type { FetchedPage } from "../lib/fetch-page.js";

/**
 * Security-header checks. Each one reports what was observed rather than a
 * bare pass/fail, so the response is actionable without a second lookup.
 */

const TRACKED_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "server",
  "x-powered-by",
] as const;

/** Headers that leak stack details and serve no purpose to a browser. */
const FINGERPRINT_HEADERS = ["server", "x-powered-by", "x-aspnet-version"] as const;

export function snapshotSecurity(page: FetchedPage): SecuritySnapshot {
  const headers: Record<string, string | null> = {};
  for (const name of TRACKED_HEADERS) {
    headers[name] = page.headers[name] ?? null;
  }
  return {
    https: new URL(page.finalUrl).protocol === "https:",
    headers,
  };
}

export function runSecurityChecks(page: FetchedPage): Check[] {
  const headers = page.headers;
  const finalUrl = new URL(page.finalUrl);
  const isHttps = finalUrl.protocol === "https:";
  const checks: Check[] = [];

  checks.push({
    id: "security.https",
    category: "security",
    title: "Served over HTTPS",
    status: isHttps ? "pass" : "fail",
    detail: isHttps
      ? "The final URL is served over HTTPS."
      : "The final URL is served over plain HTTP, so traffic can be read and modified in transit.",
    value: finalUrl.protocol.replace(":", ""),
    weight: 3,
  });

  // HSTS only means anything on an HTTPS origin; browsers ignore it over HTTP.
  const hsts = headers["strict-transport-security"];
  if (isHttps) {
    const maxAge = Number(hsts?.match(/max-age\s*=\s*(\d+)/i)?.[1] ?? NaN);
    const hasUsefulMaxAge = Number.isFinite(maxAge) && maxAge >= 15_552_000; // 180 days
    checks.push({
      id: "security.hsts",
      category: "security",
      title: "Strict-Transport-Security",
      status: !hsts ? "fail" : hasUsefulMaxAge ? "pass" : "warn",
      detail: !hsts
        ? "No Strict-Transport-Security header, so a first visit over HTTP can be intercepted."
        : hasUsefulMaxAge
          ? `HSTS is enabled with max-age=${maxAge}.`
          : `HSTS max-age is ${Number.isFinite(maxAge) ? maxAge : "missing"}; at least 15552000 (180 days) is recommended.`,
      value: hsts ?? null,
      weight: 2,
    });
  }

  const csp = headers["content-security-policy"];
  const cspIsPermissive = Boolean(csp && /unsafe-inline|unsafe-eval/i.test(csp));
  checks.push({
    id: "security.csp",
    category: "security",
    title: "Content-Security-Policy",
    status: !csp ? "fail" : cspIsPermissive ? "warn" : "pass",
    detail: !csp
      ? "No Content-Security-Policy header; the page has no defence-in-depth against injected scripts."
      : cspIsPermissive
        ? "A Content-Security-Policy is set but allows 'unsafe-inline' or 'unsafe-eval', which weakens XSS protection."
        : "A Content-Security-Policy is set.",
    value: csp ?? null,
    weight: 3,
  });

  const xcto = headers["x-content-type-options"];
  checks.push({
    id: "security.x_content_type_options",
    category: "security",
    title: "X-Content-Type-Options",
    status: xcto?.toLowerCase().trim() === "nosniff" ? "pass" : "fail",
    detail:
      xcto?.toLowerCase().trim() === "nosniff"
        ? "MIME sniffing is disabled."
        : "X-Content-Type-Options is not set to 'nosniff', so browsers may guess content types.",
    value: xcto ?? null,
    weight: 1,
  });

  // A frame-ancestors directive supersedes X-Frame-Options in modern browsers.
  const xfo = headers["x-frame-options"];
  const cspFrameAncestors = csp ? /frame-ancestors/i.test(csp) : false;
  checks.push({
    id: "security.clickjacking",
    category: "security",
    title: "Clickjacking protection",
    status: xfo || cspFrameAncestors ? "pass" : "fail",
    detail:
      xfo || cspFrameAncestors
        ? `Framing is restricted via ${xfo ? `X-Frame-Options: ${xfo}` : "CSP frame-ancestors"}.`
        : "Neither X-Frame-Options nor a CSP frame-ancestors directive is set, so the page can be framed by any origin.",
    value: xfo ?? (cspFrameAncestors ? "csp:frame-ancestors" : null),
    weight: 2,
  });

  const referrerPolicy = headers["referrer-policy"];
  checks.push({
    id: "security.referrer_policy",
    category: "security",
    title: "Referrer-Policy",
    status: referrerPolicy ? "pass" : "warn",
    detail: referrerPolicy
      ? `Referrer-Policy is set to '${referrerPolicy}'.`
      : "No Referrer-Policy header; full URLs may leak to third-party origins.",
    value: referrerPolicy ?? null,
    weight: 1,
  });

  checks.push({
    id: "security.permissions_policy",
    category: "security",
    title: "Permissions-Policy",
    status: headers["permissions-policy"] ? "pass" : "warn",
    detail: headers["permissions-policy"]
      ? "Permissions-Policy restricts access to powerful browser features."
      : "No Permissions-Policy header; features such as camera and geolocation are not explicitly restricted.",
    value: headers["permissions-policy"] ?? null,
    weight: 1,
  });

  const disclosed = FINGERPRINT_HEADERS.filter((name) => Boolean(headers[name]));
  checks.push({
    id: "security.version_disclosure",
    category: "security",
    title: "Server version disclosure",
    status: disclosed.length === 0 ? "pass" : "warn",
    detail:
      disclosed.length === 0
        ? "No server or framework version headers are exposed."
        : `Technology headers are exposed: ${disclosed.map((name) => `${name}: ${headers[name]}`).join(", ")}.`,
    value: disclosed.length === 0 ? null : disclosed.join(", "),
    weight: 1,
  });

  checks.push({
    id: "security.compression",
    category: "performance",
    title: "Response compression",
    status: headers["content-encoding"] ? "pass" : "warn",
    detail: headers["content-encoding"]
      ? `Response is compressed with ${headers["content-encoding"]}.`
      : "Response is not compressed; enabling gzip or brotli would reduce transfer size.",
    value: headers["content-encoding"] ?? null,
    weight: 1,
  });

  return checks;
}
