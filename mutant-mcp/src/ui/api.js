// GENERATED FILE - DO NOT EDIT (written by scripts/sync-genomics.mjs).
//
// Portal API shim for the vendored genomics modules.
//
// The Apps SDK component receives the SNP catalog from the get_snp_catalog MCP
// tool and injects it into the parser, so nothing in the vendored processor may
// reach back to the Mutant portal: there is no portal session, no Cognito token,
// and no cookie in the ChatGPT iframe. Calling this function is a bug, so it
// throws rather than falling back to an unauthenticated request.
export function fetchSnpCatalog() {
  throw new Error(
    "The vendored DNA processor must be given an explicit SNP catalog; it cannot fetch one from the portal inside the ChatGPT app."
  );
}
