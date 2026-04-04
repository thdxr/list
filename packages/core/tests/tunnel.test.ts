import { Effect, Layer, Option, pipe } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "./effect-test.ts";
import { Certificate } from "../src/certificate.ts";
import { CSR } from "../src/csr.ts";
import { Database } from "../src/database.ts";
import { Tunnel } from "../src/tunnel.ts";

const issuedCertificateID = Certificate.ID.makeUnsafe("issued-certificate-id");
const readyCertificate = new Certificate.Info({
  id: issuedCertificateID,
  state: new Certificate.StateReady({
    type: "ready",
    certificate: "cert-pem",
    chain: "chain-pem",
    expiry: "2099-01-01T00:00:00.000Z",
  }),
});

type CertificateMethods = {
  issue: (csr: CSR.Info) => Effect.Effect<Certificate.ID>;
  fromToken: (token: Certificate.Token) => Effect.Effect<Option.Option<Certificate.Info>>;
  get: (id: Certificate.ID) => Effect.Effect<Option.Option<Certificate.Info>>;
};

const createCertificateService = (overrides?: Partial<CertificateMethods>) =>
  Certificate.Service.of({
    issue: () => Effect.succeed(issuedCertificateID),
    fromToken: () => Effect.succeed(Option.none()),
    get: (id) =>
      Effect.succeed(id === issuedCertificateID ? Option.some(readyCertificate) : Option.none()),
    ...overrides,
  });

const createTunnelLayer = (certificateOverrides?: Partial<CertificateMethods>) =>
  pipe(
    Tunnel.layer,
    Layer.provideMerge(Database.Memory),
    Layer.provideMerge(
      Layer.succeed(Certificate.Service, createCertificateService(certificateOverrides)),
    ),
  );

const makeCSR = (hostname: string): CSR.Info => ({
  hostname: CSR.Hostname.makeUnsafe(hostname),
  raw: CSR.Raw.makeUnsafe(
    "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----",
  ),
  certificate: {} as never,
});

describe("Tunnel", () => {
  it.effect("create persists a tunnel and authenticates the returned token", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;

      const created = yield* tunnel.create();
      const loaded = yield* tunnel.fromID(created.tunnel.id);
      const authed = yield* tunnel.auth(created.tunnel.id, created.token);

      expect(loaded.id).toBe(created.tunnel.id);
      expect(loaded.hostname).toBe(created.tunnel.hostname);
      expect(loaded.state).toBe("offline");
      expect(created.token.length).toBeGreaterThan(0);
      expect(authed).toBe(true);
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("auth returns false when the token does not belong to the tunnel", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const created = yield* tunnel.create();

      const authed = yield* tunnel.auth(
        created.tunnel.id,
        Tunnel.Token.makeUnsafe(`token-${crypto.randomUUID()}`),
      );

      expect(authed).toBe(false);
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("fromID returns NotFound for a missing tunnel", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const error = yield* Effect.flip(tunnel.fromID(Tunnel.ID.makeUnsafe(crypto.randomUUID())));

      expect(error._tag).toBe("NotFound");
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("certficiate returns NoCertificate when a tunnel has not been bound", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const created = yield* tunnel.create();

      const error = yield* Effect.flip(tunnel.certficiate(created.tunnel.id));

      expect(error._tag).toBe("NoCertificate");
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("certficiate returns NoCertificate when the certificate record is missing", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const db = yield* Database.Service;
      const created = yield* tunnel.create();
      const missingCertificateID = Certificate.ID.makeUnsafe("missing-certificate-id");

      yield* db.tunnel.update(
        new Tunnel.Info({
          id: created.tunnel.id,
          hostname: created.tunnel.hostname,
          state: created.tunnel.state,
          certificateID: missingCertificateID,
        }),
      );

      const error = yield* Effect.flip(tunnel.certficiate(created.tunnel.id));

      expect(error._tag).toBe("NoCertificate");
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("certficiate returns the bound certificate", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const db = yield* Database.Service;
      const created = yield* tunnel.create();

      yield* db.tunnel.update(
        new Tunnel.Info({
          id: created.tunnel.id,
          hostname: created.tunnel.hostname,
          state: created.tunnel.state,
          certificateID: issuedCertificateID,
        }),
      );

      const certificate = yield* tunnel.certficiate(created.tunnel.id);

      expect(certificate.id).toBe(issuedCertificateID);
      expect(certificate.state.type).toBe("ready");
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("bind returns NotFound when the tunnel does not exist", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const error = yield* Effect.flip(
        tunnel.bind(Tunnel.ID.makeUnsafe(crypto.randomUUID()), makeCSR("missing.example.com")),
      );

      expect(error._tag).toBe("NotFound");
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("bind rejects CSRs whose hostname does not match the tunnel hostname", () =>
    Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const created = yield* tunnel.create();

      const error = yield* Effect.flip(
        tunnel.bind(created.tunnel.id, makeCSR("wrong.example.com")),
      );

      expect(error._tag).toBe("InvalidHostname");
      if (error._tag !== "InvalidHostname") {
        throw new Error(`expected InvalidHostname, got ${error._tag}`);
      }

      expect(error.expected).toBe(created.tunnel.hostname);
      expect(error.provided).toBe("wrong.example.com");
    }).pipe(Effect.provide(createTunnelLayer())),
  );

  it.effect("bind issues a certificate and stores the resulting certificate ID", () => {
    const issued: Array<CSR.Info> = [];

    return Effect.gen(function* () {
      const tunnel = yield* Tunnel.Service;
      const created = yield* tunnel.create();
      const csr = makeCSR(created.tunnel.hostname);

      yield* tunnel.bind(created.tunnel.id, csr);

      const updated = yield* tunnel.fromID(created.tunnel.id);

      expect(issued).toEqual([csr]);
      expect(updated.certificateID).toBe(issuedCertificateID);
    }).pipe(
      Effect.provide(
        createTunnelLayer({
          issue: (csr) =>
            Effect.sync(() => {
              issued.push(csr);
              return issuedCertificateID;
            }),
        }),
      ),
    );
  });
});
