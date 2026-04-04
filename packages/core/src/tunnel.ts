import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { Database } from "./database.ts";
import { AppConfig } from "./config.ts";
import { CSR } from "./csr.ts";
import { Certificate } from "./certificate.ts";

export namespace Tunnel {
  export const ID = Schema.String.pipe(Schema.brand("TunnelID"));
  export type ID = Schema.Schema.Type<typeof ID>;

  export const Token = Schema.String.pipe(Schema.brand("TunnelToken"));
  export type Token = Schema.Schema.Type<typeof Token>;

  export class NotFoundError extends Schema.TaggedErrorClass()("NotFound", {
    tunnelID: ID,
  }) {}

  export class NoCertificateError extends Schema.TaggedErrorClass()("NoCertificate", {
    tunnelID: ID,
  }) {}

  export class CertificateNotReadyError extends Schema.TaggedErrorClass()("CertificateNotReady", {
    tunnelID: ID,
    currentState: Schema.String,
  }) {}

  export class InvalidHostnameError extends Schema.TaggedErrorClass()("InvalidHostname", {
    provided: CSR.Hostname,
    expected: CSR.Hostname,
  }) {}

  export const State = Schema.Literals(["offline", "online"]);
  export type State = Schema.Schema.Type<typeof State>;

  export class Info extends Schema.Class<Info>("Tunnel/Info")({
    id: ID,
    hostname: CSR.Hostname,
    state: State,
    certificateID: Certificate.ID.pipe(Schema.optional),
  }) {}

  export class Service extends ServiceMap.Service<
    Service,
    {
      create: () => Effect.Effect<{
        tunnel: Tunnel.Info;
        token: Token;
      }>;
      fromID: (id: Tunnel.ID) => Effect.Effect<Tunnel.Info, NotFoundError>;
      certficiate: (
        id: Tunnel.ID,
      ) => Effect.Effect<Certificate.Info, NotFoundError | NoCertificateError>;
      auth: (tunnel: Tunnel.ID, token: Token) => Effect.Effect<boolean>;
      bind: (
        tunnel: Tunnel.ID,
        csr: CSR.Info,
      ) => Effect.Effect<void, InvalidHostnameError | NotFoundError>;
    }
  >()("Tunnel") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const config = yield* AppConfig;
      const certificate = yield* Certificate.Service;

      const fromID = Effect.fn("Tunnel.fromID")(function* (id) {
        const match = yield* db.tunnel.get(id).pipe(Effect.orDie);
        if (Option.isNone(match)) {
          return yield* new NotFoundError({ tunnelID: id });
        }
        return match.value;
      });

      return Service.of({
        fromID,
        certficiate: Effect.fn("Tunnel.certificate")(function* (id) {
          const info = yield* fromID(id);
          if (!info.certificateID) {
            return yield* new NoCertificateError({ tunnelID: id });
          }
          const cert = yield* certificate.get(info.certificateID);
          if (Option.isNone(cert)) {
            return yield* new NoCertificateError({ tunnelID: id });
          }
          return cert.value;
        }),
        create: Effect.fn("Tunnel.create")(function* () {
          const id = ID.makeUnsafe(crypto.randomUUID());
          const token = Token.makeUnsafe(crypto.randomUUID());
          const info = new Tunnel.Info({
            id,
            hostname: CSR.Hostname.makeUnsafe(
              // `${id}.${config.OPENTUNNEL_DOMAIN}`,
              config.OPENTUNNEL_DOMAIN,
            ),
            state: "offline",
          });
          yield* db.tunnel.update(info).pipe(Effect.orDie);
          yield* db.tunnel.setToken(token, id).pipe(Effect.orDie);
          return { tunnel: info, token };
        }),
        auth: Effect.fn("Tunnel.auth")(function* (tunnel, token) {
          const id = yield* db.tunnel.fromToken(token).pipe(Effect.orDie);
          return Option.exists(id, (val) => val === tunnel);
        }),
        bind: Effect.fn("Tunnel.bind")(function* (tunnelID, csr) {
          const info = yield* fromID(tunnelID);

          if (csr.hostname !== info.hostname)
            return yield* new InvalidHostnameError({
              provided: csr.hostname,
              expected: info.hostname,
            });

          const id = yield* certificate.issue(csr);

          yield* db.tunnel
            .update(
              new Tunnel.Info({
                id: info.id,
                hostname: info.hostname,
                state: info.state,
                certificateID: id,
              }),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
