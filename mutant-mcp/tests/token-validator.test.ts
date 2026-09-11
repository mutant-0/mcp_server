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
  TokenValidationError,
  type ValidatorOptions,
} from "../src/auth/token-validator.js";

const ISSUER = "https://auth.mutantgenomics.com";
const AUDIENCE = "mutant-mcp";
const CLIENT_ID = "chatgpt-connector";
const SCOPE = "mutant/analysis.read";
const RESOURCE = "https://mcp.mutantgenomics.com/mcp";
const KID = "test-key";

function makeOptions(overrides: Partial<ValidatorOptions> = {}): ValidatorOptions {
  return {
    devMode: false,
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    requiredScope: SCOPE,
    resourceUri: RESOURCE,
    ...overrides,
  };
}

async function makeKeys(): Promise<{ publicJwk: JWK; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as JWK & { kid: string; alg: string; use: string };
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { publicJwk, privateKey };
}

function makeValidator(publicJwk: JWK, options: Partial<ValidatorOptions> = {}): JwtTokenValidator {
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  return new JwtTokenValidator(makeOptions(options), keySet);
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user-123",
    token_use: "access",
    client_id: CLIENT_ID,
    scope: SCOPE,
    resource: RESOURCE,
    ...overrides,
  };
}

async function sign(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  options: { issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

describe("JwtTokenValidator", () => {
  it("accepts a valid access token and derives identity", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims());
    const context = await makeValidator(publicJwk).validate(token);
    expect(context.userId).toBe("user-123");
    expect(context.clientId).toBe(CLIENT_ID);
    expect(context.scopes).toContain(SCOPE);
  });

  it("rejects a token from the wrong issuer", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims(), { issuer: "https://evil.example.com" });
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims(), { audience: "some-other-api" });
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("-5m")
      .sign(privateKey);
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });

  it("rejects a token issued to a different client", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims({ client_id: "someone-else" }));
    await expect(makeValidator(publicJwk).validate(token)).rejects.toMatchObject({
      oauthError: "invalid_token",
    });
  });

  it("rejects a token missing the required scope with insufficient_scope", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims({ scope: "openid" }));
    await expect(makeValidator(publicJwk).validate(token)).rejects.toMatchObject({
      oauthError: "insufficient_scope",
    });
  });

  it("rejects an id token presented as an access token", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims({ token_use: "id" }));
    await expect(makeValidator(publicJwk).validate(token)).rejects.toBeInstanceOf(
      TokenValidationError,
    );
  });

  it("rejects a token bound to a different resource", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const token = await sign(privateKey, baseClaims({ resource: "https://other.example/mcp" }));
    await expect(makeValidator(publicJwk).validate(token)).rejects.toMatchObject({
      oauthError: "invalid_token",
    });
  });

  it("does not enforce absent optional checks", async () => {
    const { publicJwk, privateKey } = await makeKeys();
    const keySet = createLocalJWKSet({ keys: [publicJwk] });
    const validator = new JwtTokenValidator(
      makeOptions({ audience: "", clientId: "", requiredScope: "", resourceUri: "" }),
      keySet,
    );
    const token = await new SignJWT({ sub: "user-1", token_use: "access" })
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
    const token = await sign(other.privateKey, baseClaims());
    await expect(makeValidator(publicJwk).validate(token)).rejects.toThrow();
  });
});

describe("contextFromClaims", () => {
  it("throws when the token has no user identifier", () => {
    expect(() => contextFromClaims({}, makeOptions())).toThrow("missing a user identifier");
  });

  it("throws insufficient_scope when scope is missing", () => {
    expect(() => contextFromClaims({ sub: "user-1", scope: "openid" }, makeOptions())).toThrow(
      TokenValidationError,
    );
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

    await discoverRemoteKeySet("https://cognito-idp.us-west-2.amazonaws.com/us-west-2_tgb5TJylh");

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(
      "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_tgb5TJylh/.well-known/openid-configuration",
    );
    vi.unstubAllGlobals();
  });
});

describe("DevTokenValidator", () => {
  it("maps dev tokens to a dev user with the required scope", async () => {
    const validator = new DevTokenValidator(SCOPE);
    const context = await validator.validate("dev-free");
    expect(context.userId).toBe("dev-user");
    expect(context.scopes).toContain(SCOPE);
  });

  it("rejects unknown dev tokens", async () => {
    await expect(new DevTokenValidator(SCOPE).validate("nope")).rejects.toThrow();
  });
});
