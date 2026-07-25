import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real origin server on loopback. Tests exercise the actual network path —
 * sockets, redirects, chunked bodies, timeouts — rather than a mocked `fetch`,
 * so the fetch layer's timeout and size handling is genuinely covered.
 */

export interface FixtureServer {
  origin: string;
  url: (path: string) => string;
  /** Number of times each path has been requested; proves cache hits skip the network. */
  hits: Map<string, number>;
  close: () => Promise<void>;
}

const WELL_OPTIMISED_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hand-made ceramic mugs from a small studio</title>
  <meta name="description" content="We make small-batch stoneware mugs, glazed and fired by hand in a studio in Devon, and ship them anywhere in the UK within two working days.">
  <link rel="canonical" href="https://example.com/mugs">
  <link rel="icon" href="/favicon.ico">
  <meta property="og:title" content="Hand-made ceramic mugs">
  <meta property="og:description" content="Small-batch stoneware mugs.">
  <meta property="og:image" content="https://example.com/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Stoneware mug"}
  </script>
</head>
<body>
  <h1>Hand-made ceramic mugs</h1>
  <img src="/mug-1.jpg" alt="A speckled stoneware mug">
  <img src="/decorative.svg" alt="">
  <a href="/about">About the studio</a>
  <a href="https://example.org/press" rel="nofollow">Press coverage</a>
  <p>${"Every mug is thrown on the wheel and glazed by hand in small batches. ".repeat(30)}</p>
</body>
</html>`;

const BARE_PAGE = `<!doctype html>
<html>
<head><title>Hi</title></head>
<body><img src="/a.png"><img src="/b.png"><p>Short.</p></body>
</html>`;

const SECURE_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), geolocation=()",
};

function html(
  response: ServerResponse,
  body: string,
  extraHeaders: Record<string, string> = {},
  status = 200,
): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...extraHeaders });
  response.end(body);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hits = new Map<string, number>();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);

    switch (path) {
      // A page that should score well on nearly every check.
      case "/good":
        return html(response, WELL_OPTIMISED_PAGE, SECURE_HEADERS);

      // No security headers, no metadata, thin content, missing alt text.
      case "/bare":
        return html(response, BARE_PAGE);

      case "/noindex":
        return html(
          response,
          `<!doctype html><html lang="en"><head><title>Staging copy of the site</title>
           <meta name="robots" content="noindex, nofollow"></head><body><h1>Staging</h1></body></html>`,
        );

      case "/server-error":
        return html(
          response,
          `<!doctype html><html><head><title>Error</title></head><body><h1>Oops</h1></body></html>`,
          {},
          500,
        );

      // Redirect chain: /redirect/3 -> /redirect/2 -> /redirect/1 -> /good
      case "/redirect/3":
      case "/redirect/2":
      case "/redirect/1": {
        const remaining = Number(path.split("/")[2]);
        const target = remaining > 1 ? `/redirect/${remaining - 1}` : "/good";
        response.writeHead(302, { location: target });
        return response.end();
      }

      case "/redirect-loop":
        response.writeHead(302, { location: "/redirect-loop" });
        return response.end();

      case "/redirect-no-location":
        response.writeHead(301);
        return response.end();

      // Used to prove each redirect hop is re-validated, not just the first.
      case "/redirect-to-file":
        response.writeHead(302, { location: "file:///etc/passwd" });
        return response.end();

      case "/redirect-relative":
        response.writeHead(301, { location: "good" });
        return response.end();

      case "/json":
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ not: "html" }));

      case "/no-content-type":
        response.writeHead(200);
        return response.end("plain bytes with no declared type");

      // Declares an enormous body without sending one; the fetcher should
      // refuse based on content-length alone.
      case "/large-declared":
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": "999999999",
        });
        return response.end("<html></html>");

      // Streams past the limit without declaring a length.
      case "/large-streamed": {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        const chunk = "<p>" + "x".repeat(8_192) + "</p>";
        let sent = 0;
        const push = (): void => {
          while (sent < 4_000_000) {
            sent += chunk.length;
            if (!response.write(chunk)) {
              response.once("drain", push);
              return;
            }
          }
          response.end();
        };
        return push();
      }

      // Holds the connection open past any sane timeout.
      case "/slow": {
        const delayMs = Number(url.searchParams.get("ms") ?? 5_000);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.write("<html><head><title>Slow</title></head><body>");
        const timer = setTimeout(() => response.end("</body></html>"), delayMs);
        request.on("close", () => clearTimeout(timer));
        return;
      }

      // Unique content per request, so a stale cache hit is detectable.
      case "/counter": {
        const count = hits.get(path) ?? 0;
        return html(
          response,
          `<!doctype html><html lang="en"><head><title>Counter page number ${count}</title></head>
           <body><h1>Request ${count}</h1></body></html>`,
        );
      }

      case "/gzip":
        return html(response, BARE_PAGE, { "content-encoding": "gzip" });

      case "/leaky-headers":
        return html(response, BARE_PAGE, { server: "nginx/1.18.0", "x-powered-by": "Express" });

      default:
        return html(response, "<html><head><title>Not found</title></head><body>404</body></html>", {}, 404);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path: string) => `${origin}${path}`,
    hits,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    // Idle keep-alive sockets would otherwise hold the close open.
    server.closeIdleConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
