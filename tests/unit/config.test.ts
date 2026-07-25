import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

/**
 * Misconfiguration should stop the process at boot, not surface as strange
 * behaviour under load, so every invalid value is expected to throw.
 */
describe("loadConfig", () => {
  it("applies documented defaults when the environment is empty", () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3000);
    expect(config.CACHE_TTL_MS).toBe(300_000);
    expect(config.MAX_CONCURRENT_AUDITS).toBe(8);
    expect(config.RATE_LIMIT_MAX).toBe(30);
    expect(config.ALLOW_PRIVATE_ADDRESSES).toBe(false);
  });

  it("reads numeric overrides from strings", () => {
    const config = loadConfig({ PORT: "8080", CACHE_TTL_MS: "1000" });
    expect(config.PORT).toBe(8080);
    expect(config.CACHE_TTL_MS).toBe(1_000);
  });

  it.each(["1", "true", "TRUE", "yes", "on"])("reads %s as true", (value) => {
    expect(loadConfig({ ALLOW_PRIVATE_ADDRESSES: value }).ALLOW_PRIVATE_ADDRESSES).toBe(true);
  });

  it.each(["0", "false", "no", "anything-else"])("reads %s as false", (value) => {
    expect(loadConfig({ ALLOW_PRIVATE_ADDRESSES: value }).ALLOW_PRIVATE_ADDRESSES).toBe(false);
  });

  it("treats an empty string as unset rather than as zero", () => {
    expect(loadConfig({ PORT: "" }).PORT).toBe(3000);
  });

  it.each([
    ["a non-numeric port", { PORT: "not-a-number" }],
    ["a port out of range", { PORT: "70000" }],
    ["a fractional value", { CACHE_TTL_MS: "1.5" }],
    ["a negative value", { RATE_LIMIT_MAX: "-1" }],
    ["zero concurrency", { MAX_CONCURRENT_AUDITS: "0" }],
    ["an unknown log level", { LOG_LEVEL: "verbose" }],
    ["an unknown environment", { NODE_ENV: "staging" }],
  ])("rejects %s", (_label, env) => {
    expect(() => loadConfig(env)).toThrow(/Invalid environment configuration/);
  });

  it("rejects a fetch timeout larger than the overall audit budget", () => {
    expect(() => loadConfig({ FETCH_TIMEOUT_MS: "20000", AUDIT_TIMEOUT_MS: "5000" })).toThrow(
      /must not exceed/,
    );
  });

  it("names the offending variable in the error", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
  });
});
