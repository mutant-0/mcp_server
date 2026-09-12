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

/**
 * Machine-readable reason a token was rejected. Logged (never the token itself)
 * so operators can tell a bad signature from a client/scope/audience mismatch.
 */
export type TokenRejectionReason =
  | "dev_token_required"
  | "not_access_token"
  | "missing_sub"
  | "client_mismatch"
  | "scope_mismatch"
  | "resource_mismatch"
  | "expired"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "claim_mismatch"
  | "bad_signature"
  | "unknown_key"
  | "unverifiable_token";

export class TokenValidationError extends Error {
  constructor(
    readonly oauthError: OAuthErrorCode,
    message: string,
    readonly reason: TokenRejectionReason = "unverifiable_token",
  ) {
    super(message);
    this.name = "TokenValidationError";
  }
}

interface JoseErrorLike {
  code?: unknown;
  claim?: unknown;
}

/** Map a jose verification failure to a stable reason + operator-safe message. */
function classifyJwtError(error: unknown): { reason: TokenRejectionReason; message: string } {
  const { code, claim } = (error ?? {}) as JoseErrorLike;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return { reason: "expired", message: "Token is expired." };
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (claim === "iss") {
        return {
          reason: "issuer_mismatch",
          message: "Token issuer does not match the configured Mutant issuer.",
        };
      }
      if (claim === "aud") {
        return {
          reason: "audience_mismatch",
          message: "Token audience does not match the configured MUTANT_OAUTH_AUDIENCE.",
        };
      }
      return {
        reason: "claim_mismatch",
        message: `Token claim validation failed${typeof claim === "string" ? ` (${claim})` : ""}.`,
      };
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return { reason: "bad_signature", message: "Token signature verification failed." };
    case "ERR_JWKS_NO_MATCHING_KEY":
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
    case "ERR_JWKS_TIMEOUT":
    case "ERR_JWKS_INVALID":
      return { reason: "unknown_key", message: "No usable signing key was found for the token." };
    default:
      return { reason: "unverifiable_token", message: "Token could not be verified." };
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
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keySet, {
        issuer: this.config.issuer,
        // Cognito access tokens may omit `aud`; only enforce it when configured.
        ...(this.config.audience ? { audience: this.config.audience } : {}),
      }));
    } catch (error) {
      const { reason, message } = classifyJwtError(error);
      throw new TokenValidationError("invalid_token", message, reason);
    }
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
      "dev_token_required",
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
    throw new TokenValidationError(
      "invalid_token",
      "Token is not a Cognito access token.",
      "not_access_token",
    );
  }

  const userId = claimString(payload.sub);
  if (!userId) {
    throw new TokenValidationError(
      "invalid_token",
      "Token is missing a user identifier (sub).",
      "missing_sub",
    );
  }

  const clientId = claimString(payload.client_id) ?? claimString(payload.azp);
  if (config.clientId && clientId !== config.clientId) {
    throw new TokenValidationError(
      "invalid_token",
      `Token was issued to a different client (expected '${config.clientId}', got '${clientId ?? "none"}').`,
      "client_mismatch",
    );
  }

  const scopes = extractScopes(payload);
  if (config.requiredScope && !scopes.includes(config.requiredScope)) {
    throw new TokenValidationError(
      "insufficient_scope",
      `Token is missing the required scope '${config.requiredScope}' (got: ${scopes.join(" ") || "none"}).`,
      "scope_mismatch",
    );
  }

  if (config.resourceUri) {
    const resource = extractResource(payload);
    // Only enforce when the issuer actually emits a resource indicator, so
    // issuers without RFC 8707 support are not rejected.
    if (resource.length > 0 && !resource.includes(config.resourceUri)) {
      throw new TokenValidationError(
        "invalid_token",
        `Token audience does not include this MCP resource (expected '${config.resourceUri}', got '${resource.join(" ")}').`,
        "resource_mismatch",
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
