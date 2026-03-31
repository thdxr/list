import { Effect, HashMap, Layer, Option, Schedule, Schema, ServiceMap } from "effect";
import { Database } from "./database.ts";
import { CSR } from "./csr.ts";
import { ApiClient } from "@peculiar/acme-client";
import { JsonWebKey } from "@peculiar/jose";
import { AppConfig } from "./config.ts";

export namespace Certificate {
  export const ID = Schema.String.pipe(Schema.brand("RequestID"));
  export type ID = Schema.Schema.Type<typeof ID>;

  export const Token = Schema.String.pipe(Schema.brand("ChallengeToken"));
  export type Token = Schema.Schema.Type<typeof Token>;

  export const StateNone = Schema.Struct({
    type: Schema.Literal("none"),
  });

  export const StateChallenge = Schema.Struct({
    type: Schema.Literal("challenge"),
    token: Schema.String,
    key: Schema.String,
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
    StateChallenge,
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

  export class Service extends ServiceMap.Service<
    Service,
    {
      issue: (csr: CSR.Info) => Effect.Effect<ID>;
      fromToken: (token: Token) => Effect.Effect<Option.Option<Info>>;
      get: (id: ID) => Effect.Effect<Option.Option<Info>>;
    }
  >()("Certificate") {}

  // Convert PEM to Base64URL encoded string
  const pemToBase64Url = (pem: string): string => {
    const base64 = pem
      .replace(/-----BEGIN [^-]+-----/, "")
      .replace(/-----END [^-]+-----/, "")
      .replace(/\s/g, "");
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  // Compute JWK thumbprint using @peculiar/jose (returns hex, convert to base64url for ACME)
  const computeJwkThumbprint = (jwk: any): Effect.Effect<string, Error, never> =>
    Effect.tryPromise({
      try: async () => {
        const joseJwk = new JsonWebKey(crypto, jwk);
        const thumbprintHex = await joseJwk.getThumbprint();
        // Convert hex to base64url for ACME key authorization
        const bytes = thumbprintHex.match(/.{2}/g)!.map((b) => parseInt(b, 16));
        const base64 = btoa(String.fromCharCode(...bytes));
        return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      },
      catch: (e) => new Error(`Thumbprint failed: ${e}`),
    });

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Database.Service;
      const config = yield* AppConfig;
      const email = `acme@${config.OPENTUNNEL_DOMAIN}`;

      // Map to track challenge token -> certificate ID
      let tokenMap = HashMap.empty<Token, ID>();

      const clientAndKey = yield* Effect.gen(function* () {
        const key = yield* Effect.tryPromise({
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
          try: () =>
            ApiClient.create(key, config.ACME_URL, {
              fetch,
              crypto,
            }),
          catch: (error) =>
            new Error(
              `Failed to create ACME client: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });
        return { client, key };
      });

      const { client, key: accountKey } = clientAndKey;

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

      // Complete ACME flow with HTTP-01 validation
      const acme = (id: ID, csr: CSR.Info) =>
        Effect.gen(function* () {
          yield* Effect.log("Starting ACME flow...");

          // 1. Create order
          const order = yield* Effect.tryPromise({
            try: () =>
              client.newOrder({
                identifiers: [{ type: "dns", value: csr.hostname }],
              }),
            catch: (error) =>
              new Error(
                `Failed to create order: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });
          yield* Effect.log("Created order", order.content);

          // 2. Get authorization and challenge (single domain = single auth = single challenge)
          const auth = yield* Effect.tryPromise({
            try: () => client.getAuthorization(order.content.authorizations[0]),
            catch: (error) =>
              new Error(
                `Failed to get authorization: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });

          // Find HTTP-01 challenge
          const httpChallenge = auth.content.challenges?.find(
            (c: { type: string }) => c.type === "http-01",
          );
          if (!httpChallenge) return yield* Effect.fail(new Error("No HTTP-01 challenge found"));

          // Compute key authorization: token + "." + JWK thumbprint
          const jwk = yield* Effect.tryPromise({
            try: () => crypto.subtle.exportKey("jwk", accountKey.publicKey),
            catch: (error) =>
              new Error(
                `Failed to export account key: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });
          const thumbprint = yield* computeJwkThumbprint(jwk);
          const keyAuth = `${httpChallenge.token}.${thumbprint}`;

          // Store challenge in state and add token to map
          yield* db.certificate.update({
            id,
            state: {
              type: "challenge",
              token: httpChallenge.token,
              key: keyAuth,
            },
          });

          // Add token -> cert ID mapping
          tokenMap = HashMap.set(tokenMap, Token.makeUnsafe(httpChallenge.token), id);
          yield* Effect.log({
            token: httpChallenge.token,
          });

          // Trigger challenge validation
          const challengeResp = yield* Effect.tryPromise({
            try: () => client.getChallenge(httpChallenge.url, "POST"),
            catch: (error) =>
              new Error(
                `Failed to trigger challenge validation: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });

          yield* Effect.log("Challenge triggered, waiting for authorization to be valid...");

          // Extract 'up' link from response headers to get authorization URL
          const upLink = challengeResp.headers.link?.find((o: string) => o.includes('up"'));
          if (!upLink) {
            return yield* Effect.fail(new Error("Cannot get 'up' link from challenge response"));
          }
          const upUrlMatch = /<([^<>]+)>/.exec(upLink);
          if (!upUrlMatch?.[1]) {
            return yield* Effect.fail(new Error("Cannot parse authorization URL from up link"));
          }
          const upUrl = upUrlMatch[1];

          // Wait for authorization to be valid using Effect retry
          const validAuth = yield* Effect.retry(
            Effect.gen(function* () {
              const resp = yield* Effect.tryPromise({
                try: () => client.getAuthorization(upUrl),
                catch: (error) =>
                  new Error(
                    `Failed to get authorization: ${error instanceof Error ? error.message : String(error)}`,
                  ),
              });
              if (resp.content.status === "pending") {
                return yield* Effect.fail(new Error("Authorization still pending"));
              }
              return resp;
            }),
            Schedule.spaced("5 seconds"),
          );
          yield* Effect.log("Authorization status:", validAuth);

          if (validAuth.content.status !== "valid") {
            return yield* Effect.fail(
              new Error(`Authorization status is ${validAuth.content.status}, expected valid`),
            );
          }

          yield* Effect.log("Authorization valid, finalizing order...");

          // 4. Finalize order with CSR
          const csrBase64Url = pemToBase64Url(csr.raw);
          yield* Effect.tryPromise({
            try: () =>
              client.finalize(order.content.finalize!, {
                csr: csrBase64Url,
              }),
            catch: (error) =>
              new Error(
                `Failed to finalize order: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });

          yield* Effect.log("Finalized, waiting for certificate...");

          // 5. Wait for order to be valid (certificate issued) using Effect retry
          // Extract order URL from the Location header of newOrder response
          const orderUrl = order.headers.location;
          if (!orderUrl) {
            return yield* Effect.fail(new Error("Cannot get order URL from newOrder response"));
          }

          const validOrder = yield* Effect.retry(
            Effect.gen(function* () {
              const resp = yield* Effect.tryPromise({
                try: () => client.getOrder(orderUrl),
                catch: (error) =>
                  new Error(
                    `Failed to get order: ${error instanceof Error ? error.message : String(error)}`,
                  ),
              });
              if (resp.content.status === "processing") {
                return yield* Effect.fail(new Error("Order still processing"));
              }
              return resp;
            }),
            Schedule.spaced("3 seconds"),
          );
          yield* Effect.log("Order status:", validOrder);

          if (validOrder.content.status !== "valid") {
            return yield* Effect.fail(
              new Error(`Order status is ${validOrder.content.status}, expected valid`),
            );
          }

          // 6. Download certificate
          if (!validOrder.content.certificate) {
            return yield* Effect.fail(new Error("Order is valid but no certificate URL found"));
          }

          const certResponse = yield* Effect.tryPromise({
            try: () => client.getCertificate(validOrder.content.certificate!),
            catch: (error) =>
              new Error(
                `Failed to get certificate: ${error instanceof Error ? error.message : String(error)}`,
              ),
          });

          yield* Effect.log("Certificate downloaded");

          // Convert ArrayBuffer[] to PEM format
          const certChain = certResponse.content
            .map((buf: ArrayBuffer) => {
              const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
              return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----`;
            })
            .join("\n");

          // Store certificate (challenges will be replaced by ready state)
          // Remove token from map since challenge is complete
          tokenMap = HashMap.remove(tokenMap, Token.makeUnsafe(httpChallenge.token));

          // TODO: Parse certificate for expiry date
          yield* db.certificate.update({
            id,
            state: {
              type: "ready",
              certificate: certChain,
              chain: certChain,
              expiry: "TODO",
            },
          });

          return certChain;
        }).pipe(
          Effect.withSpan("acme"),
          Effect.catch(
            Effect.fn(function* (err) {
              yield* Effect.logError("ACME flow failed:", err);
              yield* db.certificate.update({
                id,
                state: {
                  type: "failed",
                  reason: err instanceof Error ? err.message : String(err),
                },
              });
            }),
          ),
        );

      return Service.of({
        issue: Effect.fn(function* (csr) {
          const id = ID.makeUnsafe(crypto.randomUUID());

          yield* db.certificate.update({
            id,
            state: { type: "issuing" },
          });
          yield* acme(id, csr).pipe(Effect.forkDetach);
          return id;
        }),
        fromToken: Effect.fn(function* (token) {
          const id = HashMap.get(tokenMap, token);
          if (Option.isNone(id)) {
            return Option.none();
          }
          return yield* db.certificate.get(id.value);
        }),
        get: Effect.fn(function* (id) {
          return yield* db.certificate.get(id);
        }),
      });
    }),
  );
}
