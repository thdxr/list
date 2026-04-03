import { Effect, Layer, ServiceMap, Option, HashMap, Schema } from "effect";
import type { Tunnel } from "./tunnel.ts";
import type { Certificate } from "./certificate.ts";

export namespace Database {
  export class Error extends Schema.TaggedErrorClass<Error>()("DatabaseError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  export class Service extends ServiceMap.Service<
    Service,
    {
      tunnel: {
        update: (info: Tunnel.Info) => Effect.Effect<Tunnel.Info, Database.Error>;
        get: (id: Tunnel.ID) => Effect.Effect<Option.Option<Tunnel.Info>, Database.Error>;
        setToken: (token: Tunnel.Token, tunnel: Tunnel.ID) => Effect.Effect<void, Database.Error>;
        fromToken: (token: Tunnel.Token) => Effect.Effect<Option.Option<Tunnel.ID>, Database.Error>;
      };
      certificate: {
        update: (info: Certificate.Info) => Effect.Effect<Certificate.Info, Database.Error>;
        get: (id: Certificate.ID) => Effect.Effect<Option.Option<Certificate.Info>, Database.Error>;
      };
    }
  >()("Database") {}

  export const Memory = Layer.sync(Service, () => {
    let tokens = HashMap.empty<Tunnel.Token, Tunnel.ID>();
    let tunnels = HashMap.empty<Tunnel.ID, Tunnel.Info>();
    let certificates = HashMap.empty<Certificate.ID, Certificate.Info>();

    return Service.of({
      certificate: {
        update: Effect.fn("Database.certificate.update")((info: Certificate.Info) =>
          Effect.sync(() => {
            certificates = HashMap.set(certificates, info.id, info);
            return info;
          }),
        ),
        get: Effect.fn("Database.certificate.get")((id: Certificate.ID) =>
          Effect.sync(() => HashMap.get(certificates, id)),
        ),
      },
      tunnel: {
        get: Effect.fn("Database.tunnel.get")((id: Tunnel.ID) =>
          Effect.sync(() => HashMap.get(tunnels, id)),
        ),
        update: Effect.fn("Database.tunnel.update")((info: Tunnel.Info) =>
          Effect.sync(() => {
            tunnels = HashMap.set(tunnels, info.id, info);
            return info;
          }),
        ),
        setToken: Effect.fn("Database.tunnel.setToken")((token: Tunnel.Token, tunnel: Tunnel.ID) =>
          Effect.sync(() => {
            tokens = HashMap.set(tokens, token, tunnel);
          }),
        ),
        fromToken: Effect.fn("Database.tunnel.fromToken")((token: Tunnel.Token) =>
          Effect.sync(() => HashMap.get(tokens, token)),
        ),
      },
    });
  });
}
