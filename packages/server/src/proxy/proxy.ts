import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import { NodeSocket } from "@effect/platform-node";
import { readTlsClientHello, getExtensionData } from "read-tls-client-hello";
import * as Net from "node:net";
import { Buffer } from "node:buffer";

/**
 * Read initial TLS data and parse ClientHello while buffering for rebroadcast
 */
function sniffClientHello(
  socket: Net.Socket,
): Promise<{ hello: Awaited<ReturnType<typeof readTlsClientHello>>; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const minClientHelloSize = 43; // Minimum TLS ClientHello size

    const onData = (data: Buffer) => {
      chunks.push(data);
      totalLength += data.length;

      // Try to parse once we have enough data
      if (totalLength >= minClientHelloSize) {
        // Create a temporary socket-like object with the buffered data
        const tempSocket = new Net.Socket({ readable: true });
        const buffer = Buffer.concat(chunks);

        // Push buffer to temp socket
        tempSocket.push(buffer);
        tempSocket.push(null); // End of data

        // Pause original socket to prevent data loss
        socket.pause();
        socket.removeListener("data", onData);

        // Parse the ClientHello from temp socket
        readTlsClientHello(tempSocket as unknown as Net.Socket)
          .then((hello) => {
            resolve({ hello, buffer });
          })
          .catch((err) => {
            reject(err);
          });
      }
    };

    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("end", () => {
      if (totalLength < minClientHelloSize) {
        reject(new Error("Socket closed before ClientHello received"));
      }
    });
  });
}

/**
 * Handle a single connection - read TLS ClientHello, extract SNI, forward to upstream
 *
 * Note: This handler uses NetSocket internally, but the requirement is satisfied
 * at runtime by NodeSocketServer when it runs the handler per-connection.
 * The type cast is safe because NodeSocketServer provides NetSocket via
 * ServiceMap when running the handler.
 */
export function ProxyConnection(_socket: Socket.Socket) {
  return Effect.gen(function* () {
    // NetSocket is provided at runtime by NodeSocketServer per-connection
    const net = yield* Effect.serviceOption(NodeSocket.NetSocket);
    if (!net.valueOrUndefined) {
      yield* Effect.logError("No NetSocket available");
      return;
    }

    // Add finalizer to ensure socket is always closed
    const scope = yield* Scope.Scope;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        if (!net.value.closed) {
          net.value.destroy();
        }
      }),
    );

    yield* Effect.log("New connection");

    // Sniff ClientHello while buffering data for rebroadcast
    const sniffResult = yield* Effect.tryPromise({
      try: () => sniffClientHello(net.value),
      catch: (error) =>
        new Socket.SocketError({
          reason: new Socket.SocketReadError({ cause: error }),
        }),
    }).pipe(
      Effect.tapError((error) => Effect.logError("Failed to read TLS ClientHello", error)),
      Effect.orElseSucceed(() => undefined),
    );
    if (!sniffResult) return;

    const { hello, buffer } = sniffResult;

    const sni = getExtensionData(hello, "sni");

    if (!sni?.serverName) {
      yield* Effect.log("No SNI found in ClientHello, closing connection");
      return;
    }

    yield* Effect.log(`SNI: ${sni.serverName} - forwarding to localhost:3002`);

    // Connect to upstream server (localhost:3002)
    const upstream = yield* Effect.tryPromise({
      try: () =>
        new Promise<Net.Socket>((resolve, reject) => {
          const conn = Net.createConnection({ host: "localhost", port: 3002 });
          conn.once("connect", () => resolve(conn));
          conn.once("error", (err) => reject(err));
        }),
      catch: (error) =>
        new Socket.SocketError({
          reason: new Socket.SocketOpenError({ kind: "Unknown", cause: error as Error }),
        }),
    });

    // Add finalizer to close upstream connection
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        if (!upstream.closed) {
          upstream.destroy();
        }
      }),
    );

    const clientSocket = net.value;

    // Rebroadcast the buffered ClientHello bytes to upstream first
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          upstream.write(buffer, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
      catch: (error) =>
        new Socket.SocketError({
          reason: new Socket.SocketWriteError({ cause: error as Error }),
        }),
    });

    // Resume the client socket and pipe remaining data
    clientSocket.resume();
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);

    // Wait for either side to close
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve) => {
          clientSocket.once("close", () => resolve());
          upstream.once("close", () => resolve());
          clientSocket.once("error", () => resolve());
          upstream.once("error", () => resolve());
        }),
      catch: () => Effect.void,
    });
  }).pipe(Effect.scoped);
}
