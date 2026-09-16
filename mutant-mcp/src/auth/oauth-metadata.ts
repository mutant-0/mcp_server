import type { AppConfig } from "../config.js";
import { resourceUri, supportedScopes } from "../config.js";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  registration_endpoint?: string;
}

const DOCUMENTATION_URL = "https://mutantgenomics.com/mcp";

/**
 * Origin that serves this discovery document.
 *
 * Cognito's hosted UI does not expose RFC 8414 `/.well-known/oauth-authorization-server`
 * (its custom domain 404s that path), so the MCP host mirrors the
 * authorization-server metadata at its own origin and API Gateway routes the
 * well-known path there. RFC 8414 §3.3 requires the returned `issuer` to match
 * the origin the document is served from, so it is derived from the MCP resource
 * URI rather than from `MUTANT_OAUTH_ISSUER` (the Cognito issuer that token
 * `iss` claims are validated against).
 */
function publicIssuer(config: AppConfig): string {
  if (config.MUTANT_MCP_RESOURCE_URI) {
    try {
      return new URL(config.MUTANT_MCP_RESOURCE_URI).origin;
    } catch {
      // Fall back to the configured OAuth issuer for an unparsable resource URI.
    }
  }
  return config.MUTANT_OAUTH_ISSUER;
}

/**
 * Authorization server identifiers advertised in RFC 9728 protected-resource
 * metadata.
 *
 * This must be the origin that serves the RFC 8414 document (see
 * {@link publicIssuer}): the Cognito custom domain 404s
 * `/.well-known/oauth-authorization-server`, so listing the Cognito issuer here
 * would send clients to a discovery URL that does not exist.
 */
function authorizationServers(config: AppConfig): string[] {
  const issuer = publicIssuer(config);
  return issuer ? [issuer] : [];
}

export function protectedResourceMetadata(config: AppConfig): ProtectedResourceMetadata {
  return {
    resource: resourceUri(config),
    authorization_servers: authorizationServers(config),
    scopes_supported: supportedScopes(config),
    bearer_methods_supported: ["header"],
    resource_name: "Mutant Genomics Analysis",
    resource_documentation: DOCUMENTATION_URL,
  };
}

interface CacheEntry {
  value: AuthorizationServerMetadata;
  expiresAt: number;
}

const AS_CACHE_TTL_MS = 10 * 60 * 1000;
let asCache: CacheEntry | undefined;

function normalize(doc: Record<string, unknown>, config: AppConfig): AuthorizationServerMetadata {
  const metadata: AuthorizationServerMetadata = {
    // The document is served from the MCP host, so it must advertise that host as
    // the issuer even though the endpoints live on the Cognito custom domain.
    issuer: publicIssuer(config),
    // Advertise every scope this resource supports; these are the scopes PRM
    // requests and the scopes the token validator accepts.
    scopes_supported: supportedScopes(config),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };

  const stringFields = [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "userinfo_endpoint",
    "end_session_endpoint",
    "registration_endpoint",
  ] as const;
  for (const field of stringFields) {
    const value = doc[field];
    if (typeof value === "string") {
      metadata[field] = value;
    }
  }

  if (Array.isArray(doc.response_modes_supported)) {
    const modes = doc.response_modes_supported.filter(
      (mode): mode is string => typeof mode === "string",
    );
    if (modes.length > 0) metadata.response_modes_supported = modes;
  }

  return metadata;
}

/**
 * Mirror the authorization server's discovery document for MCP clients.
 *
 * The canonical source remains the Cognito OIDC discovery document; we only
 * ensure the fields MCP's authorization-code + PKCE flow requires (notably
 * `code_challenge_methods_supported: ["S256"]`) are present. Failures fall back
 * to a minimal document so discovery never hard-fails.
 */
export async function authorizationServerMetadata(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AuthorizationServerMetadata> {
  if (asCache && asCache.expiresAt > now()) {
    return asCache.value;
  }

  let value: AuthorizationServerMetadata;
  if (!config.MUTANT_OAUTH_ISSUER) {
    value = normalize({}, config);
  } else {
    const discoveryUrl = new URL(
      ".well-known/openid-configuration",
      config.MUTANT_OAUTH_ISSUER.endsWith("/")
        ? config.MUTANT_OAUTH_ISSUER
        : `${config.MUTANT_OAUTH_ISSUER}/`,
    );
    try {
      const response = await fetchImpl(discoveryUrl);
      const doc = response.ok ? ((await response.json()) as Record<string, unknown>) : {};
      value = normalize(doc, config);
    } catch {
      value = normalize({}, config);
    }
  }

  asCache = { value, expiresAt: now() + AS_CACHE_TTL_MS };
  return value;
}

/** Test hook: clear the discovery cache. */
export function resetAuthorizationServerCache(): void {
  asCache = undefined;
}
