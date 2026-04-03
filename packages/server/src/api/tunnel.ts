import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Api } from "../definition/index.ts";
import { Effect, Layer } from "effect";
import { Tunnel } from "@opentunnel/core/tunnel";
import { Bridge } from "@opentunnel/core/bridge";
import { CSR } from "@opentunnel/core/csr";
import { TunnelAuth } from "../definition/tunnel.ts";

// Server-side middleware implementation - temporarily bypassing auth
export const TunnelAuthLive = Layer.effect(
  TunnelAuth,
  Effect.sync(() => {
    return TunnelAuth.of({
      bearer: Effect.fn(function* (httpEffect) {
        // Auth temporarily disabled - always allow
        return yield* httpEffect;
      }),
    });
  }),
);

// API handlers
export const TunnelApi = HttpApiBuilder.group(Api, "tunnel", (handlers) =>
  Effect.gen(function* () {
    const tunnel = yield* Tunnel.Service;
    const bridge = yield* Bridge.Service;

    return handlers
      .handle(
        "create",
        Effect.fn("API.tunnel.create")(function* (_req) {
          const created = yield* tunnel.create();
          yield* Effect.log(created);
          return created;
        }),
      )
      .handle(
        "certificate",
        Effect.fn("API.tunnel.certificate")(function* (req) {
          const cert = yield* tunnel.certficiate(req.params.id);
          return cert;
        }),
      )
      .handle(
        "bind",
        Effect.fn("API.tunnel.bind")(function* (req) {
          const parsed = yield* CSR.parse(req.payload.csr);
          yield* tunnel.bind(req.params.id, parsed);
        }),
      )
      .handle(
        "delete",
        Effect.fn("API.tunnel.delete")(function* (_req) {
          // TODO: implement delete
        }),
      )
      .handle(
        "get",
        Effect.fn("API.tunnel.get")(function* (req) {
          const info = yield* tunnel.fromID(req.params.id);
          return info;
        }),
      )
      .handle(
        "connect",
        Effect.fn("API.tunnel.connect")(function* (req) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const socket = yield* request.upgrade;
          yield* bridge.accept(socket, req.params.id);
          return HttpServerResponse.empty();
        }),
      );
  }),
);
