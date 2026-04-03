- This codebase uses Effect v4 which is not yet documented yet
- Do not rely on your own knowledge of Effect (e.g., don't use `Effect.gen` if the codebase uses a different pattern found in effect-smol)
- When working on Effect-related code, use the explore agent to scan ~/dev/external/effect-smol
- Use the explore agent to find relevant patterns, types, and implementations in the Effect codebase (e.g., search for similar services, layers, or effect composition patterns)
- Copy and adapt patterns found in the external repository rather than using what you know about Effect v3 or earlier versions (e.g., use the type signatures and helper functions found in effect-smol, not what you remember from Effect v3 docs)
- Always verify your implementation against the patterns found in the effect-smol repository (e.g., compare your service definition to similar ones in the external repo)
- This codebase uses the `vp` tool for development
- When adding packages with `vp add`, always use `--save-catalog` to add to the workspace catalog instead of package.json
- The `.npmrc` file has `save-exact=true` configured so packages are pinned by default
- Run commands in the most granular package you are testing, not at the root (e.g., `cd packages/core && vp test` instead of `vp test` from the root)
- Common commands: `vp check` (run format, lint, and type checks), `vp lint` (lint code), `vp fmt` (format code), `vp test` (run tests), `vp build` (build for production)

## OpenTelemetry & Tracing

The server has OpenTelemetry wired up for local trace visualization with Jaeger:

**Start Jaeger:**

```bash
docker-compose -f docker-compose.telemetry.yml up
```

**View traces:** http://localhost:16686

**Configuration:** `packages/server/src/index.ts`

- Uses `@effect/opentelemetry` NodeSdk
- Sends traces via OTLP HTTP to Jaeger at `localhost:4318`
- Service name: `opentunnel-server`

**Add custom spans:**

```typescript
myEffect.pipe(Effect.withSpan("my-operation"));
```

See `TELEMETRY.md` for full documentation.

## Effect Layer Composition Tips

When composing Effect layers, use the `pipe` pattern from `effect` (not `fp-ts`):

```typescript
import { pipe } from "effect";
import * as Layer from "effect/Layer";

// Build from the layer with most dependencies to the base layer
const CoreLive = pipe(
  Bridge.layer, // Layer that depends on others
  Layer.provideMerge(Tunnel.layer), // Provide its dependencies
  Layer.provideMerge(Certificate.layer),
  Layer.provideMerge(Database.Memory), // Base layer last
);

// Alternative: Layer.merge for combining peer layers
const AppLive = pipe(ServerLive, Layer.merge(ProxyLive), Layer.provide(CoreLive));
```

Key points:

- Import `pipe` from `effect` (not `fp-ts/function`)
- Use `Layer.provideMerge` to provide dependencies to a layer
- Order matters: start with the most dependent layer, end with base layers
- `Layer.merge` combines two layers side-by-side (good for combining HTTP server + socket server)
- Avoid `Layer.mergeAll` with complex pipe chains - prefer nested `Layer.merge` calls
