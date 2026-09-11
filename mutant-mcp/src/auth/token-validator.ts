import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { MutantUserContext } from "./user-context.js";

export interface TokenValidator {
  validate(token: string): Promise<MutantUserContext>;
}

export interface ValidatorOptions {
  devMode: boolean;
  issuer: string;
  audience: string;
  clientId: string;
  requiredScope: string;
  resourceUri: string;
}

/**
 * OAuth 2.0 error codes surfaced through `WWW-Authenticate` and tool challenges.
 */
export type OAuthErrorCode = "invalid_token" | "insufficient_scope" | "invalid_request";

export class TokenValidationError extends Error {
  constructor(
    readonly oauthError: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TokenValidationError";
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Resolves the token-signing keys from the issuer's OIDC discovery document. */
export async function discoverRemoteKeySet(issuer: string): Promise<JWTVerifyGetKey> {
  const discoveryUrl = new URL(".well-known/openid-configuration", ensureTrailingSlash(issuer));
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${issuer}: ${response.status}`);
  }
  const document = (await response.json()) as { jwks_uri?: string };
  if (!document.jwks_uri) {
    throw new Error(`OIDC discovery response from ${issuer} is missing jwks_uri`);
  }
  return createRemoteJWKSet(new URL(document.jwks_uri));
}

export class JwtTokenValidator implements TokenValidator {
  constructor(
    private readonly config: ValidatorOptions,
    private readonly keySet: JWTVerifyGetKey,
  ) {}

  async validate(token: string): Promise<MutantUserContext> {
    const { payload } = await jwtVerify(token, this.keySet, {
      issuer: this.config.issuer,
      // Cognito access tokens may omit `aud`; only enforce it when configured.
      ...(this.config.audience ? { audience: this.config.audience } : {}),
    });
    return contextFromClaims(payload, this.config);
  }
}

/**
 * Development-only validator: accepts fixed tokens, no cryptography.
 * `dev-free`/`dev-paid` are accepted for ChatGPT dev-linking smoke tests.
 */
export class DevTokenValidator implements TokenValidator {
  constructor(private readonly requiredScope: string) {}

  async validate(token: string): Promise<MutantUserContext> {
    if (["dev", "dev-free", "dev-paid"].includes(token)) {
      return {
        userId: "dev-user",
        clientId: "dev-client",
        scopes: [this.requiredScope],
        isDev: true,
      };
    }
    throw new TokenValidationError(
      "invalid_token",
      "Invalid dev token. Use `dev-free` or `dev-paid`.",
    );
  }
}

export async function createTokenValidator(options: ValidatorOptions): Promise<TokenValidator> {
  if (options.devMode) {
    return new DevTokenValidator(options.requiredScope);
  }
  if (!options.issuer) {
    throw new Error("MUTANT_OAUTH_ISSUER must be set (or enable MUTANT_DEV_MODE)");
  }
  const keySet = await discoverRemoteKeySet(options.issuer);
  return new JwtTokenValidator(options, keySet);
}

/**
 * Maps verified JWT claims to a trusted internal user context, enforcing that
 * the token is an access token for the expected client, scope, and resource.
 */
export function contextFromClaims(payload: JWTPayload, config: ValidatorOptions): MutantUserContext {
  const tokenUse = claimString(payload.token_use);
  if (tokenUse && tokenUse !== "access") {
    throw new TokenValidationError("invalid_token", "Token is not a Cognito access token.");
  }

  const userId = claimString(payload.sub);
  if (!userId) {
    throw new TokenValidationError("invalid_token", "Token is missing a user identifier (sub).");
  }

  const clientId = claimString(payload.client_id) ?? claimString(payload.azp);
  if (config.clientId && clientId !== config.clientId) {
    throw new TokenValidationError("invalid_token", "Token was issued to a different client.");
  }

  const scopes = extractScopes(payload);
  if (config.requiredScope && !scopes.includes(config.requiredScope)) {
    throw new TokenValidationError(
      "insufficient_scope",
      `Token is missing the required scope '${config.requiredScope}'.`,
    );
  }

  if (config.resourceUri) {
    const resource = extractResource(payload);
    // Only enforce when the issuer actually emits a resource indicator, so
    // issuers without RFC 8707 support are not rejected.
    if (resource.length > 0 && !resource.includes(config.resourceUri)) {
      throw new TokenValidationError(
        "invalid_token",
        "Token audience does not include this MCP resource.",
      );
    }
  }

  return {
    userId,
    ...(clientId ? { clientId } : {}),
    scopes,
  };
}

export function extractScopes(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  if (typeof raw === "string") {
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
}

function extractResource(payload: JWTPayload): string[] {
  const raw = payload.resource ?? payload.aud;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  if (typeof raw === "string") {
    return [raw];
  }
  return [];
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
