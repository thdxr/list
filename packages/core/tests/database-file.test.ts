import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Option, Path } from "effect";
import { afterAll, beforeAll, describe, expect } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "./effect-test.ts";
import { Certificate } from "../src/certificate.ts";
import { CSR } from "../src/csr.ts";
import { Database } from "../src/database.ts";
import { Tunnel } from "../src/tunnel.ts";

let tempDir = "";
let previousXdgDataHome = process.env.XDG_DATA_HOME;
let databaseFile: typeof import("../src/database-file.ts").DatabaseFile;

const makeTunnelInfo = () => {
  const id = crypto.randomUUID();

  return new Tunnel.Info({
    id: Tunnel.ID.makeUnsafe(id),
    hostname: CSR.Hostname.makeUnsafe(`${id}.example.com`),
    state: "offline",
  });
};

const makeCertificateInfo = () => {
  const id = crypto.randomUUID();

  return new Certificate.Info({
    id: Certificate.ID.makeUnsafe(id),
    state: new Certificate.StateReady({
      type: "ready",
      certificate: "cert-pem",
      chain: "chain-pem",
      expiry: "2099-01-01T00:00:00.000Z",
    }),
  });
};

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opentunnel-core-"));
  process.env.XDG_DATA_HOME = tempDir;
  ({ DatabaseFile: databaseFile } = await import("../src/database-file.ts"));
});

afterAll(async () => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const DatabaseFileLive = () =>
  Layer.provide(databaseFile.layer, Layer.mergeAll(Path.layer, NodeFileSystem.layer));

describe("DatabaseFile", () => {
  it.live("tunnel.get decodes persisted JSON after reading it from disk", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const info = makeTunnelInfo();

      yield* db.tunnel.update(info);

      const loaded = yield* db.tunnel.get(info.id);
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isNone(loaded)) {
        throw new Error("expected tunnel to be present");
      }

      expect(loaded.value.hostname).toBe(info.hostname);
    }).pipe(Effect.provide(DatabaseFileLive())),
  );

  it.live("certificate.get round-trips persisted certificate JSON", () =>
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
      if (loaded.value.state.type !== "ready") {
        throw new Error(`expected ready state, got ${loaded.value.state.type}`);
      }

      expect(loaded.value.state.certificate).toBe("cert-pem");
    }).pipe(Effect.provide(DatabaseFileLive())),
  );

  it.live("certificate.get returns none for a missing file", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const loaded = yield* db.certificate.get(Certificate.ID.makeUnsafe(crypto.randomUUID()));

      expect(Option.isNone(loaded)).toBe(true);
    }).pipe(Effect.provide(DatabaseFileLive())),
  );

  it.live("tunnel.setToken persists token lookups to disk", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const info = makeTunnelInfo();
      const token = Tunnel.Token.makeUnsafe(`token-${crypto.randomUUID()}`);

      yield* db.tunnel.update(info);
      yield* db.tunnel.setToken(token, info.id);

      const loaded = yield* db.tunnel.fromToken(token);
      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isNone(loaded)) {
        throw new Error("expected token lookup to exist");
      }

      expect(loaded.value).toBe(info.id);
    }).pipe(Effect.provide(DatabaseFileLive())),
  );

  it.live("tunnel.fromToken returns none for a missing token file", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const loaded = yield* db.tunnel.fromToken(
        Tunnel.Token.makeUnsafe(`token-${crypto.randomUUID()}`),
      );

      expect(Option.isNone(loaded)).toBe(true);
    }).pipe(Effect.provide(DatabaseFileLive())),
  );

  it.live("tunnel.get wraps missing files in a DatabaseError", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const error = yield* Effect.flip(db.tunnel.get(Tunnel.ID.makeUnsafe(crypto.randomUUID())));

      expect(error._tag).toBe("DatabaseError");
      expect(error.message.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(DatabaseFileLive())),
  );
});
