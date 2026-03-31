import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api } from "../definition/index.ts";
import { Effect, Option } from "effect";
import { Certificate } from "@opentunnel/core/certificate";

export const AcmeApi = HttpApiBuilder.group(Api, "acme", (route) =>
  route.handle(
    "challenge",
    Effect.fn(function* (req) {
      const certificate = yield* Certificate.Service;
      const info = yield* certificate.fromToken(req.params.token);
      yield* Effect.log("ACME challenge:", info, req.params.token);
      if (Option.isNone(info)) {
        return "failed: certificate not found for " + req.params.token;
      }
      if (info.value.state.type !== "challenge") {
        return "failed: not a challenge";
      }
      return info.value.state.key;
    }),
  ),
);
