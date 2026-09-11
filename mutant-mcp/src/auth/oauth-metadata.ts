import type { AppConfig } from "../config.js";
import { resourceUri } from "../config.js";

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

export function protectedResourceMetadata(config: AppConfig): ProtectedResourceMetadata {
  return {
    resource: resourceUri(config),
    authorization_servers: config.MUTANT_OAUTH_ISSUER ? [config.MUTANT_OAUTH_ISSUER] : [],
    scopes_supported: [config.MUTANT_OAUTH_SCOPE],
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
  const scopes = new Set<string>([config.MUTANT_OAUTH_SCOPE]);
  if (Array.isArray(doc.scopes_supported)) {
    for (const scope of doc.scopes_supported) {
      if (typeof scope === "string") scopes.add(scope);
    }
  }

  const metadata: AuthorizationServerMetadata = {
    issuer: typeof doc.issuer === "string" ? doc.issuer : config.MUTANT_OAUTH_ISSUER,
    scopes_supported: [...scopes],
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
