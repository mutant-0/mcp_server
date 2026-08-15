import { z } from "zod";

const EnvSchema = z.object({
  MUTANT_SERVICE_LAMBDA_ARN: z.string().trim().default(""),
  MUTANT_OAUTH_ISSUER: z.string().trim().default(""),
  MUTANT_OAUTH_AUDIENCE: z.string().trim().default(""),
  MUTANT_UPGRADE_URL: z.string().trim().default("https://mutantgenomics.com/upgrade"),
  MUTANT_ONBOARDING_URL: z.string().trim().default("https://mutantgenomics.com/onboarding"),
  MUTANT_DEV_MODE: z.string().trim().default("false"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
});

export interface AppConfig {
  MUTANT_SERVICE_LAMBDA_ARN: string;
  MUTANT_OAUTH_ISSUER: string;
  MUTANT_OAUTH_AUDIENCE: string;
  MUTANT_UPGRADE_URL: string;
  MUTANT_ONBOARDING_URL: string;
  MUTANT_DEV_MODE: boolean;
  LOG_LEVEL: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    MUTANT_DEV_MODE: parsed.MUTANT_DEV_MODE === "true",
  };
}
