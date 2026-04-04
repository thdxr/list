import { Effect, Fiber, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeAll, describe, expect, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { it } from "./effect-test.ts";
import { BridgeProtocol } from "../src/bridge-protocol.ts";
import { CSR } from "../src/csr.ts";
import { Tunnel } from "../src/tunnel.ts";

const tlsMocks = vi.hoisted(() => {
  const state: {
    alpn: string;
    failParse: boolean;
    host: string | undefined;
  } = {
    alpn: "h2",
    failParse: false,
    host: "bridge.example.com",
  };

  return {
    state,
    readTlsClientHello: vi.fn(async () => {
      if (state.failParse) {
        throw new Error("parse failed");
      }

      return {};
    }),
    getExtensionData: vi.fn((_hello: unknown, name: string) => {
      if (name === "sni") {
        return state.host ? { serverName: state.host } : undefined;
      }

      if (name === "alpn") {
        return { protocols: state.alpn ? [state.alpn] : [] };
      }

      return undefined;
    }),
  };
});

vi.mock("read-tls-client-hello", () => ({
  getExtensionData: tlsMocks.getExtensionData,
  readTlsClientHello: tlsMocks.readTlsClientHello,
}));

let BridgeModule: typeof import("../src/bridge.ts");

const tunnelID = Tunnel.ID.makeUnsafe("bridge-tunnel-id");
const tunnelInfo = new Tunnel.Info({
  id: tunnelID,
  hostname: CSR.Hostname.makeUnsafe("bridge.example.com"),
  state: "online",
});

class TestBridgeSocket {
  sent: Array<string | Uint8Array> = [];

  private finish: (() => void) | undefined;
  private handler: ((data: string | Uint8Array) => Effect.Effect<void, never, never>) | undefined;
  private readonly onReady: Promise<void>;
  private readonly resolveReady: () => void;

  constructor() {
    let resolveReady!: () => void;
    this.onReady = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.resolveReady = resolveReady;
  }

  waitUntilReady() {
    return this.onReady;
  }

  writer = Effect.succeed((chunk: Uint8Array | string) =>
    Effect.sync(() => {
      this.sent.push(typeof chunk === "string" ? chunk : new Uint8Array(chunk));
    }),
  );

  runRaw = (handler: (data: string | Uint8Array) => Effect.Effect<void, never, never>) =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve) => {
          this.handler = handler;
          this.finish = resolve;
          this.resolveReady();
        }),
      catch: (cause) => cause as Error,
    });

  emit(data: string | Uint8Array) {
    if (!this.handler) {
      throw new Error("bridge socket is not ready");
    }

    return this.handler(data);
  }

  close() {
    this.finish?.();
  }
}

class TestNetSocket extends EventEmitter {
  closed = false;
  paused = true;
  readonly remoteAddress = "127.0.0.1";
  readonly remotePort = 443;
  readonly written: Buffer[] = [];

  private readonly pending: Buffer[] = [];

  isPaused() {
    return this.paused;
  }

  pause() {
    this.paused = true;
    return this;
  }

  resume() {
    this.paused = false;

    while (!this.paused && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        break;
      }

      this.emit("data", next);
    }

    return this;
  }

  queue(chunk: Buffer | Uint8Array) {
    this.pending.push(Buffer.from(chunk));
    if (!this.paused) {
      this.resume();
    }
  }

  write(chunk: Buffer, callback?: (error?: Error | null) => void) {
    this.written.push(Buffer.from(chunk));
    callback?.(undefined);
    return true;
  }

  destroy(error?: Error) {
    if (this.closed) {
      return this;
    }

    this.closed = true;
    if (error) {
      this.emit("error", error);
    }
    this.emit("close");
    return this;
  }
}

const flush = () =>
  TestClock.withLive(
    Effect.tryPromise({
      try: () => new Promise<void>((resolve) => setImmediate(resolve)),
      catch: (cause) => cause as Error,
    }),
  );

const parseJson = (value: string | Uint8Array) =>
  JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value));

const tlsRecord = (payload: Buffer | string) => {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const record = Buffer.alloc(5 + body.length);

  record[0] = 0x16;
  record[1] = 0x03;
  record[2] = 0x03;
  record.writeUInt16BE(body.length, 3);
  body.copy(record, 5);

  return record;
};

const createTunnelLayer = (
  fromID: (id: Tunnel.ID) => Effect.Effect<Tunnel.Info, Tunnel.NotFoundError> = () =>
    Effect.succeed(tunnelInfo),
) =>
  Layer.succeed(
    Tunnel.Service,
    Tunnel.Service.of({
      auth: () => Effect.succeed(true),
      bind: () => Effect.void,
      certficiate: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      fromID,
    }),
  );

const createBridgeLayer = (
  fromID?: (id: Tunnel.ID) => Effect.Effect<Tunnel.Info, Tunnel.NotFoundError>,
) => Layer.provide(BridgeModule.Bridge.layer, createTunnelLayer(fromID));

beforeAll(async () => {
  BridgeModule = await import("../src/bridge.ts");
});

afterEach(() => {
  tlsMocks.state.alpn = "h2";
  tlsMocks.state.failParse = false;
  tlsMocks.state.host = tunnelInfo.hostname;
  tlsMocks.getExtensionData.mockClear();
  tlsMocks.readTlsClientHello.mockClear();
});

describe("Bridge", () => {
  it.effect("accept attaches a known tunnel, responds to ping, and emits heartbeats", () =>
    Effect.gen(function* () {
      const bridge = yield* BridgeModule.Bridge.Service;
      const socket = new TestBridgeSocket();
      const fiber = yield* Effect.forkChild(bridge.accept(socket as never, tunnelID));

      yield* Effect.tryPromise({
        try: () => socket.waitUntilReady(),
        catch: (cause) => cause as Error,
      });

      yield* socket.emit(
        new TextEncoder().encode(
          ` \n${JSON.stringify(
            new BridgeProtocol.AttachMessage({
              type: "attach",
              token: "token-123",
              transport: "ws",
              client: new BridgeProtocol.ClientInfo({
                version: "1.0.0",
                max_conns: 10,
              }),
            }),
          )}`,
        ),
      );

      const attached = parseJson(socket.sent[0]);
      expect(attached.type).toBe("attached");
      expect(attached.heartbeat_ms).toBe(BridgeProtocol.BridgeTiming.HEARTBEAT_MS);

      yield* socket.emit(
        JSON.stringify(new BridgeProtocol.PingMessage({ type: "ping", time_sent: 123 })),
      );

      const pong = parseJson(socket.sent[1]);
      expect(pong).toEqual({ type: "pong", time_sent: 123 });

      yield* TestClock.adjust(BridgeProtocol.BridgeTiming.HEARTBEAT_MS);
      yield* flush();

      const heartbeat = parseJson(socket.sent[2]);
      expect(heartbeat.type).toBe("ping");

      socket.close();
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(createBridgeLayer())),
  );

  it.effect("accept replies with attach_error for unknown tunnels", () =>
    Effect.gen(function* () {
      const bridge = yield* BridgeModule.Bridge.Service;
      const socket = new TestBridgeSocket();
      const fiber = yield* Effect.forkChild(bridge.accept(socket as never, tunnelID));

      yield* Effect.tryPromise({
        try: () => socket.waitUntilReady(),
        catch: (cause) => cause as Error,
      });

      yield* socket.emit(
        JSON.stringify(
          new BridgeProtocol.AttachMessage({
            type: "attach",
            token: "token-123",
            transport: "ws",
            client: new BridgeProtocol.ClientInfo({
              version: "1.0.0",
              max_conns: 10,
            }),
          }),
        ),
      );

      const message = parseJson(socket.sent[0]);
      expect(message).toEqual({
        type: "attach_error",
        code: BridgeProtocol.BridgeErrorCode.TUNNEL_NOT_BOUND,
      });

      socket.close();
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        createBridgeLayer((id) => Effect.fail(new Tunnel.NotFoundError({ tunnelID: id }))),
      ),
    ),
  );

  it.effect("proxy closes connections when ClientHello parsing does not produce an SNI", () =>
    Effect.gen(function* () {
      tlsMocks.state.host = undefined;

      const bridge = yield* BridgeModule.Bridge.Service;
      const socket = new TestNetSocket();

      socket.queue(tlsRecord("client-hello"));

      yield* bridge.proxy(socket as never, "127.0.0.1:443");

      expect(socket.closed).toBe(true);
    }).pipe(Effect.provide(createBridgeLayer())),
  );

  it.effect("proxy closes connections when there is no attached bridge session", () =>
    Effect.gen(function* () {
      const bridge = yield* BridgeModule.Bridge.Service;
      const socket = new TestNetSocket();

      socket.queue(tlsRecord("client-hello"));

      yield* bridge.proxy(socket as never, "127.0.0.1:443");

      expect(socket.closed).toBe(true);
    }).pipe(Effect.provide(createBridgeLayer())),
  );

  it.effect("proxy forwards data between the public socket and an attached bridge session", () =>
    Effect.gen(function* () {
      const bridge = yield* BridgeModule.Bridge.Service;
      const bridgeSocket = new TestBridgeSocket();
      const acceptFiber = yield* Effect.forkChild(bridge.accept(bridgeSocket as never, tunnelID));

      yield* Effect.tryPromise({
        try: () => bridgeSocket.waitUntilReady(),
        catch: (cause) => cause as Error,
      });

      yield* bridgeSocket.emit(
        JSON.stringify(
          new BridgeProtocol.AttachMessage({
            type: "attach",
            token: "token-123",
            transport: "ws",
            client: new BridgeProtocol.ClientInfo({
              version: "1.0.0",
              max_conns: 10,
            }),
          }),
        ),
      );

      const clientSocket = new TestNetSocket();
      const hello = tlsRecord("client-hello");
      clientSocket.queue(hello);

      const proxyFiber = yield* Effect.forkChild(
        bridge.proxy(clientSocket as never, "127.0.0.1:443"),
      );

      yield* flush();

      const open = parseJson(bridgeSocket.sent[1]);
      expect(open).toMatchObject({
        type: "open",
        conn: 1,
        peer: "127.0.0.1:443",
        sni: tunnelInfo.hostname,
        alpn: "h2",
      });

      const firstFrame = BridgeProtocol.parseDataFrame(bridgeSocket.sent[2] as Uint8Array);
      expect(firstFrame?.conn).toBe(1);
      expect(Buffer.from(firstFrame?.payload ?? [])).toEqual(hello);

      clientSocket.queue(Buffer.from("from-client"));
      yield* flush();

      const secondFrame = BridgeProtocol.parseDataFrame(bridgeSocket.sent[3] as Uint8Array);
      expect(secondFrame?.conn).toBe(1);
      expect(Buffer.from(secondFrame?.payload ?? [])).toEqual(Buffer.from("from-client"));

      yield* bridgeSocket.emit(BridgeProtocol.buildDataFrame(1, Buffer.from("from-bridge")));
      yield* flush();

      expect(clientSocket.written.map((chunk) => chunk.toString("utf8"))).toContain("from-bridge");

      yield* bridgeSocket.emit(
        JSON.stringify(new BridgeProtocol.EndMessage({ type: "end", conn: 1 })),
      );
      yield* flush();

      yield* Fiber.interrupt(proxyFiber);

      bridgeSocket.close();
      yield* Fiber.join(acceptFiber);
    }).pipe(Effect.provide(createBridgeLayer())),
  );
});
