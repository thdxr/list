import { Effect } from "effect";
import { afterEach, beforeAll, describe, expect, vi } from "vite-plus/test";
import { it } from "./effect-test.ts";

const acmeClientMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@peculiar/acme-client", () => ({
  ApiClient: {
    create: acmeClientMocks.create,
  },
}));

let AcmeModule: typeof import("../src/acme.ts");

const createRawClient = async (overrides?: Record<string, unknown>) => {
  const accountKey = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  return {
    accountKey,
    newAccount: vi.fn().mockResolvedValue({ account: true }),
    newOrder: vi.fn().mockResolvedValue({
      content: {
        authorizations: ["https://acme.test/authz/1"],
        finalize: "https://acme.test/finalize/1",
        status: "pending",
      },
      headers: { location: "https://acme.test/order/1" },
    }),
    getAuthorization: vi.fn().mockResolvedValue({
      content: {
        status: "valid",
        challenges: [{ type: "http-01", token: "token", url: "https://acme.test/challenge/1" }],
      },
    }),
    getChallenge: vi.fn().mockResolvedValue({
      content: { status: "processing" },
      headers: { link: ['<https://acme.test/authz/1>;rel="up"'] },
    }),
    finalize: vi.fn().mockResolvedValue({ content: { status: "valid" } }),
    getOrder: vi.fn().mockResolvedValue({
      content: { status: "valid", certificate: "https://acme.test/cert/1" },
    }),
    getCertificate: vi.fn().mockResolvedValue({ content: [new Uint8Array([1, 2, 3]).buffer] }),
    ...overrides,
  };
};

beforeAll(async () => {
  AcmeModule = await import("../src/acme.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
  acmeClientMocks.create.mockReset();
});

describe("Acme", () => {
  it.effect("creates a wrapped client and delegates every ACME operation", () =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => createRawClient(),
        catch: (cause) => cause as Error,
      });

      acmeClientMocks.create.mockResolvedValue(raw);

      const factory = yield* AcmeModule.Acme.Factory;
      const client = yield* factory.create("https://acme.test/directory");

      yield* client.newAccount({
        contact: ["mailto:test@example.com"],
        termsOfServiceAgreed: true,
      });
      yield* client.newOrder({ identifiers: [{ type: "dns", value: "demo.example.com" }] });
      yield* client.getAuthorization("https://acme.test/authz/1");
      yield* client.getChallenge("https://acme.test/challenge/1", "POST");
      yield* client.finalize("https://acme.test/finalize/1", { csr: "csr" });
      yield* client.getOrder("https://acme.test/order/1");
      yield* client.getCertificate("https://acme.test/cert/1");

      expect(acmeClientMocks.create).toHaveBeenCalledWith(
        expect.anything(),
        "https://acme.test/directory",
        {
          fetch,
          crypto,
        },
      );
      expect(raw.newAccount).toHaveBeenCalledWith({
        contact: ["mailto:test@example.com"],
        termsOfServiceAgreed: true,
      });
      expect(raw.newOrder).toHaveBeenCalledWith({
        identifiers: [{ type: "dns", value: "demo.example.com" }],
      });
      expect(raw.getAuthorization).toHaveBeenCalledWith("https://acme.test/authz/1");
      expect(raw.getChallenge).toHaveBeenCalledWith("https://acme.test/challenge/1", "POST");
      expect(raw.finalize).toHaveBeenCalledWith("https://acme.test/finalize/1", { csr: "csr" });
      expect(raw.getOrder).toHaveBeenCalledWith("https://acme.test/order/1");
      expect(raw.getCertificate).toHaveBeenCalledWith("https://acme.test/cert/1");
      expect(client.key).toBe(raw.accountKey);
      expect(client.thumbprint.length).toBeGreaterThan(0);
    }),
  );

  it.effect("wraps ApiClient.create failures in an AcmeError", () =>
    Effect.gen(function* () {
      acmeClientMocks.create.mockRejectedValueOnce(new Error("boom"));

      const factory = yield* AcmeModule.Acme.Factory;
      const error = yield* Effect.flip(factory.create("https://acme.test/directory"));

      expect(error._tag).toBe("AcmeError");
      expect(error.message).toBe("Create ACME client");
    }),
  );

  it.effect("wraps delegated method failures in an AcmeError", () =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () =>
          createRawClient({
            getOrder: vi.fn().mockRejectedValue(new Error("order failed")),
          }),
        catch: (cause) => cause as Error,
      });

      acmeClientMocks.create.mockResolvedValue(raw);

      const factory = yield* AcmeModule.Acme.Factory;
      const client = yield* factory.create("https://acme.test/directory");
      const error = yield* Effect.flip(client.getOrder("https://acme.test/order/1"));

      expect(error._tag).toBe("AcmeError");
      expect(error.message).toBe("Get order");
    }),
  );

  it.effect("wraps thumbprint computation failures in an AcmeError", () =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => createRawClient(),
        catch: (cause) => cause as Error,
      });

      acmeClientMocks.create.mockResolvedValue(raw);
      vi.spyOn(crypto.subtle, "exportKey").mockRejectedValueOnce(new Error("cannot export"));

      const factory = yield* AcmeModule.Acme.Factory;
      const error = yield* Effect.flip(factory.create("https://acme.test/directory"));

      expect(error._tag).toBe("AcmeError");
      expect(error.message).toBe("Compute thumbprint");
    }),
  );
});
