import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { Database } from "./database.ts";

export namespace Tunnel {
  export const ID = Schema.String.pipe(Schema.brand("TunnelID"));
  export type ID = Schema.Schema.Type<typeof ID>;

  export const Token = Schema.String.pipe(Schema.brand("TunnelToken"));
  export type Token = Schema.Schema.Type<typeof Token>;

  export const State = Schema.Literals([
    "pending",
    "provisioning",
    "offline",
    "online",
    "deleting",
  ]);
  export type State = Schema.Schema.Type<typeof State>;

  export const Info = Schema.Struct({
    id: ID,
    host: Schema.String,
    state: State,
  });
  export type Info = Schema.Schema.Type<typeof Info>;

  export class Service extends ServiceMap.Service<
    Service,
    {
      create: () => Effect.Effect<{
        tunnel: Tunnel.Info;
        token: Token;
      }>;
      auth: (tunnel: Tunnel.ID, token: Token) => Effect.Effect<boolean>;
    }
  >()("Tunnel") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Database.Service;

      return Service.of({
        create: Effect.fn(function* () {
          const id = ID.makeUnsafe(crypto.randomUUID());
          const info: Tunnel.Info = {
            id,
            host: `${id}.opentunnel.xyz`,
            state: "pending",
          };
          yield* db.tunnel.update(info);
          return { tunnel: info, token: Token.makeUnsafe("asd") };
        }),
        auth: Effect.fn(function* (tunnel, token) {
          const id = yield* db.tunnel.fromToken(token);
          return Option.exists(id, (val) => val === tunnel);
        }),
      });
    }),
  );
}
