import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import { Database } from "./database.ts";
import { CSR } from "./csr.ts";
import { ApiClient } from "@peculiar/acme-client";
import { AppConfig } from "./config.ts";

export namespace Certificate {
  export const ID = Schema.String.pipe(Schema.brand("RequestID"));
  export type ID = Schema.Schema.Type<typeof ID>;

  export const StateNone = Schema.Struct({
    type: Schema.Literal("none"),
  });

  export const StateIssuing = Schema.Struct({
    type: Schema.Literal("issuing"),
  });

  export const StateReady = Schema.Struct({
    type: Schema.Literal("ready"),
    certificate: Schema.String,
    chain: Schema.String,
    expiry: Schema.String,
  });

  export const StateFailed = Schema.Struct({
    type: Schema.Literal("failed"),
    reason: Schema.String,
  });

  export const StateExpired = Schema.Struct({
    type: Schema.Literal("expired"),
  });

  export const State = Schema.Union([
    StateNone,
    StateIssuing,
    StateReady,
    StateFailed,
    StateExpired,
  ]);
  export type State = Schema.Schema.Type<typeof State>;

  export const Info = Schema.Struct({
    id: ID,
    state: State,
  });
  export type Info = Schema.Schema.Type<typeof Info>;

  // Challenge storage for HTTP-01 validation
  const challengeStore = new Map<string, string>();

  export const getChallengeResponse = (token: string): string | undefined => {
    return challengeStore.get(token);
  };

  export class Service extends ServiceMap.Service<
    Service,
    {
      issue: (csr: CSR.Raw) => Effect.Effect<ID, CSR.ParseError | CSR.InvalidHostnameError>;
      get: (id: ID) => Effect.Effect<Option.Option<Info>>;
      getChallengeResponse: (token: string) => string | undefined;
    }
  >()("Certificate") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const config = yield* AppConfig;
      const email = `acme@${config.OPENTUNNEL_DOMAIN}`;

      const acmeKey = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
            "sign",
            "verify",
          ]),
        catch: (error) =>
          new Error(
            `Failed to generate account key: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });

      const client = yield* Effect.tryPromise({
        try: () => ApiClient.create(acmeKey, config.ACME_URL),
        catch: (error) =>
          new Error(
            `Failed to create ACME client: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });

      yield* Effect.tryPromise({
        try: () =>
          client.newAccount({
            contact: [`mailto:` + email],
            termsOfServiceAgreed: true,
          }),
        catch: (error) =>
          new Error(
            `Failed to create ACME account: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });

      // Main ACME flow
      const acme = (id: ID, csr: CSR.Raw, hostname: string) =>
        Effect.gen(function* () {
          yield* Effect.log("Starting ACME flow...");
          const order = yield* Effect.tryPromise({
            try: () =>
              client.newOrder({
                identifiers: [{ type: "dns", value: hostname }],
              }),
            catch: (error) =>
              new Error(
                `Failed to create order: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });
          yield* Effect.log("Created order", order.content);
          yield* Effect.sleep("5 seconds");
        }).pipe(
          Effect.catch(
            Effect.fn(function* (err) {
              yield* Effect.logError("ACME flow failed:", err);
              yield* db.certificate.update({
                id,
                state: { type: "failed", reason: err.message },
              });
            }),
          ),
        );

      return Service.of({
        issue: Effect.fn(function* (csr) {
          const parsed = yield* CSR.parse(csr);
          const id = ID.makeUnsafe(crypto.randomUUID());

          yield* db.certificate.update({
            id,
            state: { type: "issuing" },
          });
          yield* acme(id, parsed.raw, parsed.hostname).pipe(Effect.forkDetach);
          return id;
        }),
        get: Effect.fn(function* (id) {
          return yield* db.certificate.get(id);
        }),
        getChallengeResponse: (token: string) => challengeStore.get(token),
      });
    }),
  );
}
