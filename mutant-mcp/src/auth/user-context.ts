export type AccessLevel = "free" | "paid";

/**
 * Trusted, server-derived identity. This is produced exclusively by the token
 * validator and is never taken from MCP tool arguments.
 */
export interface MutantUserContext {
  userId: string;
  accountId: string;
  accessLevel: AccessLevel;
  analysisId?: string;
}

export function isPaid(user: MutantUserContext): boolean {
  return user.accessLevel === "paid";
}
