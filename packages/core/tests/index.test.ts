import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import * as core from "../src/index.ts";

describe("index", () => {
  it("re-exports the public core modules", () => {
    expect(core.Acme).toBeDefined();
    expect(core.Bridge).toBeDefined();
    expect(core.BridgeProtocol).toBeDefined();
    expect(core.Certificate).toBeDefined();
    expect(core.AppConfig).toBeDefined();
    expect(core.CSR).toBeDefined();
    expect(core.Database).toBeDefined();
    expect(core.Tunnel).toBeDefined();
  });
});
