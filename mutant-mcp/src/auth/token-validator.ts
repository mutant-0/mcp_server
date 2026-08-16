import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { AccessLevel, MutantUserContext } from "./user-context.js";

export interface TokenValidator {
  validate(token: string): Promise<MutantUserContext>;
}

export interface ValidatorOptions {
  devMode: boolean;
  issuer: string;
  audience: string;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Resolves the token-signing keys from the issuer's OIDC discovery document.
 */
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
  private readonly keySet: JWTVerifyGetKey;

  constructor(
    private readonly config: { issuer: string; audience?: string },
    keySet: JWTVerifyGetKey,
  ) {
    this.keySet = keySet;
  }

  async validate(token: string): Promise<MutantUserContext> {
    const { payload } = await jwtVerify(token, this.keySet, {
      issuer: this.config.issuer,
      // Cognito access tokens without a configured resource server carry no `aud`
      // claim, so audience validation is skipped unless one is explicitly set.
      ...(this.config.audience ? { audience: this.config.audience } : {}),
    });
    return contextFromClaims(payload);
  }
}

/** Development-only validator: accepts fixed tokens, no cryptography. */
export class DevTokenValidator implements TokenValidator {
  async validate(token: string): Promise<MutantUserContext> {
    if (token === "dev-paid") {
      return { userId: "dev-user", accountId: "dev-account", accessLevel: "paid" };
    }
    if (token === "dev-free") {
      return { userId: "dev-user", accountId: "dev-account", accessLevel: "free" };
    }
    throw new Error("Invalid dev token. Use `dev-free` or `dev-paid`.");
  }
}

export async function createTokenValidator(options: ValidatorOptions): Promise<TokenValidator> {
  if (options.devMode) {
    return new DevTokenValidator();
  }
  if (!options.issuer) {
    throw new Error("MUTANT_OAUTH_ISSUER must be set (or enable MUTANT_DEV_MODE)");
  }
  const keySet = await discoverRemoteKeySet(options.issuer);
  return new JwtTokenValidator(
    { issuer: options.issuer, audience: options.audience || undefined },
    keySet,
  );
}

/**
 * Maps verified JWT claims to a trusted internal user context.
 *
 * Claim mapping is a placeholder until Mutant's real token shape is wired in:
 * - userId: `sub`, then `user_id`, then `mutant_user_id`
 * - accountId: `account_id`, then `mutant_account_id`, then `sub`
 * - accessLevel: `access_level` claim, else scope token `mutant:full`/`paid`
 * - analysisId: `analysis_id` or `mutant_analysis_id`
 */
export function contextFromClaims(payload: JWTPayload): MutantUserContext {
  const userId =
    claimString(payload.sub) ??
    claimString(payload.user_id) ??
    claimString(payload.mutant_user_id);
  if (!userId) {
    throw new Error("Token is missing a user identifier (sub)");
  }
  const accountId =
    claimString(payload.account_id) ?? claimString(payload.mutant_account_id) ?? userId;
  const accessLevel = deriveAccessLevel(payload);
  const analysisId = claimString(payload.analysis_id) ?? claimString(payload.mutant_analysis_id);
  return {
    userId,
    accountId,
    accessLevel,
    ...(analysisId ? { analysisId } : {}),
  };
}

function deriveAccessLevel(payload: JWTPayload): AccessLevel {
  const explicit = claimString(payload.access_level);
  if (explicit === "paid") return "paid";
  if (explicit === "free") return "free";

  const scope = claimString(payload.scope) ?? claimString(payload.scp) ?? "";
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (scopes.includes("mutant:full") || scopes.includes("paid")) {
    return "paid";
  }
  return "free";
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
