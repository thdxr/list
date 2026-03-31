import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/unstable/httpapi";
import { Schema } from "effect";
import { Tunnel } from "@opentunnel/core/tunnel";
import { Certificate } from "@opentunnel/core/certificate";
import { CSR } from "@opentunnel/core/csr";

export class TunnelUnauthorized extends Schema.TaggedErrorClass<TunnelUnauthorized>()(
  "TunnelUnauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class TunnelAuth extends HttpApiMiddleware.Service<TunnelAuth>()("TunnelAuth", {
  security: {
    bearer: HttpApiSecurity.bearer,
  },
  error: TunnelUnauthorized,
}) {}

export const TunnelApi = HttpApiGroup.make("tunnel")
  .add(
    // Anonymous - no auth required
    HttpApiEndpoint.post("create", "/tunnel", {
      success: Schema.Struct({
        tunnel: Tunnel.Info,
        token: Tunnel.Token,
      }),
    }),
    HttpApiEndpoint.post("bind", "/tunnel/:id/bind", {
      params: Schema.Struct({
        id: Tunnel.ID,
      }),
      payload: Schema.Struct({
        csr: CSR.Raw,
      }),
      error: [Tunnel.NotFoundError, CSR.ParseError],
    }).middleware(TunnelAuth),
    HttpApiEndpoint.get("get", "/tunnel/:id", {
      success: Tunnel.Info,
      params: Schema.Struct({
        id: Tunnel.ID,
      }),
      error: [Tunnel.NotFoundError],
    }).middleware(TunnelAuth),
    HttpApiEndpoint.get("certificate", "/tunnel/:id/certificate", {
      success: Certificate.Info,
      params: Schema.Struct({
        id: Tunnel.ID,
      }),
      error: [Tunnel.NotFoundError, Tunnel.NoCertificateError],
    }).middleware(TunnelAuth),
    HttpApiEndpoint.delete("delete", "/tunnel/:id", {
      success: Schema.Void,
      params: Schema.Struct({
        id: Tunnel.ID,
      }),
    }).middleware(TunnelAuth),
  )
  .prefix("/api");
