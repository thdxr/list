import "reflect-metadata";
import {
  NodeHttpServer,
  NodeRuntime,
  NodeSocketServer,
  NodeFileSystem,
} from "@effect/platform-node";
import os from "os";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Layer from "effect/Layer";
import { createServer } from "http";
import { SocketServer } from "effect/unstable/socket/SocketServer";
import { Bridge } from "@opentunnel/core/bridge";
import { Certificate } from "@opentunnel/core/certificate";
import { Tunnel } from "@opentunnel/core/tunnel";
import { ApiLive } from "./api/index.ts";
import { ProxyConnection } from "./proxy/proxy.ts";
import { Effect, Path, pipe } from "effect";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { DatabaseFile } from "@opentunnel/core/database-file";

const OtelLive = NodeSdk.layer(() => ({
  resource: {
    serviceName: "opentunnel-server",
    serviceVersion: "0.1.0",
    attributes: {
      "deployment.environment": "development",
      username: os.userInfo().username,
    },
  },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: "http://localhost:4318/v1/traces", // Tempo OTLP HTTP endpoint
    }),
  ),
}));

const CoreLive = pipe(
  Bridge.layer,
  Layer.provideMerge(Tunnel.layer),
  Layer.provideMerge(Certificate.layer),
  Layer.provideMerge(DatabaseFile.layer),
  Layer.provide(Path.layer),
  Layer.provide(NodeFileSystem.layer),
);

const ServerLive = pipe(
  ApiLive,
  HttpRouter.serve,
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
);

const ProxyLive = pipe(
  Effect.gen(function* () {
    const server = yield* SocketServer;
    yield* server.run(ProxyConnection);
  }),
  Layer.effectDiscard,
  Layer.provide(NodeSocketServer.layer({ port: 3001 })),
);

// Combine all layers with OpenTelemetry
// IMPORTANT: OtelLive must be provided BEFORE CoreLive so that Effect.fn spans
// in Bridge, Tunnel, Certificate, and Database services use the OpenTelemetry tracer
const AppLive = pipe(
  ServerLive,
  Layer.merge(ProxyLive),
  Layer.provide(CoreLive),
  Layer.provide(OtelLive),
);

NodeRuntime.runMain(Layer.launch(AppLive));
