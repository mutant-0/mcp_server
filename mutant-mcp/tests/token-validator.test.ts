import { describe, it, expect, vi } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import {
  contextFromClaims,
  DevTokenValidator,
  discoverRemoteKeySet,
  JwtTokenValidator,
} from "../src/auth/token-validator.js";

const ISSUER = "https://auth.mutantgenomics.com";
const AUDIENCE = "mutant-mcp";
const KID = "test-key";

async function makeKeys(): Promise<{ publicJwk: JWK; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as JWK & { kid: string; alg: string; use: string };
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { publicJwk, privateKey };
}

function makeValidator(publicJwk: JWK): JwtTokenValidator {
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  return new JwtTokenValidator({ issuer: ISSUER, audience: AUDIENCE }, keySet);
}

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

describe("JwtTokenValidator", () => {
  it("validates a token and derives a paid user from the mutant:full scope", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, { sub: "user-123", scope: "openid mutant:full" });
    const context = await makeValidator(publicJwk).validate(token);
    expect(context.userId).toBe("user-123");
    expect(context.accessLevel).toBe("paid");
  });

  it("derives a free user from an explicit access_level claim", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, { sub: "user-456", access_level: "free" });
    const context = await makeValidator(publicJwk).validate(token);
    expect(context.accessLevel).toBe("free");
  });

  it("rejects a token from the wrong issuer", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer("https://evil.example.com")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience("some-other-api")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("-5m")
      .sign(privateKey);
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });

  it("skips audience validation when no audience is configured", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const keySet = createLocalJWKSet({ keys: [publicJwk] });
    const validator = new JwtTokenValidator({ issuer: ISSUER }, keySet);
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const context = await validator.validate(token);
    expect(context.userId).toBe("user-1");
  });

  it("rejects an unsigned/tampered token", async () => {
    const { publicJwk } = await makeKeys();
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(other.privateKey);
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });
});

describe("contextFromClaims", () => {
  it("throws when the token has no user identifier", () => {
    expect(() => contextFromClaims({})).toThrow("missing a user identifier");
  });

  it("falls back accountId to userId", () => {
    const context = contextFromClaims({ sub: "user-1" });
    expect(context.accountId).toBe("user-1");
    expect(context.accessLevel).toBe("free");
  });

  it("reads account and analysis ids when present", () => {
    const context = contextFromClaims({
      sub: "user-1",
      account_id: "account-9",
      analysis_id: "analysis-4",
    });
    expect(context.accountId).toBe("account-9");
    expect(context.analysisId).toBe("analysis-4");
  });
});

describe("discoverRemoteKeySet", () => {
  it("keeps the issuer path when building the discovery URL (Cognito)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jwks_uri:
          "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_tgb5TJylh/.well-known/jwks.json",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await discoverRemoteKeySet(
      "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_tgb5TJylh",
    );

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(
      "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_tgb5TJylh/.well-known/openid-configuration",
    );
    vi.unstubAllGlobals();
  });
});

describe("DevTokenValidator", () => {
  it("maps dev-paid and dev-free tokens", async () => {
    const validator = new DevTokenValidator();
    expect((await validator.validate("dev-paid")).accessLevel).toBe("paid");
    expect((await validator.validate("dev-free")).accessLevel).toBe("free");
  });

  it("rejects unknown dev tokens", async () => {
    await expect(new DevTokenValidator().validate("nope")).rejects.toThrow();
  });
});
