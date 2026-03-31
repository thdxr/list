import { ServiceMap, Layer } from "effect";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Api } from "../definition/index.ts";

export class ApiClient extends ServiceMap.Service<ApiClient, HttpApiClient.ForApi<typeof Api>>()(
  "app/ApiClient",
) {
  static readonly layer = Layer.effect(
    ApiClient,
    HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost:3000"))),
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
