import { describe, expect, it } from "vitest";
import { scoreChecks } from "../../src/audit/index.js";
import { extractMetadata } from "../../src/audit/metadata.js";
import { runSecurityChecks } from "../../src/audit/security.js";
import { runSeoChecks } from "../../src/audit/seo.js";
import type { Check } from "../../src/audit/types.js";
import type { FetchedPage } from "../../src/lib/fetch-page.js";

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    headers: {},
    redirects: [],
    body: "<html></html>",
    bytes: 1000,
    contentType: "text/html",
    durationMs: 100,
    resolvedAddresses: ["93.184.216.34"],
    ...overrides,
  };
}

const findCheck = (checks: Check[], id: string): Check => {
  const check = checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`no check with id ${id}`);
  return check;
};

describe("extractMetadata", () => {
  it("pulls the full set of metadata out of a well-formed document", () => {
    const metadata = extractMetadata(
      `<!doctype html>
       <html lang="en-GB">
       <head>
         <meta charset="UTF-8">
         <title>  Spaced   title  </title>
         <meta name="description" content="A description.">
         <meta name="viewport" content="width=device-width">
         <meta name="robots" content="index, follow">
         <link rel="canonical" href="/canonical-path">
         <link rel="icon" href="/favicon.ico">
         <meta property="og:title" content="OG title">
         <meta name="twitter:card" content="summary">
         <script type="application/ld+json">{"@type":"Article"}</script>
       </head>
       <body>
         <h1>Only heading</h1><h2>Sub</h2><h2>Sub two</h2>
         <img src="a.png" alt="described">
         <img src="b.png" alt="">
         <img src="c.png">
         <a href="/internal">in</a>
         <a href="https://other.example/out" rel="nofollow">out</a>
         <a href="mailto:hi@example.com">mail</a>
         <p>one two three four five</p>
         <script>var ignored = "not counted as words";</script>
       </body></html>`,
      "https://example.com/page",
    );

    expect(metadata.title).toBe("Spaced title");
    expect(metadata.lang).toBe("en-GB");
    expect(metadata.charset).toBe("utf-8");
    expect(metadata.description).toBe("A description.");
    expect(metadata.viewport).toBe("width=device-width");
    expect(metadata.robots).toBe("index, follow");
    // Relative canonical and icon hrefs are resolved against the final URL.
    expect(metadata.canonical).toBe("https://example.com/canonical-path");
    expect(metadata.favicon).toBe("https://example.com/favicon.ico");
    expect(metadata.openGraph["og:title"]).toBe("OG title");
    expect(metadata.twitter["twitter:card"]).toBe("summary");
    expect(metadata.structuredDataTypes).toEqual(["Article"]);
    expect(metadata.h1s).toEqual(["Only heading"]);
    expect(metadata.headingCounts["h2"]).toBe(2);
    // An explicit empty alt is correct markup for a decorative image, so only
    // the image with no alt attribute at all counts as missing.
    expect(metadata.images).toEqual({ total: 3, missingAlt: 1 });
    expect(metadata.links).toEqual({ total: 3, internal: 1, external: 1, nofollow: 1 });
    // "Only heading" + "Sub" + "Sub two" + "in" + "out" + "mail" + the 5-word
    // paragraph; the script contents are excluded.
    expect(metadata.wordCount).toBe(13);
  });

  it("reports absent metadata as null rather than throwing", () => {
    const metadata = extractMetadata("<html><body><p>Nothing here</p></body></html>", "https://example.com/");
    expect(metadata.title).toBeNull();
    expect(metadata.description).toBeNull();
    expect(metadata.canonical).toBeNull();
    expect(metadata.lang).toBeNull();
    expect(metadata.h1s).toEqual([]);
    expect(metadata.structuredDataTypes).toEqual([]);
  });

  it("survives malformed markup and malformed JSON-LD", () => {
    const metadata = extractMetadata(
      `<html><head><title>Broken<title><script type="application/ld+json">{not valid json</script></head>
       <body><p>text<div></body>`,
      "https://example.com/",
    );
    expect(metadata.structuredDataTypes).toEqual([]);
    expect(metadata.title).toContain("Broken");
  });

  it("reads @type out of a JSON-LD @graph", () => {
    const metadata = extractMetadata(
      `<html><head><script type="application/ld+json">
       {"@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script></head><body></body></html>`,
      "https://example.com/",
    );
    expect(metadata.structuredDataTypes).toEqual(["Organization", "WebSite", "Thing"]);
  });

  it("reads charset from an http-equiv content-type declaration", () => {
    const metadata = extractMetadata(
      `<html><head><meta http-equiv="content-type" content="text/html; charset=iso-8859-1"></head><body></body></html>`,
      "https://example.com/",
    );
    expect(metadata.charset).toBe("iso-8859-1");
  });
});

describe("security checks", () => {
  it("passes a fully hardened response", () => {
    const checks = runSecurityChecks(
      page({
        headers: {
          "strict-transport-security": "max-age=31536000",
          "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=()",
          "content-encoding": "br",
        },
      }),
    );
    expect(checks.filter((check) => check.status !== "pass")).toEqual([]);
  });

  it("fails the headers that are absent", () => {
    const checks = runSecurityChecks(page());
    expect(findCheck(checks, "security.csp").status).toBe("fail");
    expect(findCheck(checks, "security.hsts").status).toBe("fail");
    expect(findCheck(checks, "security.x_content_type_options").status).toBe("fail");
    expect(findCheck(checks, "security.clickjacking").status).toBe("fail");
  });

  it("fails a page served over plain HTTP", () => {
    const checks = runSecurityChecks(page({ finalUrl: "http://example.com/" }));
    expect(findCheck(checks, "security.https").status).toBe("fail");
  });

  it("does not penalise a missing HSTS header on an HTTP origin", () => {
    // Browsers ignore HSTS over HTTP, so demanding it there would be noise.
    const checks = runSecurityChecks(page({ finalUrl: "http://example.com/" }));
    expect(checks.find((check) => check.id === "security.hsts")).toBeUndefined();
  });

  it("warns on an HSTS max-age that is too short to matter", () => {
    const checks = runSecurityChecks(page({ headers: { "strict-transport-security": "max-age=600" } }));
    expect(findCheck(checks, "security.hsts").status).toBe("warn");
  });

  it("warns rather than passes when a CSP allows unsafe-inline", () => {
    const checks = runSecurityChecks(
      page({ headers: { "content-security-policy": "default-src 'self' 'unsafe-inline'" } }),
    );
    expect(findCheck(checks, "security.csp").status).toBe("warn");
  });

  it("accepts CSP frame-ancestors in place of X-Frame-Options", () => {
    const checks = runSecurityChecks(
      page({ headers: { "content-security-policy": "frame-ancestors 'none'" } }),
    );
    expect(findCheck(checks, "security.clickjacking").status).toBe("pass");
  });

  it("warns when server technology headers are exposed", () => {
    const checks = runSecurityChecks(
      page({ headers: { server: "nginx/1.18.0", "x-powered-by": "Express" } }),
    );
    const check = findCheck(checks, "security.version_disclosure");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("nginx/1.18.0");
  });
});

describe("SEO checks", () => {
  const metadataFor = (html: string) => extractMetadata(html, "https://example.com/");

  it("flags a missing title, description and h1", () => {
    const checks = runSeoChecks(page(), metadataFor("<html><body><p>x</p></body></html>"));
    expect(findCheck(checks, "seo.title").status).toBe("fail");
    expect(findCheck(checks, "seo.meta_description").status).toBe("fail");
    expect(findCheck(checks, "seo.h1").status).toBe("fail");
    expect(findCheck(checks, "meta.viewport").status).toBe("fail");
  });

  it("warns on an over-long title", () => {
    const html = `<html><head><title>${"a".repeat(90)}</title></head><body></body></html>`;
    const check = findCheck(runSeoChecks(page(), metadataFor(html)), "seo.title");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("truncated");
  });

  it("warns when there are multiple h1 elements", () => {
    const html = "<html><body><h1>One</h1><h1>Two</h1></body></html>";
    expect(findCheck(runSeoChecks(page(), metadataFor(html)), "seo.h1").status).toBe("warn");
  });

  it("fails a noindex page, because it will not appear in search results at all", () => {
    const html = `<html><head><meta name="robots" content="noindex"></head><body></body></html>`;
    expect(findCheck(runSeoChecks(page(), metadataFor(html)), "seo.robots").status).toBe("fail");
  });

  it("fails a 5xx response and passes a 200", () => {
    const metadata = metadataFor("<html></html>");
    expect(findCheck(runSeoChecks(page({ status: 500 }), metadata), "fetch.status").status).toBe("fail");
    expect(findCheck(runSeoChecks(page({ status: 200 }), metadata), "fetch.status").status).toBe("pass");
  });

  it("only reports a redirect check when redirects happened", () => {
    const metadata = metadataFor("<html></html>");
    expect(runSeoChecks(page(), metadata).find((check) => check.id === "fetch.redirects")).toBeUndefined();

    const withRedirects = runSeoChecks(
      page({
        redirects: [
          { from: "a", to: "b", status: 301 },
          { from: "b", to: "c", status: 302 },
        ],
      }),
      metadata,
    );
    expect(findCheck(withRedirects, "fetch.redirects").status).toBe("fail");
  });

  it("scales the alt-text verdict with how many images are affected", () => {
    const oneMissingOfMany = metadataFor(
      `<html><body>${'<img src="x" alt="described">'.repeat(9)}<img src="y"></body></html>`,
    );
    expect(findCheck(runSeoChecks(page(), oneMissingOfMany), "a11y.image_alt").status).toBe("warn");

    const mostMissing = metadataFor(`<html><body>${'<img src="x">'.repeat(4)}</body></html>`);
    expect(findCheck(runSeoChecks(page(), mostMissing), "a11y.image_alt").status).toBe("fail");
  });

  it("passes the alt check when a page has no images at all", () => {
    expect(
      findCheck(runSeoChecks(page(), metadataFor("<html><body></body></html>")), "a11y.image_alt").status,
    ).toBe("pass");
  });

  it("grades response time and document size against thresholds", () => {
    const metadata = metadataFor("<html></html>");
    expect(findCheck(runSeoChecks(page({ durationMs: 200 }), metadata), "perf.ttfb").status).toBe("pass");
    expect(findCheck(runSeoChecks(page({ durationMs: 1_200 }), metadata), "perf.ttfb").status).toBe("warn");
    expect(findCheck(runSeoChecks(page({ durationMs: 4_000 }), metadata), "perf.ttfb").status).toBe("fail");
    expect(findCheck(runSeoChecks(page({ bytes: 900_000 }), metadata), "perf.page_weight").status).toBe(
      "fail",
    );
  });
});

describe("scoreChecks", () => {
  const check = (status: Check["status"], weight: number, category: Check["category"] = "seo"): Check => ({
    id: `check.${Math.random()}`,
    category,
    title: "t",
    status,
    detail: "d",
    weight,
  });

  it("awards 100 when everything passes", () => {
    const summary = scoreChecks([check("pass", 3), check("pass", 1)]);
    expect(summary.score).toBe(100);
    expect(summary.grade).toBe("A");
    expect(summary.passed).toBe(2);
  });

  it("awards 0 when everything fails", () => {
    const summary = scoreChecks([check("fail", 3), check("fail", 1)]);
    expect(summary.score).toBe(0);
    expect(summary.grade).toBe("F");
  });

  it("gives a warning half credit", () => {
    expect(scoreChecks([check("warn", 1)]).score).toBe(50);
  });

  it("weights heavier checks more", () => {
    // One weight-3 failure against one weight-1 pass: 1/4 of the credit.
    expect(scoreChecks([check("fail", 3), check("pass", 1)]).score).toBe(25);
  });

  it("scores each category independently", () => {
    const summary = scoreChecks([
      check("pass", 1, "security"),
      check("fail", 1, "seo"),
      check("fail", 1, "seo"),
    ]);
    const security = summary.categories.find((category) => category.category === "security");
    const seo = summary.categories.find((category) => category.category === "seo");

    expect(security?.score).toBe(100);
    expect(seo?.score).toBe(0);
    expect(seo?.failed).toBe(2);
  });

  it.each([
    [["pass", "pass", "pass", "pass", "pass"], "A"],
    [["pass", "pass", "pass", "warn", "warn"], "B"],
    [["pass", "pass", "pass", "warn", "fail"], "C"],
    [["pass", "pass", "pass", "fail", "fail"], "D"],
    [["pass", "fail", "fail", "fail", "fail"], "F"],
  ] as Array<[Check["status"][], string]>)("maps scores onto grades (%s -> %s)", (statuses, grade) => {
    expect(scoreChecks(statuses.map((status) => check(status, 1))).grade).toBe(grade);
  });
});
