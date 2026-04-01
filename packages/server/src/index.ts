import "reflect-metadata";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Layer from "effect/Layer";
import { createServer } from "http";
import { Certificate } from "@opentunnel/core/certificate";
import { Database } from "@opentunnel/core/database";
import { Tunnel } from "@opentunnel/core/tunnel";
import { ApiLive } from "./api/index.ts";

// Create the server layer
const ServerLive = HttpRouter.serve(ApiLive)
  .pipe(Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 3000 })))
  .pipe(
    Layer.provide(Tunnel.layer),
    Layer.provide(Certificate.layer),
    Layer.provide(Database.Memory),
  );

// Run the server
NodeRuntime.runMain(Layer.launch(ServerLive));
