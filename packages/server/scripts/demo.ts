import { Effect, Logger } from "effect";
import { ApiClient } from "../src/api/client.js";
import { CSR } from "@opentunnel/core/csr";
import "reflect-metadata";
import { Pkcs10CertificateRequestGenerator, Pkcs10CertificateRequest } from "@peculiar/x509";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Https from "node:https";
import { fileURLToPath } from "node:url";

const __dirname = Path.dirname(fileURLToPath(import.meta.url));

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
      }) as Promise<Pkcs10CertificateRequest>,
    catch: (error) =>
      new Error(`Failed to create CSR: ${error instanceof Error ? error.message : String(error)}`),
  });

  yield* client.tunnel.bind({
    params: {
      id: tunnel.tunnel.id,
    },
    payload: {
      csr: csr.toString() as CSR.Raw,
    },
  });

  yield* Effect.log("Waiting for certificate...");

  let certResult: { state: { type: string; certificate?: string; chain?: string } } | undefined;
  while (true) {
    const cert = yield* client.tunnel.certificate({
      params: {
        id: tunnel.tunnel.id,
      },
    });
    yield* Effect.log("certificate state", cert.state.type);
    if (cert.state.type === "failed" || cert.state.type === "ready") {
      certResult = cert as typeof certResult;
      break;
    }
    yield* Effect.sleep(1000);
  }

  if (certResult?.state.type === "ready" && certResult.state.certificate) {
    yield* Effect.log("certificate ready! Saving to files...");

    // Save certificate and chain
    const certPath = Path.join(__dirname, "cert.pem");
    const chainPath = Path.join(__dirname, "chain.pem");
    const fullchainPath = Path.join(__dirname, "fullchain.pem");

    yield* Effect.tryPromise({
      try: () => Fs.writeFile(certPath, certResult!.state.certificate!),
      catch: (error) => new Error(`Failed to write cert: ${error}`),
    });

    if (certResult.state.chain) {
      yield* Effect.tryPromise({
        try: () => Fs.writeFile(chainPath, certResult!.state.chain!),
        catch: (error) => new Error(`Failed to write chain: ${error}`),
      });

      // Create fullchain (cert + chain)
      yield* Effect.tryPromise({
        try: () =>
          Fs.writeFile(
            fullchainPath,
            `${certResult!.state.certificate!}\n${certResult!.state.chain!}`,
          ),
        catch: (error) => new Error(`Failed to write fullchain: ${error}`),
      });
    }

    // Export and save private key
    const exportedKey = yield* Effect.tryPromise({
      try: () => crypto.subtle.exportKey("pkcs8", keys.privateKey),
      catch: (error) => new Error(`Failed to export private key: ${error}`),
    });

    // Convert to PEM format
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(exportedKey).toString("base64")}\n-----END PRIVATE KEY-----\n`;
    const keyPath = Path.join(__dirname, "key.pem");

    yield* Effect.tryPromise({
      try: () => Fs.writeFile(keyPath, keyPem),
      catch: (error) => new Error(`Failed to write key: ${error}`),
    });

    yield* Effect.log("Certificate and key saved!");
    yield* Effect.log(`  Cert: ${certPath}`);
    yield* Effect.log(`  Key: ${keyPath}`);

    // Start HTTPS server on port 3002
    yield* Effect.log("Starting HTTPS server on port 3002...");
    yield* Effect.log(`Visit: https://${tunnel.tunnel.hostname}:3002`);

    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve) => {
          const server = Https.createServer(
            {
              cert: certResult!.state.chain
                ? `${certResult!.state.certificate!}\n${certResult!.state.chain!}`
                : certResult!.state.certificate!,
              key: keyPem,
            },
            (req, res) => {
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end("Hello World from OpenTunnel!\n");
            },
          );

          server.listen(3002, () => {
            console.log(`HTTPS server running on port 3002`);
            console.log(`Visit: https://${tunnel.tunnel.hostname}:3002`);
            resolve();
          });
        }),
      catch: (error) => new Error(`Failed to start HTTPS server: ${error}`),
    });

    // Keep the program running
    yield* Effect.never;
  } else {
    yield* Effect.log("Certificate failed to provision");
  }
}).pipe(Effect.provide(Logger.layer([Logger.consolePretty()])), Effect.provide(ApiClient.layer));

await Effect.runPromise(program);
