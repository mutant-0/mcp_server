import type { AppConfig } from "../src/config.js";
import type { AccessLevel, MutantUserContext } from "../src/auth/user-context.js";

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    MUTANT_SERVICE_LAMBDA_ARN: "",
    MUTANT_OAUTH_ISSUER: "",
    MUTANT_OAUTH_AUDIENCE: "",
    MUTANT_UPGRADE_URL: "https://mutantgenomics.com/upgrade",
    MUTANT_ONBOARDING_URL: "https://mutantgenomics.com/onboarding",
    MUTANT_DEV_MODE: true,
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

export function makeUser(
  accessLevel: AccessLevel,
  extra: Partial<MutantUserContext> = {},
): MutantUserContext {
  return { userId: "user-1", accountId: "account-1", accessLevel, ...extra };
}
