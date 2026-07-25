import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { createServices, type Services } from "../../src/services.js";

/**
 * Boots the real application with test-specific configuration. Nothing is
 * mocked: routes, hooks, error handling and the fetch path are the production
 * ones. Requests go through `app.inject`, so no port is bound.
 */

/**
 * Loopback targets are allowed by default here because the fixture origin runs
 * on 127.0.0.1. Tests that assert SSRF blocking opt back into the guard.
 */
const TEST_DEFAULTS: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  ALLOW_PRIVATE_ADDRESSES: "true",
  RATE_LIMIT_MAX: "1000",
  RATE_LIMIT_WINDOW_MS: "60000",
  CACHE_TTL_MS: "60000",
  FETCH_TIMEOUT_MS: "3000",
  AUDIT_TIMEOUT_MS: "5000",
};

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  config: Config;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({ ...TEST_DEFAULTS, ...overrides });
  const services = createServices(config);
  const app = await buildServer({ config, services });
  await app.ready();

  return {
    app,
    services,
    config,
    close: async () => {
      await app.close();
      services.close();
    },
  };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...TEST_DEFAULTS, ...overrides });
}
