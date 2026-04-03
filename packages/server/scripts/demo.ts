import { Effect, Logger } from "effect";
import { ApiClient } from "../src/api/client.js";
import { CSR } from "@opentunnel/core/csr";
import { Tunnel } from "@opentunnel/core/tunnel";
import { BridgeProtocol } from "@opentunnel/core/bridge-protocol";
import "reflect-metadata";
import { Pkcs10CertificateRequestGenerator, Pkcs10CertificateRequest } from "@peculiar/x509";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as tls from "node:tls";
import * as net from "node:net";
import WebSocket from "ws";
import { Buffer } from "node:buffer";

interface PersistedTunnelState {
  id: string;
  token: string;
  hostname: string;
}

interface PersistedCertificateResult {
  state: {
    type: string;
    certificate?: string;
    chain?: string;
  };
}

const stateDir = Path.join("/tmp", "opentunnel-demo");
const tunnelStatePath = Path.join(stateDir, "tunnel.json");
const certPath = Path.join(stateDir, "cert.pem");
const chainPath = Path.join(stateDir, "chain.pem");
const fullchainPath = Path.join(stateDir, "fullchain.pem");
const keyPath = Path.join(stateDir, "key.pem");

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

const hasTag = (error: unknown, tag: string): error is { _tag: string } =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;

const rawDataToString = (data: WebSocket.RawData): string => {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
};

const ensureStateDir = Effect.tryPromise({
  try: () => Fs.mkdir(stateDir, { recursive: true }),
  catch: (error) => new Error(`Failed to create ${stateDir}: ${formatError(error)}`),
});

const writeTextFile = (filepath: string, content: string, label: string) =>
  Effect.tryPromise({
    try: () => Fs.writeFile(filepath, content),
    catch: (error) => new Error(`Failed to write ${label}: ${formatError(error)}`),
  });

const readTextFileIfExists = (filepath: string, label: string) =>
  Effect.tryPromise({
    try: () => Fs.readFile(filepath, "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error: unknown) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return Effect.succeed(undefined);
      }
      return Effect.fail(new Error(`Failed to read ${label}: ${formatError(error)}`));
    }),
  );

const loadTunnelState = () =>
  readTextFileIfExists(tunnelStatePath, "tunnel state").pipe(
    Effect.flatMap((content) => {
      if (!content) {
        return Effect.succeed(undefined);
      }

      return Effect.try({
        try: () => {
          const parsed = JSON.parse(content) as Partial<PersistedTunnelState>;

          if (
            typeof parsed.id !== "string" ||
            typeof parsed.token !== "string" ||
            typeof parsed.hostname !== "string"
          ) {
            throw new Error("Persisted tunnel state is missing required fields");
          }

          return parsed as PersistedTunnelState;
        },
        catch: (error) => new Error(`Failed to parse tunnel state: ${formatError(error)}`),
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.log(`Ignoring persisted tunnel state: ${formatError(error)}`).pipe(
            Effect.map(() => undefined),
          ),
        ),
      );
    }),
  );

const saveTunnelState = (tunnel: {
  tunnel: {
    id: Tunnel.ID;
    hostname: CSR.Hostname;
  };
  token: Tunnel.Token;
}) =>
  writeTextFile(
    tunnelStatePath,
    JSON.stringify(
      {
        id: tunnel.tunnel.id,
        token: tunnel.token,
        hostname: tunnel.tunnel.hostname,
      },
      null,
      2,
    ),
    "tunnel state",
  );

const saveCertificateFiles = (certificate: string, chain?: string) =>
  Effect.gen(function* () {
    yield* writeTextFile(certPath, certificate, "certificate");
    yield* writeTextFile(chainPath, chain ?? "", "certificate chain");
    yield* writeTextFile(
      fullchainPath,
      chain ? `${certificate}\n${chain}` : certificate,
      "certificate full chain",
    );
  });

// Channel state for tracking active connections
interface ChannelState {
  connID: number;
  relaySocket?: net.Socket;
  tlsServer: tls.Server;
  tlsSocket?: tls.TLSSocket;
  upstreamSocket?: net.Socket;
  pendingFrames: Buffer[];
  active: boolean;
}

const program = Effect.gen(function* () {
  yield* ensureStateDir;

  const client = yield* ApiClient;
  const persistedTunnel = yield* loadTunnelState();

  let tunnel:
    | {
        tunnel: Tunnel.Info;
        token: Tunnel.Token;
      }
    | undefined;

  if (persistedTunnel) {
    const existing = yield* client.tunnel
      .get({
        params: {
          id: Tunnel.ID.makeUnsafe(persistedTunnel.id),
        },
      })
      .pipe(
        Effect.map((info) => ({
          tunnel: info,
          token: Tunnel.Token.makeUnsafe(persistedTunnel.token),
        })),
        Effect.catch((error: unknown) => {
          if (hasTag(error, "NotFound")) {
            return Effect.succeed(undefined);
          }

          return Effect.fail(error);
        }),
      );

    if (existing) {
      tunnel = existing;
      yield* Effect.log(`Reusing persisted tunnel ${tunnel.tunnel.id}`);
      yield* saveTunnelState(tunnel);
    } else {
      yield* Effect.log(
        `Persisted tunnel ${persistedTunnel.id} no longer exists, creating a new one`,
      );
    }
  }

  if (!tunnel) {
    tunnel = yield* client.tunnel.create({});
    yield* Effect.log(`Created tunnel ${tunnel.tunnel.id}`);
    yield* saveTunnelState(tunnel);
  }

  yield* Effect.log(tunnel);

  let keyPem = yield* readTextFileIfExists(keyPath, "private key");

  const waitForCertificate = Effect.fn("demo.waitForCertificate")(function* (tunnelID: Tunnel.ID) {
    while (true) {
      const cert = (yield* client.tunnel.certificate({
        params: {
          id: tunnelID,
        },
      })) as PersistedCertificateResult;

      yield* Effect.log("certificate state", cert.state.type);

      if (cert.state.type === "failed" || cert.state.type === "ready") {
        return cert;
      }

      yield* Effect.sleep(1000);
    }
  });

  let certResult: PersistedCertificateResult | undefined;
  const existingCertificate = yield* client.tunnel
    .certificate({
      params: {
        id: tunnel.tunnel.id,
      },
    })
    .pipe(
      Effect.map((cert) => cert as PersistedCertificateResult),
      Effect.catch((error: unknown) => {
        if (hasTag(error, "NoCertificate")) {
          return Effect.succeed(undefined);
        }

        return Effect.fail(error);
      }),
    );

  if (existingCertificate?.state.type === "ready" && keyPem) {
    yield* Effect.log(`Reusing ready certificate for tunnel ${tunnel.tunnel.id}`);
    certResult = existingCertificate;
  } else if (existingCertificate && existingCertificate.state.type !== "failed" && keyPem) {
    yield* Effect.log(
      `Certificate request already exists for tunnel ${tunnel.tunnel.id}, waiting for it to finish`,
    );
    certResult = yield* waitForCertificate(tunnel.tunnel.id);
  } else {
    if (!keyPem && existingCertificate?.state.type === "ready") {
      yield* Effect.log(
        `Tunnel ${tunnel.tunnel.id} already has a certificate, but the local private key is missing; requesting a new certificate`,
      );
    }

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
      catch: (error) => new Error(`Failed to generate key pair: ${formatError(error)}`),
    });

    const csr = yield* Effect.tryPromise({
      try: () =>
        Pkcs10CertificateRequestGenerator.create({
          name: `CN=${tunnel.tunnel.hostname}`,
          signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
          keys,
        }) as Promise<Pkcs10CertificateRequest>,
      catch: (error) => new Error(`Failed to create CSR: ${formatError(error)}`),
    });

    const exportedKey = yield* Effect.tryPromise({
      try: () => crypto.subtle.exportKey("pkcs8", keys.privateKey),
      catch: (error) => new Error(`Failed to export private key: ${formatError(error)}`),
    });

    keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(exportedKey).toString("base64")}\n-----END PRIVATE KEY-----\n`;

    yield* writeTextFile(keyPath, keyPem, "private key");

    yield* client.tunnel.bind({
      params: {
        id: tunnel.tunnel.id,
      },
      payload: {
        csr: csr.toString() as CSR.Raw,
      },
    });

    yield* Effect.log("Waiting for certificate...");
    certResult = yield* waitForCertificate(tunnel.tunnel.id);
  }

  if (certResult?.state.type === "ready" && certResult.state.certificate && keyPem) {
    yield* Effect.log("certificate ready! Saving to files...");
    yield* saveCertificateFiles(certResult.state.certificate, certResult.state.chain);

    const readyCertificate = certResult.state.certificate;
    const readyChain = certResult.state.chain;
    const readyKeyPem = keyPem;

    yield* Effect.log("Certificate and key saved!");
    yield* Effect.log(`  State: ${tunnelStatePath}`);
    yield* Effect.log(`  Cert: ${certPath}`);
    yield* Effect.log(`  Key: ${keyPath}`);

    // Now connect to the bridge WebSocket
    yield* Effect.log("Connecting to bridge...");

    const bridgeUrl = `ws://localhost:3000/api/tunnel/${tunnel.tunnel.id}/connect`;
    yield* Effect.log(`Bridge URL: ${bridgeUrl}`);

    // Create WebSocket connection
    const ws = new WebSocket(bridgeUrl, ["opentunnel"], {
      rejectUnauthorized: false, // Self-signed cert for localhost testing
    });

    // Wait for connection
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        }),
      catch: (error) => new Error(`Failed to connect to bridge: ${formatError(error)}`),
    });

    yield* Effect.log("Bridge connected! Sending attach...");

    // Send attach message
    const attachMessage = new BridgeProtocol.AttachMessage({
      type: "attach",
      token: tunnel.token,
      transport: "ws",
      client: new BridgeProtocol.ClientInfo({
        version: "0.1.0",
        max_conns: 256,
      }),
    });
    ws.send(JSON.stringify(attachMessage));

    // Wait for attached response
    const attachedResponse = yield* Effect.tryPromise({
      try: () =>
        new Promise<BridgeProtocol.AttachedMessage>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Attach timeout")), 10000);

          const onMessage = (data: WebSocket.RawData) => {
            try {
              const msg = JSON.parse(rawDataToString(data));
              if (msg.type === "attached") {
                clearTimeout(timeout);
                ws.off("message", onMessage);
                resolve(msg as BridgeProtocol.AttachedMessage);
              } else if (msg.type === "attach_error") {
                clearTimeout(timeout);
                ws.off("message", onMessage);
                reject(new Error(`Attach failed: ${msg.code}`));
              }
            } catch {
              // Ignore non-JSON messages
            }
          };

          ws.on("message", onMessage);
        }),
      catch: (error) => new Error(`Attach failed: ${formatError(error)}`),
    });

    yield* Effect.log(`Attached! Session: ${attachedResponse.session}`);
    yield* Effect.log("Ready to proxy traffic to http://localhost:4096");

    // Channel registry
    const channels = new Map<number, ChannelState>();

    // Handle incoming messages from relay
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        // Control message
        try {
          const msg = JSON.parse(rawDataToString(data));

          if (msg.type === "open") {
            // New channel opened by relay
            handleOpenChannel(msg as BridgeProtocol.OpenMessage);
          } else if (msg.type === "end") {
            const channel = channels.get(msg.conn);
            if (channel) {
              closeChannel(channel, "end");
            }
          } else if (msg.type === "reset") {
            const channel = channels.get(msg.conn);
            if (channel) {
              closeChannel(channel, "reset");
            }
          } else if (msg.type === "ping") {
            // Send pong
            ws.send(JSON.stringify({ type: "pong", time_sent: msg.time_sent }));
          }
        } catch {
          // Ignore parse errors
        }
      } else {
        // Binary data - forward to the channel's TLS socket
        const buffer = Buffer.from(data as Buffer);
        const connID = buffer.readUInt32BE(0);
        const payload = buffer.slice(4);

        const channel = channels.get(connID);
        if (channel && channel.active) {
          if (channel.relaySocket && !channel.relaySocket.destroyed) {
            channel.relaySocket.write(payload);
          } else {
            channel.pendingFrames.push(payload);
          }
        }
      }
    });

    function closeChannel(channel: ChannelState, mode: "end" | "reset") {
      if (!channel.active) {
        return;
      }

      channel.active = false;
      channels.delete(channel.connID);

      if (mode === "end") {
        channel.upstreamSocket?.end();
        channel.tlsSocket?.end();
        channel.relaySocket?.end();
        if (channel.tlsServer.listening) {
          channel.tlsServer.close();
        }
        return;
      }

      channel.upstreamSocket?.destroy();
      channel.tlsSocket?.destroy();
      channel.relaySocket?.destroy();
      if (channel.tlsServer.listening) {
        channel.tlsServer.close();
      }
    }

    // Handle open channel - terminate TLS locally and proxy plaintext upstream
    function handleOpenChannel(openMsg: BridgeProtocol.OpenMessage) {
      const connID = openMsg.conn;
      const tlsServer = tls.createServer({
        cert: readyChain ? `${readyCertificate}\n${readyChain}` : readyCertificate,
        key: readyKeyPem,
        ALPNProtocols: ["http/1.1"],
      });

      const channelState: ChannelState = {
        connID,
        tlsServer,
        pendingFrames: [],
        active: true,
      };
      channels.set(connID, channelState);

      tlsServer.on("secureConnection", (socket) => {
        if (!channelState.active) {
          socket.destroy();
          return;
        }

        channelState.tlsSocket = socket;
        const upstreamSocket = net.createConnection({
          host: "127.0.0.1",
          port: 4096,
        });
        channelState.upstreamSocket = upstreamSocket;

        socket.on("data", (chunk) => {
          upstreamSocket.write(chunk);
        });

        socket.on("end", () => {
          upstreamSocket.end();
        });

        upstreamSocket.on("data", (chunk) => {
          socket.write(chunk);
        });

        upstreamSocket.on("end", () => {
          socket.end();
        });

        upstreamSocket.on("error", (err) => {
          console.error(`Upstream error on channel ${connID}:`, err);
          const code = upstreamSocket.connecting
            ? BridgeProtocol.BridgeErrorCode.UPSTREAM_CONNECT_FAILED
            : BridgeProtocol.BridgeErrorCode.UPSTREAM_IO_ERROR;

          closeChannel(channelState, "reset");

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "reset",
                conn: connID,
                code,
              }),
            );
          }
        });

        socket.on("close", () => {
          if (!channelState.active) {
            return;
          }

          closeChannel(channelState, "end");

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "end", conn: connID }));
          }
        });

        socket.on("error", (err) => {
          console.error(`TLS error on channel ${connID}:`, err);
          closeChannel(channelState, "reset");

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "reset",
                conn: connID,
                code: BridgeProtocol.BridgeErrorCode.CLIENT_IO_ERROR,
              }),
            );
          }
        });
      });

      tlsServer.on("error", (err) => {
        if (!channelState.active) {
          return;
        }

        console.error(`TLS server error on channel ${connID}:`, err);
        closeChannel(channelState, "reset");

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "reset",
              conn: connID,
              code: BridgeProtocol.BridgeErrorCode.CLIENT_IO_ERROR,
            }),
          );
        }
      });

      tlsServer.listen(0, "127.0.0.1", () => {
        if (!channelState.active) {
          if (tlsServer.listening) {
            tlsServer.close();
          }
          return;
        }

        const address = tlsServer.address();
        if (!address || typeof address === "string") {
          closeChannel(channelState, "reset");

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "reset",
                conn: connID,
                code: BridgeProtocol.BridgeErrorCode.CLIENT_IO_ERROR,
              }),
            );
          }
          return;
        }

        const relaySocket = net.createConnection({
          host: "127.0.0.1",
          port: address.port,
        });
        channelState.relaySocket = relaySocket;

        relaySocket.on("connect", () => {
          for (const frame of channelState.pendingFrames) {
            relaySocket.write(frame);
          }
          channelState.pendingFrames.length = 0;
        });

        relaySocket.on("data", (chunk: Buffer) => {
          if (!channelState.active || ws.readyState !== WebSocket.OPEN) {
            return;
          }

          const frame = Buffer.allocUnsafe(4 + chunk.length);
          frame.writeUInt32BE(connID, 0);
          frame.set(chunk, 4);
          ws.send(frame);
        });

        relaySocket.on("error", (err) => {
          console.error(`Relay socket error on channel ${connID}:`, err);
          closeChannel(channelState, "reset");

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "reset",
                conn: connID,
                code: BridgeProtocol.BridgeErrorCode.CLIENT_IO_ERROR,
              }),
            );
          }
        });
      });
    }

    // Heartbeat
    const heartbeatInterval = setInterval(() => {
      ws.send(JSON.stringify({ type: "ping", time_sent: Date.now() }));
    }, attachedResponse.heartbeat_ms);

    // Handle WebSocket close
    ws.on("close", () => {
      clearInterval(heartbeatInterval);
      console.log("Bridge connection closed");

      // Close all channels
      for (const [_, channel] of channels) {
        closeChannel(channel, "reset");
      }
      channels.clear();
    });

    ws.on("error", (err) => {
      console.error("Bridge WebSocket error:", err);
    });

    yield* Effect.log("Bridge client running. Forwarding to http://localhost:4096");
    yield* Effect.log(`Tunnel: https://${tunnel.tunnel.hostname}`);

    // Keep running
    yield* Effect.never;
  } else {
    yield* Effect.log("Certificate failed to provision");
  }
}).pipe(Effect.provide(Logger.layer([Logger.consolePretty()])), Effect.provide(ApiClient.layer));

await Effect.runPromise(program);
