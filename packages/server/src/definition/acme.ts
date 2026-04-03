import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { Certificate } from "@opentunnel/core/certificate";

export const AcmeApi = HttpApiGroup.make("acme")
  .add(
    HttpApiEndpoint.get("challenge", "/:token", {
      success: Schema.String.pipe(HttpApiSchema.asText()),
      params: Schema.Struct({
        token: Certificate.Token,
      }),
    }),
  )
  .prefix("/.well-known/acme-challenge");
