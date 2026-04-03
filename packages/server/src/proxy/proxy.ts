import { Effect } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { NodeSocket } from "@effect/platform-node";
import { Bridge } from "@opentunnel/core/bridge";

/**
 * Handle a single public TCP connection
 *
 * The proxy does minimal work - just extracts the Net.Socket and hands it
 * to the Bridge service which handles everything:
 * - Reading ClientHello / extracting SNI
 * - Routing to the right bridge session
 * - All data piping
 */
export function ProxyConnection(_socket: Socket.Socket) {
  return Effect.gen(function* () {
    // Get the underlying Net.Socket from NodeSocket
    const net = yield* Effect.serviceOption(NodeSocket.NetSocket);
    if (!net.valueOrUndefined) {
      yield* Effect.logError("No NetSocket available");
      return;
    }

    const clientSocket = net.value;
    const clientAddress = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;

    yield* Effect.log(`New public connection from ${clientAddress}`);

    // Hand off to Bridge service - it does everything else
    const bridge = yield* Bridge.Service;
    yield* bridge.proxy(clientSocket, clientAddress);
  });
}
