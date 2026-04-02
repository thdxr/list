import "reflect-metadata";
import { NodeHttpServer, NodeRuntime, NodeSocketServer } from "@effect/platform-node";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Layer from "effect/Layer";
import { createServer } from "http";
import { SocketServer } from "effect/unstable/socket/SocketServer";
import { Certificate } from "@opentunnel/core/certificate";
import { Database } from "@opentunnel/core/database";
import { Tunnel } from "@opentunnel/core/tunnel";
import { ApiLive } from "./api/index.ts";
import { ProxyConnection } from "./proxy/proxy.ts";
import { Effect } from "effect";

const CoreLive = Tunnel.layer.pipe(
  Layer.provideMerge(Certificate.layer),
  Layer.provide(Database.Memory),
);

// Create the HTTP server layer
const ServerLive = HttpRouter.serve(ApiLive).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
);

const ProxyLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* SocketServer;
    yield* server.run(ProxyConnection);
  }),
).pipe(Layer.provide(NodeSocketServer.layer({ port: 3001 })));

const AppLive = Layer.mergeAll(ServerLive, ProxyLive).pipe(Layer.provide(CoreLive));

NodeRuntime.runMain(Layer.launch(AppLive));
