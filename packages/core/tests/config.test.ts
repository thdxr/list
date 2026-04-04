import { ConfigProvider, Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { AppConfig } from "../src/config.ts";

describe("AppConfig", () => {
  it.effect("uses defaults when env vars are missing", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;

      expect(config.OPENTUNNEL_DOMAIN).toBe("opentunnel.xyz");
      expect(config.ACME_URL).toBe("https://acme-staging-v02.api.letsencrypt.org/directory");
    }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
    ),
  );

  it.effect("reads config overrides from env", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;

      expect(config.OPENTUNNEL_DOMAIN).toBe("dev.example.test");
      expect(config.ACME_URL).toBe("https://acme.example.test/directory");
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            OPENTUNNEL_DOMAIN: "dev.example.test",
            ACME_URL: "https://acme.example.test/directory",
          },
        }),
      ),
    ),
  );
});
