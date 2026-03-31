import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api } from "../definition/index.js";
import { Layer } from "effect";
import { AcmeApi } from "./acme.ts";
import { TunnelApi, TunnelAuthLive } from "./tunnel.ts";

export const ApiLive = HttpApiBuilder.layer(Api, {
  openapiPath: "/docs/openapi.json",
})
  .pipe(Layer.provide(AcmeApi))
  .pipe(Layer.provide(TunnelApi))
  .pipe(Layer.provide(TunnelAuthLive));
