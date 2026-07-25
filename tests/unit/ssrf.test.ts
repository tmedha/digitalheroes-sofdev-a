import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { assertUrlIsFetchable, cacheKeyForUrl, isPublicAddress, parseTargetUrl } from "../../src/lib/ssrf.js";

const guard = { allowPrivateAddresses: false };

describe("parseTargetUrl", () => {
  it("accepts http and https URLs", () => {
    expect(parseTargetUrl("https://example.com/page").toString()).toBe("https://example.com/page");
    expect(parseTargetUrl("http://example.com/").toString()).toBe("http://example.com/");
  });

  it("assumes https for a bare hostname", () => {
    expect(parseTargetUrl("example.com").toString()).toBe("https://example.com/");
  });

  it("trims surrounding whitespace", () => {
    expect(parseTargetUrl("  https://example.com/  ").toString()).toBe("https://example.com/");
  });

  it("strips the fragment, which never reaches the origin", () => {
    expect(parseTargetUrl("https://example.com/page#section").toString()).toBe("https://example.com/page");
  });

  it("preserves the query string, which does change what is served", () => {
    expect(parseTargetUrl("https://example.com/search?q=mugs&page=2").toString()).toBe(
      "https://example.com/search?q=mugs&page=2",
    );
  });

  it.each([
    ["file:///etc/passwd", "file"],
    ["ftp://example.com/x", "ftp"],
    ["gopher://example.com/", "gopher"],
    ["javascript:alert(1)", "javascript"],
    ["data:text/html,<script>alert(1)</script>", "data"],
  ])("rejects the non-http scheme in %s", (input) => {
    expect(() => parseTargetUrl(input)).toThrow(AppError);
    expect(() => parseTargetUrl(input)).toThrow(/Only http and https/);
  });

  it("rejects URLs carrying credentials", () => {
    expect(() => parseTargetUrl("https://user:pass@example.com/")).toThrow(/credentials/);
  });

  it("rejects input that is not a URL at all", () => {
    expect(() => parseTargetUrl("   ")).toThrow(AppError);
    expect(() => parseTargetUrl("http://")).toThrow(AppError);
  });
});

describe("isPublicAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "private class A"],
    ["172.16.4.2", "private class B"],
    ["192.168.1.1", "private class C"],
    ["169.254.169.254", "cloud metadata endpoint"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link local"],
  ])("rejects %s (%s)", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"], ["2606:4700:4700::1111"]])(
    "accepts the public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("assertUrlIsFetchable", () => {
  it.each([
    "http://127.0.0.1:8080/admin",
    "http://10.0.0.5:6379/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.0.1/",
    "http://[::1]:3000/",
  ])("blocks the internal target %s", async (input) => {
    await expect(assertUrlIsFetchable(parseTargetUrl(input), guard)).rejects.toMatchObject({
      code: "BLOCKED_URL",
      statusCode: 403,
    });
  });

  it("blocks localhost by name", async () => {
    await expect(assertUrlIsFetchable(parseTargetUrl("http://localhost:9000/"), guard)).rejects.toMatchObject(
      {
        code: "BLOCKED_URL",
      },
    );
    await expect(assertUrlIsFetchable(parseTargetUrl("http://api.localhost/"), guard)).rejects.toMatchObject({
      code: "BLOCKED_URL",
    });
  });

  it("skips the check entirely when private addresses are explicitly allowed", async () => {
    await expect(
      assertUrlIsFetchable(parseTargetUrl("http://127.0.0.1:8080/"), { allowPrivateAddresses: true }),
    ).resolves.toEqual([]);
  });

  it("reports an unresolvable hostname as unreachable rather than blocked", async () => {
    await expect(
      assertUrlIsFetchable(parseTargetUrl("https://this-domain-does-not-exist.invalid/"), guard),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNREACHABLE" });
  });
});

describe("cacheKeyForUrl", () => {
  it("treats host casing as insignificant", () => {
    expect(cacheKeyForUrl(parseTargetUrl("https://EXAMPLE.com/page"))).toBe(
      cacheKeyForUrl(parseTargetUrl("https://example.com/page")),
    );
  });

  it("treats the default port as insignificant", () => {
    expect(cacheKeyForUrl(parseTargetUrl("https://example.com:443/page"))).toBe(
      cacheKeyForUrl(parseTargetUrl("https://example.com/page")),
    );
    expect(cacheKeyForUrl(parseTargetUrl("http://example.com:80/"))).toBe(
      cacheKeyForUrl(parseTargetUrl("http://example.com/")),
    );
  });

  it("keeps a non-default port significant", () => {
    expect(cacheKeyForUrl(parseTargetUrl("https://example.com:8443/"))).not.toBe(
      cacheKeyForUrl(parseTargetUrl("https://example.com/")),
    );
  });

  it("keeps path, query and scheme significant", () => {
    const key = (input: string) => cacheKeyForUrl(parseTargetUrl(input));
    expect(key("https://example.com/a")).not.toBe(key("https://example.com/b"));
    expect(key("https://example.com/?a=1")).not.toBe(key("https://example.com/?a=2"));
    expect(key("http://example.com/")).not.toBe(key("https://example.com/"));
  });

  it("collapses fragments onto one entry", () => {
    const key = (input: string) => cacheKeyForUrl(parseTargetUrl(input));
    expect(key("https://example.com/p#one")).toBe(key("https://example.com/p#two"));
  });
});
