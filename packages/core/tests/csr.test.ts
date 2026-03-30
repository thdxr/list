import "reflect-metadata";
import { Effect, Schema } from "effect";
import { expect, test, describe } from "vite-plus/test";
import { CSR } from "../src/csr.ts";

// Valid CSR PEM generated with OpenSSL:
// openssl req -new -newkey rsa:2048 -nodes -keyout test.key -out test.csr -subj "/CN=test.example.com"
const validCSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICYDCCAUgCAQAwGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKMYU27v3aIQV4dXN0Ax4wPyizkRS0Tw
zCGAb0OrKS/rfG7d59loFwQYn8k7TCR80vPrZ73DvF7w182bfDn8hT1+O05PQzbe
f9A+bLBPRQsguz3/0XVxHzkPKSUugFplF0gmtqJ5O7HR04U0RpzUQD4krKbexw3m
fnqOZqfuiIHVcdRV0wwmEogCDE7Aa9NqtyXsVe/58X8AYzZYxqxiDEpPLiZ5l9Y1
RR1vTX36WqHJiwm8RIeniyR9Iv8UlLSbAncjHKHCwgRiigOtTSTXzkn7znN5FMf5
OGaHZgp4GY+ZEHdYNW1ag7rJJvG6WYfmtLYIDQIMZ5AfQzaNXhtZX+8CAwEAAaAA
MA0GCSqGSIb3DQEBCwUAA4IBAQCFBvLmr0YnSUguzPi85Ljh5bK+LhETXUOGH8uM
HSuHeNM2+h6YrHOhe1LWPUyXWQFkjzIz8Qu4eHEeI+GkErUFl4NR9FICDGd13G1j
H819Wi8RncsrTP1mcaM2BViTSRyui2GIvGJ7/M4rN9/DdlNrCX3hKLblwYaiTlP7
KLTFCog07siVUDQHPzu+nK7EGW5G7Fx9t8r7ilRbZ1sMD+/qKnUfsTroNKtTeVvN
VcT6I9lzcFsesDvxI9ARtZquO3HWH4IbPVLBIav56wcJYcWwbTyK/JBiyMJi5zOg
HhWdylAY7gTilWU0aVTAkwXalzyO1k9V/pZreuP93rT6ugBp
-----END CERTIFICATE REQUEST-----` as CSR.Raw;

describe("CSR", () => {
  test("parse should successfully extract hostname from valid CSR", async () => {
    const effect = CSR.parse(validCSR);
    const result = await Effect.runPromise(effect);

    expect(result.hostname).toBe("test.example.com");
    expect(result.raw).toBe(validCSR);
  });

  test("parse should return ParseError for invalid PEM format", async () => {
    const invalidCSR = "not a valid CSR" as CSR.Raw;
    const effect = CSR.parse(invalidCSR);

    await expect(Effect.runPromise(effect)).rejects.toMatchObject({
      _tag: "ParseError",
    });
  });

  test("parse should return ParseError for malformed CSR content", async () => {
    const malformedCSR = `-----BEGIN CERTIFICATE REQUEST-----
invalid-base64-content!!!
-----END CERTIFICATE REQUEST-----` as CSR.Raw;
    const effect = CSR.parse(malformedCSR);

    await expect(Effect.runPromise(effect)).rejects.toMatchObject({
      _tag: "ParseError",
    });
  });

  test("Raw schema should validate PEM string", async () => {
    const validPEM = "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----";
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(CSR.Raw)(validPEM));

    expect(decoded).toBe(validPEM);
  });

  test("Info schema should validate CSR info structure", async () => {
    const info = {
      hostname: "example.com",
      raw: validCSR,
    };

    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(CSR.Info)(info));

    expect(decoded).toEqual(info);
  });
});
