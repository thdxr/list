import { Effect, Layer, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { Acme } from "../src/acme.ts";
import { Certificate } from "../src/certificate.ts";
import { CSR } from "../src/csr.ts";
import { Database } from "../src/database.ts";

const testCSR: CSR.Info = {
  hostname: CSR.Hostname.makeUnsafe("test.example.com"),
  raw: CSR.Raw.makeUnsafe(
    "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----",
  ),
  certificate: {} as never,
};

const fakeCert = new Uint8Array([0x30, 0x82, 0x01, 0x00, 0xde, 0xad]).buffer;

const expectSome = <A>(option: Option.Option<A>, message: string): A => {
  if (Option.isNone(option)) {
    throw new Error(message);
  }

  return option.value;
};

const waitForBackground = () =>
  TestClock.withLive(
    Effect.tryPromise({
      try: () => new Promise<void>((resolve) => setImmediate(resolve)),
      catch: (cause) => cause as Error,
    }),
  );

const createFakeClient = (overrides?: Partial<Acme.Client>): Acme.Client => {
  const defaults: Acme.Client = {
    newAccount: () => Effect.succeed({}),
    newOrder: () =>
      Effect.succeed({
        content: {
          authorizations: ["https://acme.test/authz/1"],
          finalize: "https://acme.test/finalize/1",
          status: "pending",
        },
        headers: { location: "https://acme.test/order/1" },
      }),
    getAuthorization: () =>
      Effect.succeed({
        content: {
          status: "valid",
          challenges: [
            { type: "http-01", token: "test-token-123", url: "https://acme.test/chall/1" },
          ],
        },
      }),
    getChallenge: () =>
      Effect.succeed({
        content: { status: "processing" },
        headers: { link: ['<https://acme.test/authz/1>;rel="up"'] },
      }),
    finalize: () => Effect.succeed({ content: { status: "valid" } }),
    getOrder: () =>
      Effect.succeed({
        content: { status: "valid", certificate: "https://acme.test/cert/1" },
      }),
    getCertificate: () => Effect.succeed({ content: [fakeCert] }),
    key: {} as CryptoKey,
    thumbprint: "test-thumbprint",
  };

  return { ...defaults, ...overrides };
};

const createTestLayer = (clientOverrides?: Partial<Acme.Client>) =>
  Layer.provide(
    Certificate.layer,
    Layer.mergeAll(
      Database.Memory,
      Layer.succeed(
        Acme.Factory,
        Acme.Factory.of({
          create: () => Effect.succeed(createFakeClient(clientOverrides)),
        }),
      ),
    ),
  );

describe("Certificate", () => {
  it.effect("issue returns an ID and persists certificate state", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);
      const info = yield* cert.get(id);

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(Option.isSome(info)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fromToken returns none for unknown token", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const result = yield* cert.fromToken(Certificate.Token.makeUnsafe("missing-token"));
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("completes the full ACME flow with a ready certificate", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("ready");
      if (found.state.type !== "ready") {
        throw new Error(`expected ready state, got ${found.state.type}`);
      }

      expect(found.state.certificate).toContain("BEGIN CERTIFICATE");
      expect(found.state.chain).toContain("BEGIN CERTIFICATE");
      expect(found.state.expiry).toBe("TODO");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fromToken exposes the challenge while authorization is pending", () => {
    let authorizationCalls = 0;

    return Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      yield* cert.issue(testCSR);

      yield* waitForBackground();

      const challenge = yield* cert.fromToken(Certificate.Token.makeUnsafe("test-token-123"));
      const challengeInfo = expectSome(challenge, "expected challenge lookup to succeed");

      expect(challengeInfo.state.type).toBe("challenge");
      if (challengeInfo.state.type !== "challenge") {
        throw new Error(`expected challenge state, got ${challengeInfo.state.type}`);
      }

      expect(challengeInfo.state.token).toBe("test-token-123");
      expect(challengeInfo.state.key).toBe("test-token-123.test-thumbprint");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getAuthorization: () => {
            authorizationCalls += 1;

            if (authorizationCalls === 1) {
              return Effect.succeed({
                content: {
                  status: "pending",
                  challenges: [
                    {
                      type: "http-01",
                      token: "test-token-123",
                      url: "https://acme.test/chall/1",
                    },
                  ],
                },
              });
            }

            if (authorizationCalls === 2) {
              return Effect.succeed({
                content: {
                  status: "pending",
                },
              });
            }

            return Effect.succeed({
              content: {
                status: "pending",
              },
            });
          },
        }),
      ),
    );
  });

  it.effect("fromToken is cleared after a successful issuance", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;

      yield* cert.issue(testCSR);
      yield* waitForBackground();

      const cleared = yield* cert.fromToken(Certificate.Token.makeUnsafe("test-token-123"));
      expect(Option.isNone(cleared)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("records a failed state when the order authorization has no HTTP-01 challenge", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("No HTTP-01 challenge found");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getAuthorization: () =>
            Effect.succeed({
              content: {
                status: "pending",
                challenges: [],
              },
            }),
        }),
      ),
    ),
  );

  it.effect("records a failed state when the challenge response omits the authorization link", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("Cannot parse authorization URL from challenge response");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getChallenge: () =>
            Effect.succeed({
              content: { status: "processing" },
              headers: { link: null },
            }),
        }),
      ),
    ),
  );

  it.effect("records a failed state when authorization never becomes valid", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("Authorization status is invalid, expected valid");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getAuthorization: (() => {
            let calls = 0;

            return () => {
              calls += 1;
              if (calls === 1) {
                return Effect.succeed({
                  content: {
                    status: "pending",
                    challenges: [
                      {
                        type: "http-01",
                        token: "test-token-123",
                        url: "https://acme.test/chall/1",
                      },
                    ],
                  },
                });
              }

              return Effect.succeed({
                content: {
                  status: "invalid",
                },
              });
            };
          })(),
        }),
      ),
    ),
  );

  it.effect("records a failed state when the order omits a finalize URL", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("Order has no finalize URL");
    }).pipe(
      Effect.provide(
        createTestLayer({
          newOrder: () =>
            Effect.succeed({
              content: {
                authorizations: ["https://acme.test/authz/1"],
                status: "pending",
              },
              headers: { location: "https://acme.test/order/1" },
            }),
        }),
      ),
    ),
  );

  it.effect("records a failed state when newOrder omits the order location", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("Cannot get order URL from newOrder response");
    }).pipe(
      Effect.provide(
        createTestLayer({
          newOrder: () =>
            Effect.succeed({
              content: {
                authorizations: ["https://acme.test/authz/1"],
                finalize: "https://acme.test/finalize/1",
                status: "pending",
              },
              headers: { location: null },
            }),
        }),
      ),
    ),
  );

  it.effect("records a failed state when the finalized order never becomes valid", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("Order status is invalid, expected valid");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getOrder: () =>
            Effect.succeed({
              content: {
                status: "invalid",
              },
            }),
        }),
      ),
    ),
  );

  it.effect("records a failed state when a valid order omits the certificate URL", () =>
    Effect.gen(function* () {
      const cert = yield* Certificate.Service;
      const id = yield* cert.issue(testCSR);

      yield* waitForBackground();

      const info = yield* cert.get(id);
      const found = expectSome(info, `expected certificate ${id} to exist`);
      expect(found.state.type).toBe("failed");
      if (found.state.type !== "failed") {
        throw new Error(`expected failed state, got ${found.state.type}`);
      }

      expect(found.state.reason).toBe("Order is valid but no certificate URL found");
    }).pipe(
      Effect.provide(
        createTestLayer({
          getOrder: () =>
            Effect.succeed({
              content: {
                status: "valid",
              },
            }),
        }),
      ),
    ),
  );
});
