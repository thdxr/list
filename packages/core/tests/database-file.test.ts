import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Option, Path, pipe } from "effect";
import { afterAll, beforeAll, describe, expect } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "./effect-test.ts";
import { CSR } from "../src/csr.ts";
import { Database } from "../src/database.ts";
import { Tunnel } from "../src/tunnel.ts";

let tempDir = "";
let previousXdgDataHome = process.env.XDG_DATA_HOME;
let databaseFile: typeof import("../src/database-file.ts").DatabaseFile;

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
  pipe(databaseFile.layer, Layer.provide(Path.layer), Layer.provide(NodeFileSystem.layer));

describe("DatabaseFile", () => {
  it.live("tunnel.get decodes persisted JSON after reading it from disk", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service;

      const info = new Tunnel.Info({
        id: Tunnel.ID.makeUnsafe("test-tunnel-id"),
        hostname: CSR.Hostname.makeUnsafe("test.example.com"),
        state: "offline",
      });

      yield* db.tunnel.update(info);

      const loaded = yield* db.tunnel.get(info.id);

      expect(Option.isSome(loaded)).toBe(true);
      if (Option.isNone(loaded)) {
        throw new Error("expected tunnel to be present");
      }

      expect(loaded.value.hostname).toBe("test.example.com");
    }).pipe(Effect.provide(DatabaseFileLive())),
  );
});
