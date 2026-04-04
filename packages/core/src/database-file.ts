import { Layer, Effect, FileSystem, Schema, Option } from "effect";
import envPaths from "env-paths";
import { Certificate } from "./certificate.ts";
import { Database } from "./database.ts";
import { Tunnel } from "./tunnel.ts";

const paths = envPaths("opentunnel", { suffix: "" });

export namespace DatabaseFile {
  export const layer = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const dir = paths.data;

      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(key("tunnel"), { recursive: true });
      yield* fs.makeDirectory(key("certificate"), { recursive: true });
      yield* fs.makeDirectory(key("token"), { recursive: true });

      function key(...paths: string[]): string {
        return `${dir}/${paths.join("/")}`;
      }

      const decoder = {
        tunnel: Schema.decodeUnknownEffect(Schema.fromJsonString(Tunnel.Info)),
        certificate: Schema.decodeUnknownEffect(Schema.fromJsonString(Certificate.Info)),
        token: Schema.decodeUnknownEffect(Schema.fromJsonString(Tunnel.ID)),
      };

      return Database.Service.of({
        certificate: {
          update: Effect.fn("Database.File.certificate.update")(
            function* (info: Certificate.Info) {
              const filepath = key("certificate", `${info.id}.json`);
              const json = JSON.stringify(info, null, 2);
              yield* fs.writeFileString(filepath, json);
              return info;
            },
            Effect.mapError((err) => new Database.Error({ message: err.message, cause: err })),
          ),
          get: Effect.fn("Database.File.certificate.get")(function* (id: Certificate.ID) {
            const filepath = key("certificate", `${id}.json`);
            const match = yield* fs
              .readFileString(filepath)
              .pipe(Effect.flatMap(decoder.certificate), Effect.option);
            return match;
          }),
        },
        tunnel: {
          get: Effect.fn("Database.File.tunnel.get")(
            function* (id: Tunnel.ID) {
              const filepath = key("tunnel", `${id}.json`);
              const match = yield* fs.readFileString(filepath).pipe(Effect.flatMap(decoder.tunnel));
              return Option.some(match);
            },
            Effect.mapError((err) => new Database.Error({ message: err.message, cause: err })),
          ),
          update: Effect.fn("Database.File.tunnel.update")(
            function* (info: Tunnel.Info) {
              const filepath = key("tunnel", `${info.id}.json`);
              const json = JSON.stringify(info, null, 2);
              yield* fs.writeFileString(filepath, json);
              return info;
            },
            Effect.mapError((err) => new Database.Error({ message: err.message, cause: err })),
          ),
          setToken: Effect.fn("Database.File.tunnel.setToken")(
            function* (token: Tunnel.Token, tunnelID: Tunnel.ID) {
              const filepath = key("token", `${token}.json`);
              const json = JSON.stringify(tunnelID, null, 2);
              yield* fs.writeFileString(filepath, json);
            },
            Effect.mapError((err) => new Database.Error({ message: err.message, cause: err })),
          ),
          fromToken: Effect.fn("Database.File.tunnel.fromToken")(function* (token: Tunnel.Token) {
            const filepath = key("token", `${token}.json`);
            const match = yield* fs
              .readFileString(filepath)
              .pipe(Effect.flatMap(decoder.token), Effect.option);
            return match;
          }),
        },
      });
    }),
  );
}
