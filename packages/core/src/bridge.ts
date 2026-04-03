import { Effect, HashMap, Layer, Option, Queue, Ref, Schema, ServiceMap, Scope } from "effect";
import type { Socket } from "effect/unstable/socket";
import * as Net from "node:net";
import { Readable } from "node:stream";
import { getExtensionData, readTlsClientHello } from "read-tls-client-hello";
import { BridgeProtocol } from "./bridge-protocol.ts";
import { Tunnel } from "./tunnel.ts";

const dec = new TextDecoder();

const isJsonFrame = (data: Uint8Array) => {
  let index = 0;

  while (index < data.length) {
    const byte = data[index];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      index++;
      continue;
    }
    return byte === 0x7b;
  }

  return false;
};

type Peek = {
  host: string;
  alpn: string;
  buf: Uint8Array;
};

export namespace Bridge {
  export type SessionState =
    | { type: "detached" }
    | { type: "attaching"; tunnelID: Tunnel.ID }
    | {
        type: "attached";
        tunnelID: Tunnel.ID;
        sessionID: string;
        hostname: string;
        heartbeatMs: number;
        idleTimeoutMs: number;
        writer: (chunk: Uint8Array | string) => Effect.Effect<void, never, never>;
      }
    | { type: "draining"; reason: string }
    | { type: "closed" };

  export type ChannelState = {
    connID: BridgeProtocol.ConnID;
    peer: string;
    sni: string;
    alpn: string;
    toBridge: Queue.Queue<Uint8Array>;
    toProxy: Queue.Queue<Uint8Array>;
    active: boolean;
  };

  export type SessionRegistry = HashMap.HashMap<string, SessionState>;
  export type ChannelRegistry = HashMap.HashMap<BridgeProtocol.ConnID, ChannelState>;

  export class Service extends ServiceMap.Service<
    Service,
    {
      accept: (
        socket: Socket.Socket,
        tunnelID: Tunnel.ID,
      ) => Effect.Effect<void, never, Scope.Scope>;
      proxy: (socket: Net.Socket, peer: string) => Effect.Effect<void, never, Scope.Scope>;
    }
  >()("Bridge") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const tun = yield* Tunnel.Service;
      const ses = yield* Ref.make<SessionRegistry>(HashMap.empty());
      const chs = yield* Ref.make<ChannelRegistry>(HashMap.empty());

      let seq = 1;

      const see = (host: string) => Ref.get(ses).pipe(Effect.map((map) => HashMap.get(map, host)));

      const put = Effect.fn("Bridge.put")((host: string, st: SessionState) =>
        Ref.update(ses, (map) => HashMap.set(map, host, st)),
      );

      const del = Effect.fn("Bridge.del")((host: string) =>
        Ref.update(ses, (map) => HashMap.remove(map, host)),
      );

      const get = (id: BridgeProtocol.ConnID) =>
        Ref.get(chs).pipe(Effect.map((map) => HashMap.get(map, id)));

      const add = Effect.fn("Bridge.add")((ch: ChannelState) =>
        Ref.update(chs, (map) => HashMap.set(map, ch.connID, ch)),
      );

      const cut = Effect.fn("Bridge.cut")((id: BridgeProtocol.ConnID) =>
        Ref.update(chs, (map) => HashMap.remove(map, id)),
      );

      const stop = Effect.fn("Bridge.stop")(function* (ch: ChannelState) {
        ch.active = false;
        yield* cut(ch.connID);
        yield* Queue.shutdown(ch.toBridge);
        yield* Queue.shutdown(ch.toProxy);
      });

      const sweep = Effect.fn("Bridge.sweep")(function* (host: string) {
        const xs = yield* Ref.get(chs).pipe(
          Effect.map((map) => HashMap.toValues(HashMap.filter(map, (ch) => ch.sni === host))),
        );

        yield* Effect.forEach(xs, stop, { discard: true });
      });

      const fork = (fx: Effect.Effect<any, never, never>) => {
        void Effect.runFork(fx);
      };

      const push = Effect.fn("Bridge.push")(function* (
        q: Queue.Queue<Uint8Array>,
        buf: Uint8Array,
      ) {
        const ok = yield* Queue.offer(q, buf);
        if (!ok) {
          return yield* Effect.fail(new Error("queue_closed"));
        }
      });

      const read = Effect.fn("Bridge.read")((sock: Net.Socket) =>
        Effect.tryPromise({
          try: () =>
            new Promise<Buffer>((resolve, reject) => {
              console.log(
                `[DEBUG] read: setting up listeners, paused=${sock.isPaused()}, closed=${sock.closed}`,
              );

              const done = (f: () => void) => {
                sock.pause();
                sock.removeListener("data", onData);
                sock.removeListener("end", onEnd);
                sock.removeListener("close", onClose);
                sock.removeListener("error", onErr);
                f();
              };

              const onData = (buf: Buffer) => {
                console.log(`[DEBUG] read: onData received ${buf.length} bytes`);
                done(() => resolve(buf));
              };
              const onEnd = () => {
                console.log(`[DEBUG] read: onEnd`);
                done(() => reject(new Error("end")));
              };
              const onClose = () => {
                console.log(`[DEBUG] read: onClose`);
                done(() => reject(new Error("close")));
              };
              const onErr = (err: Error) => {
                console.log(`[DEBUG] read: onErr ${err.message}`);
                done(() => reject(err));
              };

              sock.once("data", onData);
              sock.once("end", onEnd);
              sock.once("close", onClose);
              sock.once("error", onErr);

              if (sock.isPaused()) {
                console.log(`[DEBUG] read: resuming socket`);
                sock.resume();
              }
            }),
          catch: (err) => err as Error,
        }),
      );

      const write = Effect.fn("Bridge.write")((sock: Net.Socket, buf: Uint8Array) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              sock.write(Buffer.from(buf), (err) => {
                if (err) reject(err);
                else resolve();
              });
            }),
          catch: (err) => err as Error,
        }),
      );

      const pull = Effect.fn("Bridge.pull")((sock: Net.Socket) =>
        Effect.tryPromise({
          try: () =>
            new Promise<Buffer | null>((resolve, reject) => {
              const xs: Buffer[] = [];
              let len = 0;
              let need: number | undefined;

              const done = (f: () => void) => {
                sock.pause();
                sock.removeListener("data", onData);
                sock.removeListener("end", onEnd);
                sock.removeListener("close", onClose);
                sock.removeListener("error", onErr);
                f();
              };

              const onData = (buf: Buffer) => {
                xs.push(buf);
                len += buf.length;

                const all = Buffer.concat(xs, len);
                if (need === undefined && len >= 5) {
                  if (all[0] !== 0x16) {
                    return done(() => resolve(null));
                  }
                  need = 5 + all.readUInt16BE(3);
                }

                if (need !== undefined && len >= need) {
                  done(() => resolve(all));
                }
              };

              const onEnd = () => done(() => resolve(null));
              const onClose = () => done(() => resolve(null));
              const onErr = (err: Error) => done(() => reject(err));

              sock.on("data", onData);
              sock.once("end", onEnd);
              sock.once("close", onClose);
              sock.once("error", onErr);

              if (sock.isPaused()) {
                sock.resume();
              }
            }),
          catch: (err) => err as Error,
        }).pipe(Effect.orElseSucceed(() => null)),
      );

      const parse = Effect.fn("Bridge.parse")((buf: Buffer) =>
        Effect.tryPromise({
          try: () => readTlsClientHello(Readable.from([buf], { objectMode: false })),
          catch: (err) => err as Error,
        }).pipe(Effect.orElseSucceed(() => null)),
      );

      const peek = Effect.fn("Bridge.peek")(function* (sock: Net.Socket) {
        const raw = yield* pull(sock);
        if (!raw) {
          return Option.none();
        }

        const hello = yield* parse(raw);
        if (!hello) {
          return Option.none();
        }

        const sni = getExtensionData(hello, "sni");
        if (!sni?.serverName) {
          return Option.none();
        }

        const alpn = getExtensionData(hello, "alpn")?.protocols?.[0] ?? "";

        return Option.some<Peek>({
          host: sni.serverName,
          alpn,
          buf: new Uint8Array(raw),
        });
      });

      const accept = Effect.fn("Bridge.accept")(function* (sock: Socket.Socket, id: Tunnel.ID) {
        const ref = yield* Ref.make<SessionState>({
          type: "attaching",
          tunnelID: id,
        });

        const raw = yield* sock.writer;
        const out: (chunk: Uint8Array | string) => Effect.Effect<void, never, never> = (chunk) =>
          raw(chunk).pipe(
            Effect.tap(() => Effect.log("[DEBUG] bridge: wrote to socket")),
            Effect.orDie,
          );
        const say = (msg: BridgeProtocol.ServerControlMessage) => out(JSON.stringify(msg));

        const beat = Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(BridgeProtocol.BridgeTiming.HEARTBEAT_MS);
            yield* say(
              new BridgeProtocol.PingMessage({
                type: "ping",
                time_sent: Date.now(),
              }),
            );
          }),
        );

        const att = Effect.fn("Bridge.att")(function* () {
          yield* tun.fromID(id).pipe(
            Effect.matchEffect({
              onFailure: () =>
                say(
                  new BridgeProtocol.AttachErrorMessage({
                    type: "attach_error",
                    code: BridgeProtocol.BridgeErrorCode.TUNNEL_NOT_BOUND,
                  }),
                ),
              onSuccess: (info) =>
                Effect.gen(function* () {
                  const sid = `sess_${crypto.randomUUID()}`;
                  const st: SessionState = {
                    type: "attached",
                    tunnelID: id,
                    sessionID: sid,
                    hostname: info.hostname,
                    heartbeatMs: BridgeProtocol.BridgeTiming.HEARTBEAT_MS,
                    idleTimeoutMs: BridgeProtocol.BridgeTiming.IDLE_TIMEOUT_MS,
                    writer: out,
                  };

                  yield* Ref.set(ref, st);
                  yield* put(info.hostname, st);
                  yield* say(
                    new BridgeProtocol.AttachedMessage({
                      type: "attached",
                      session: sid,
                      heartbeat_ms: st.heartbeatMs,
                      idle_timeout_ms: st.idleTimeoutMs,
                    }),
                  );
                  yield* Effect.forkScoped(beat);
                }),
            }),
          );
        });

        const png = Effect.fn("Bridge.png")((msg: BridgeProtocol.PingMessage) =>
          say(
            new BridgeProtocol.PongMessage({
              type: "pong",
              time_sent: msg.time_sent,
            }),
          ),
        );

        const drn = Effect.fn("Bridge.drn")(function* (msg: BridgeProtocol.DrainMessage) {
          const cur = yield* Ref.get(ref);
          if (cur.type === "attached") {
            yield* Ref.set(ref, { type: "draining", reason: msg.reason });
          }
        });

        const end = Effect.fn("Bridge.end")(function* (msg: BridgeProtocol.EndMessage) {
          const ch = yield* get(msg.conn);
          if (Option.isSome(ch)) {
            yield* stop(ch.value);
          }
        });

        const rst = Effect.fn("Bridge.rst")(function* (msg: BridgeProtocol.ResetMessage) {
          const ch = yield* get(msg.conn);
          if (Option.isSome(ch)) {
            yield* stop(ch.value);
          }
        });

        const ctl = Effect.fn("Bridge.ctl")(function* (data: string | Uint8Array) {
          const text = typeof data === "string" ? data : dec.decode(data);
          const json = yield* Effect.try({
            try: () => JSON.parse(text),
            catch: () => null,
          }).pipe(Effect.orElseSucceed(() => null));

          if (!json) {
            yield* Effect.logWarning("Invalid control frame received");
            return;
          }

          const msg = yield* Schema.decodeUnknownEffect(BridgeProtocol.ControlMessage)(json).pipe(
            Effect.orElseSucceed(() => null),
          );

          if (!msg) {
            yield* Effect.logWarning("Invalid control message received");
            return;
          }

          switch (msg.type) {
            case "attach":
              yield* att();
              break;
            case "ping":
              yield* png(msg);
              break;
            case "pong":
              break;
            case "drain":
              yield* drn(msg);
              break;
            case "end":
              yield* end(msg);
              break;
            case "reset":
              yield* rst(msg);
              break;
            case "attached":
            case "attach_error":
            case "open":
              yield* Effect.logWarning(`Unexpected control message: ${msg.type}`);
              break;
          }
        });

        const bin = Effect.fn("Bridge.bin")(function* (data: Uint8Array) {
          yield* Effect.log(`[DEBUG] bin: received ${data.length} bytes from bridge`);

          const frame = BridgeProtocol.parseDataFrame(data);
          if (!frame) {
            yield* Effect.logWarning("Invalid data frame received");
            return;
          }

          yield* Effect.log(
            `[DEBUG] bin: parsed frame conn=${frame.conn}, payload=${frame.payload.length} bytes`,
          );

          const ch = yield* get(frame.conn);
          if (Option.isNone(ch) || !ch.value.active) {
            yield* Effect.logWarning(`Data received for unknown channel: ${frame.conn}`);
            return;
          }

          yield* Effect.log(`[DEBUG] bin: offering to toProxy queue for conn ${frame.conn}`);
          const ok = yield* Queue.offer(ch.value.toProxy, frame.payload);
          yield* Effect.log(`[DEBUG] bin: queue offer result: ${ok}`);
          if (!ok) {
            yield* stop(ch.value);
          }
        });

        const done = Effect.fn("Bridge.done")(function* () {
          const cur = yield* Ref.get(ref);
          if (cur.type === "attached") {
            yield* del(cur.hostname);
            yield* sweep(cur.hostname);
          }
          yield* Ref.set(ref, { type: "closed" });
          yield* Effect.log(`Bridge session closed for tunnel ${id}`);
        });

        yield* sock
          .runRaw((data) => (typeof data === "string" || isJsonFrame(data) ? ctl(data) : bin(data)))
          .pipe(
            Effect.catchTag("SocketError", () => Effect.void),
            Effect.orDie,
            Effect.ensuring(done()),
          );
      });

      const proxy = Effect.fn("Bridge.proxy")(function* (sock: Net.Socket, peer: string) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.log(`Proxying public connection from ${peer}`);

            const seen = yield* peek(sock);
            if (Option.isNone(seen)) {
              yield* Effect.logWarning("Failed to read ClientHello, closing connection");
              sock.destroy();
              return;
            }

            const { host, alpn, buf } = seen.value;
            yield* Effect.log(`SNI: ${host}, ALPN: ${alpn}`);
            yield* Effect.log(`[DEBUG] About to call see(${host})`);

            const hit = yield* see(host);
            yield* Effect.log(`[DEBUG] see() returned: ${Option.isSome(hit) ? "Some" : "None"}`);

            if (Option.isNone(hit)) {
              yield* Effect.logWarning(`No active bridge session for ${host}`);
              sock.destroy();
              return;
            }

            const st = hit.value;
            yield* Effect.log(`[DEBUG] Session type: ${st.type}`);

            if (st.type !== "attached") {
              yield* Effect.logWarning(`Bridge session not attached for ${host}`);
              sock.destroy();
              return;
            }

            yield* Effect.log(`[DEBUG] Creating queues...`);
            const id = seq++ as BridgeProtocol.ConnID;
            const toBridge = yield* Queue.unbounded<Uint8Array>();
            const toProxy = yield* Queue.unbounded<Uint8Array>();
            yield* Effect.log(`[DEBUG] Queues created`);

            const ch: ChannelState = {
              connID: id,
              peer,
              sni: host,
              alpn,
              toBridge,
              toProxy,
              active: true,
            };

            const end = new BridgeProtocol.EndMessage({ type: "end", conn: id });
            const rst = new BridgeProtocol.ResetMessage({
              type: "reset",
              conn: id,
              code: BridgeProtocol.BridgeErrorCode.CLIENT_IO_ERROR,
            });

            yield* add(ch);
            yield* Effect.log(`[DEBUG] Channel added with ID ${id}`);

            sock.once("close", () => {
              if (!ch.active) return;
              ch.active = false;
              fork(st.writer(JSON.stringify(end)));
            });

            sock.once("error", () => {
              if (!ch.active) return;
              ch.active = false;
              fork(st.writer(JSON.stringify(rst)));
            });

            yield* Effect.log(`[DEBUG] About to send open message to bridge`);
            yield* st.writer(
              JSON.stringify(
                new BridgeProtocol.OpenMessage({
                  type: "open",
                  conn: id,
                  peer,
                  sni: host,
                  alpn,
                }),
              ),
            );
            yield* Effect.log(`[DEBUG] Open message sent`);

            yield* Effect.log(`[DEBUG] About to offer initial buffer to queue`);
            yield* Queue.offer(toBridge, buf);
            yield* Effect.log(`[DEBUG] Buffer offered, entering data race`);

            const src = Effect.forever(
              read(sock).pipe(
                Effect.tap(() => Effect.log("[DEBUG] src: read from socket")),
                Effect.flatMap((data) => push(toBridge, new Uint8Array(data))),
              ),
            ).pipe(Effect.orElseSucceed(() => undefined));

            const up = Effect.forever(
              Queue.take(toBridge).pipe(
                Effect.tap(() => Effect.log("[DEBUG] up: took from toBridge queue")),
                Effect.tap((data) =>
                  Effect.log(`[DEBUG] up: writing ${data.length} bytes via st.writer`),
                ),
                Effect.flatMap((data) => st.writer(BridgeProtocol.buildDataFrame(id, data))),
                Effect.tap(() => Effect.log("[DEBUG] up: st.writer completed")),
              ),
            ).pipe(Effect.orElseSucceed(() => undefined));

            const down = Effect.forever(
              Queue.take(toProxy).pipe(
                Effect.tap((data) =>
                  Effect.log(`[DEBUG] down: took ${data.length} bytes from toProxy`),
                ),
                Effect.flatMap((data) => write(sock, data)),
                Effect.tap(() => Effect.log("[DEBUG] down: wrote to socket")),
              ),
            ).pipe(Effect.orElseSucceed(() => undefined));

            const done = stop(ch).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (!sock.closed) {
                    sock.destroy();
                  }
                }),
              ),
            );

            yield* Effect.log("[DEBUG] Starting data race (src, up, down)");
            yield* Effect.race(src, Effect.race(up, down)).pipe(Effect.ensuring(done));
            yield* Effect.log("[DEBUG] Data race completed");
          }),
        );
      });

      return Service.of({
        accept,
        proxy,
      });
    }),
  );
}
