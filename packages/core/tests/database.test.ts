import { Effect, Option } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { Certificate } from "../src/certificate.ts";
import { CSR } from "../src/csr.ts";
import { Database } from "../src/database.ts";
import { Tunnel } from "../src/tunnel.ts";

const makeTunnelInfo = (id = crypto.randomUUID()) =>
  new Tunnel.Info({
    id: Tunnel.ID.makeUnsafe(id),
    hostname: CSR.Hostname.makeUnsafe(`${id}.example.com`),
    state: "offline",
  });

const makeCertificateInfo = (id = crypto.randomUUID()) =>
  new Certificate.Info({
    id: Certificate.ID.makeUnsafe(id),
    state: new Certificate.StateReady({
      type: "ready",
      certificate: "cert-pem",
      chain: "chain-pem",
      expiry: "2099-01-01T00:00:00.000Z",
    }),
  });

describe("Database.Memory", () => {
  it.effect("stores tunnels and token lookups in memory", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const info = makeTunnelInfo();
      const token = Tunnel.Token.makeUnsafe(`token-${crypto.randomUUID()}`);

      yield* db.tunnel.update(info);
      yield* db.tunnel.setToken(token, info.id);

      const loaded = yield* db.tunnel.get(info.id);
      const fromToken = yield* db.tunnel.fromToken(token);

      expect(Option.isSome(loaded)).toBe(true);
      expect(Option.isSome(fromToken)).toBe(true);
      if (Option.isNone(loaded) || Option.isNone(fromToken)) {
        throw new Error("expected tunnel data to be present");
      }

      expect(loaded.value.hostname).toBe(info.hostname);
      expect(fromToken.value).toBe(info.id);
    }).pipe(Effect.provide(Database.Memory)),
  );

  it.effect("returns none for missing tunnel and token entries", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;

      const tunnel = yield* db.tunnel.get(Tunnel.ID.makeUnsafe(crypto.randomUUID()));
      const token = yield* db.tunnel.fromToken(
        Tunnel.Token.makeUnsafe(`token-${crypto.randomUUID()}`),
      );

      expect(Option.isNone(tunnel)).toBe(true);
      expect(Option.isNone(token)).toBe(true);
    }).pipe(Effect.provide(Database.Memory)),
  );

  it.effect("stores certificates in memory", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const info = makeCertificateInfo();

      yield* db.certificate.update(info);

      const loaded = yield* db.certificate.get(info.id);

      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isNone(loaded)) {
        throw new Error("expected certificate to be present");
      }

      expect(loaded.value.state.type).toBe("ready");
    }).pipe(Effect.provide(Database.Memory)),
  );

  it.effect("returns none for missing certificates", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const loaded = yield* db.certificate.get(Certificate.ID.makeUnsafe(crypto.randomUUID()));

      expect(Option.isNone(loaded)).toBe(true);
    }).pipe(Effect.provide(Database.Memory)),
  );
});
