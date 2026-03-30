import "reflect-metadata";
import { Effect, Layer, Logger, Option } from "effect";
import { Certificate } from "../src/certificate.ts";
import { Database } from "../src/database.ts";
import { CSR } from "../src/csr.ts";
import { AppConfig } from "../src/config.ts";
import { Pkcs10CertificateRequestGenerator } from "@peculiar/x509";

// Create the effect to issue a certificate
const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  const domain = `test.${config.OPENTUNNEL_DOMAIN}`;

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

  // Create CSR
  const csr = yield* Effect.tryPromise({
    try: () =>
      Pkcs10CertificateRequestGenerator.create({
        name: `CN=${domain}`,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
      }),
    catch: (error) =>
      new Error(`Failed to create CSR: ${error instanceof Error ? error.message : String(error)}`),
  });

  yield* Effect.log(`Generating CSR for domain: ${domain}`);

  yield* Effect.log("Issuing certificate...");
  const certificate = yield* Certificate.Service;
  const id = yield* certificate.issue(CSR.Raw.makeUnsafe(csr.toString()));
  const info = yield* certificate.get(id);
  yield* Effect.log("Certificate info:", info.valueOrUndefined);

  return id;
}).pipe(
  Effect.provide(Logger.layer([Logger.consolePretty()])),
  Effect.provide(Certificate.layer),
  Effect.provide(Database.Memory),
);

Effect.runPromise(program)
  .then((id) => {
    console.log("Success! Certificate ID:", id);
  })
  .catch((error) => {
    console.error("Failed to issue certificate:", error);
  });
