import { Effect, Schema, ServiceMap } from "effect";
import { ApiClient } from "@peculiar/acme-client";
import { JsonWebKey } from "@peculiar/jose";

export namespace Acme {
  export class Error extends Schema.TaggedErrorClass<Error>()("AcmeError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  const call = <T>(fn: () => Promise<T>, message: string) =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) => new Error({ message, cause }),
    });

  export interface Client {
    newAccount(params: {
      contact: string[];
      termsOfServiceAgreed: boolean;
    }): Effect.Effect<unknown, Error>;
    newOrder(params: { identifiers: Array<{ type: string; value: string }> }): Effect.Effect<
      {
        content: {
          authorizations: string[];
          finalize?: string;
          status: string;
        };
        headers: { location: string | null };
      },
      Error
    >;
    getAuthorization(url: string): Effect.Effect<
      {
        content: {
          status: string;
          challenges?: Array<{ type: string; token: string; url: string }>;
        };
      },
      Error
    >;
    getChallenge(
      url: string,
      method: string,
    ): Effect.Effect<
      {
        content: { status: string };
        headers: { link: string[] | null };
      },
      Error
    >;
    finalize(
      url: string,
      params: { csr: string },
    ): Effect.Effect<{ content: { status: string } }, Error>;
    getOrder(
      url: string,
    ): Effect.Effect<{ content: { status: string; certificate?: string } }, Error>;
    getCertificate(url: string): Effect.Effect<{ content: ArrayBuffer[] }, Error>;
    key: CryptoKey;
    thumbprint: string;
  }

  export interface Factory {
    create(url: string): Effect.Effect<Client, Error>;
  }

  const wrap = (raw: ApiClient) =>
    Effect.gen(function* () {
      // Compute once; deterministic for a given key
      const thumbprint = yield* Effect.tryPromise({
        try: async () => {
          const jwk = await crypto.subtle.exportKey("jwk", raw.accountKey.publicKey);
          const joseJwk = new JsonWebKey(crypto, jwk);
          const hex = await joseJwk.getThumbprint();
          return Buffer.from(hex, "hex").toString("base64url");
        },
        catch: (cause) => new Acme.Error({ message: "Compute thumbprint", cause }),
      });

      return {
        newAccount: (params) => call(() => raw.newAccount(params), "Create ACME account"),
        newOrder: (params) => call(() => raw.newOrder(params), "Create order"),
        getAuthorization: (url) => call(() => raw.getAuthorization(url), "Get authorization"),
        getChallenge: (url, method) =>
          call(() => raw.getChallenge(url, method), "Trigger challenge"),
        finalize: (url, params) => call(() => raw.finalize(url, params), "Finalize order"),
        getOrder: (url) => call(() => raw.getOrder(url), "Get order"),
        getCertificate: (url) => call(() => raw.getCertificate(url), "Download certificate"),
        get key() {
          return raw.accountKey;
        },
        get thumbprint() {
          return thumbprint;
        },
      } satisfies Client;
    });

  export const Factory = ServiceMap.Reference<Factory>("AcmeFactory", {
    defaultValue: () => ({
      create: (url) =>
        Effect.gen(function* () {
          const client = yield* call(async () => {
            const key = await crypto.subtle.generateKey(
              { name: "ECDSA", namedCurve: "P-256" },
              true,
              ["sign", "verify"],
            );
            return ApiClient.create(key, url, { fetch, crypto });
          }, "Create ACME client");
          return yield* wrap(client);
        }),
    }),
  });
}
