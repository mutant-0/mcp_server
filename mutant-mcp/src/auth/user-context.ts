/**
 * Trusted, server-derived identity. Produced exclusively by the token validator
 * and never taken from MCP tool arguments or `_meta`.
 *
 * The MCP Lambda does not carry plan/entitlement state: the backend resolves the
 * effective entitlement from `UserEntitlements` for this `userId`.
 */
export interface MutantUserContext {
  /** Cognito `sub`, forwarded to the backend as the only identity claim. */
  userId: string;
  /** OAuth client id the token was issued to (for audit/logging only). */
  clientId?: string;
  /** Verified scopes carried by the access token. */
  scopes: string[];
  /** True when running under MUTANT_DEV_MODE (no cryptography). */
  isDev?: boolean;
}
