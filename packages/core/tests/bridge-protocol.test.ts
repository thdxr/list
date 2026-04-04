import { Effect, Exit, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { BridgeProtocol } from "../src/bridge-protocol.ts";

describe("BridgeProtocol", () => {
  it.effect("decodes client and server control messages", () =>
    Effect.gen(function* () {
      const attach = yield* Schema.decodeUnknownEffect(BridgeProtocol.ClientControlMessage)({
        type: "attach",
        token: "token-123",
        transport: "ws",
        client: {
          version: "1.0.0",
          max_conns: 10,
        },
      });

      const open = yield* Schema.decodeUnknownEffect(BridgeProtocol.ServerControlMessage)({
        type: "open",
        conn: 7,
        peer: "127.0.0.1:443",
        sni: "demo.example.com",
        alpn: "h2",
      });

      expect(attach.type).toBe("attach");
      expect(open.type).toBe("open");
      if (open.type === "open") {
        expect(open.conn).toBe(7);
      }
      expect(BridgeProtocol.WEBSOCKET_SUBPROTOCOL).toBe("opentunnel");
      expect(BridgeProtocol.BridgeErrorCode.BAD_ATTACH).toBe("bad_attach");
      expect(BridgeProtocol.BridgeTiming.HEARTBEAT_MS).toBe(15_000);
      expect(BridgeProtocol.DataFrame.CONN_ID_SIZE).toBe(4);
    }),
  );

  it.effect("rejects out-of-range connection IDs", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(BridgeProtocol.ConnID)(0x1_0000_0000),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it("builds and parses binary data frames", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const frame = BridgeProtocol.buildDataFrame(42, payload);
    const parsed = BridgeProtocol.parseDataFrame(frame);

    expect(parsed).not.toBeNull();
    expect(parsed?.conn).toBe(42);
    expect(Array.from(parsed?.payload ?? [])).toEqual([1, 2, 3, 4]);
    expect(BridgeProtocol.parseDataFrame(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
