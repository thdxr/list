import { Effect, Layer, Logger } from "effect";
import { ApiClient } from "../src/api/client.js";
import "reflect-metadata";
import { Pkcs10CertificateRequestGenerator } from "@peculiar/x509";

const program = Effect.gen(function* () {
  const client = yield* ApiClient;
  const tunnel = yield* client.tunnel.create();
  yield* Effect.log(tunnel);

  const keys = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.generateKey(
        {
          name: "ECDSA",
          namedCurve: "P-256",
        },
        true,
        ["sign", "verify"],
      ) as Promise<CryptoKeyPair>,
    catch: (error) =>
      new Error(
        `Failed to generate key pair: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });

  const csr = yield* Effect.tryPromise({
    try: () =>
      Pkcs10CertificateRequestGenerator.create({
        name: `CN=${tunnel.tunnel.hostname}`,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
      }),
    catch: (error) =>
      new Error(`Failed to create CSR: ${error instanceof Error ? error.message : String(error)}`),
  });

  yield* client.tunnel.bind({
    params: {
      id: tunnel.tunnel.id,
    },
    payload: {
      csr: csr.toString() as any,
    },
  });
}).pipe(Effect.provide(Logger.layer([Logger.consolePretty()])), Effect.provide(ApiClient.layer));

await Effect.runPromise(program);
