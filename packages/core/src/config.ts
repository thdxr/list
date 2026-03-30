import { Config } from "effect";

export const AppConfig = Config.all({
  OPENTUNNEL_DOMAIN: Config.string("OPENTUNNEL_DOMAIN").pipe(Config.withDefault("opentunnel.xyz")),
  ACME_URL: Config.string("ACME_URL").pipe(
    Config.withDefault("https://acme-staging-v02.api.letsencrypt.org/directory"),
  ),
});
