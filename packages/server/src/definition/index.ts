import { HttpApi } from "effect/unstable/httpapi";
import { AcmeApi } from "./acme.js";
import { TunnelApi } from "./tunnel.js";

export const Api = HttpApi.make("opentunnel").add(AcmeApi).add(TunnelApi);
