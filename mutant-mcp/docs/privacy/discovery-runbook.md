# PRIV-01 discovery runbook

Version: 1.0 (2026-09-30). Backlog item: PRIV-01 steps 1-2. Reproducible,
secret-free commands to (re)build `deployment-manifest.md` and confirm the
deployed consent route. Run from `C:\ghrepos\mcp_server`. Region `us-west-2`,
account `221082193523`.

Rules:
- Record identifiers only. Never paste `aws configure` secret values, tokens, or
  full environment-variable sets into the manifest.
- Use **synthetic accounts and synthetic fixtures only** for the walk (step 5).
- Do not relabel or fabricate routing traces.

## 1. Account, functions, revisions

```powershell
aws sts get-caller-identity
aws lambda list-functions --region us-west-2 `
  --query "Functions[?starts_with(FunctionName,'mutant')].[FunctionName,LastModified,CodeSha256,RevisionId]" --output table
aws lambda get-function-configuration --function-name mutant-mcp-dev  --region us-west-2 `
  --query "{LastModified:LastModified,RevisionId:RevisionId,Timeout:Timeout,MemorySize:MemorySize}" --output json
aws lambda get-function-configuration --function-name mutant-mcp-prod --region us-west-2 `
  --query "{LastModified:LastModified,RevisionId:RevisionId,Timeout:Timeout,MemorySize:MemorySize}" --output json
aws lambda list-versions-by-function --function-name mutant-mcp-dev  --region us-west-2
aws lambda list-versions-by-function --function-name mutant-mcp-prod --region us-west-2
aws lambda list-aliases --function-name mutant-report-generator --region us-west-2
```

`MUTANT_DEV_MODE` and the MCP environment values are read only under an approved
scope; if allowed, request just the two keys rather than the whole map:

```powershell
aws lambda get-function-configuration --function-name mutant-mcp-prod --region us-west-2 `
  --query "Environment.Variables.MUTANT_DEV_MODE" --output text
```

## 2. Stacks, domains, mappings

```powershell
aws cloudformation describe-stacks --region us-west-2 --query "Stacks[].StackName" --output text
aws apigatewayv2 get-domain-names --region us-west-2 `
  --query "Items[].[DomainName,DomainNameConfigurations[0].CertificateArn]" --output json
aws apigatewayv2 get-api-mappings --domain-name dev-api.mutantbiotech.com --region us-west-2 --output json
aws apigatewayv2 get-api-mappings --domain-name api.mutantbiotech.com     --region us-west-2 --output json
```

## 3. Log groups and retention

```powershell
aws logs describe-log-groups --region us-west-2 `
  --query "logGroups[?contains(logGroupName,'mutant')].[logGroupName,retentionInDays]" --output table
```

Confirm whether the MCP group was adopted (retention not applied) vs created
(`mutant-mcp-stack.ts` `adoptLogGroup`). Backend groups with `None` means
never-expire.

## 4. OAuth discovery (live)

```powershell
curl.exe -s https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource
curl.exe -s https://dev-api.mutantbiotech.com/.well-known/oauth-authorization-server
curl.exe -s https://api.mutantbiotech.com/.well-known/oauth-protected-resource
curl.exe -s https://api.mutantbiotech.com/.well-known/oauth-authorization-server
# resource-path form:
curl.exe -s https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource/mcp
```

Record `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`,
`scopes_supported`, `resource`, and grant/PKCE settings. Compare prod scopes to the
prod `resource` — a known anomaly (prod advertises the dev `analysis.read` scope)
is tracked in `deployment-manifest.md` §5a.

## 5. Synthetic-account link + import walk (answers PRIV-01 step 2)

Objective: establish whether the real flow visits the portal's
`ChatGPTAuthorizePage.js` or goes directly to the Cognito hosted UI, and capture
the actual tool/argument sequence.

1. Create a **synthetic** new account and a **synthetic** existing account
   (sanitized fixtures only).
2. In ChatGPT, create/refresh a custom connector pointing at
   `https://<mcp-host>/mcp`, then link it. Observe in the browser network trace
   where the OAuth `authorize` request lands. The deployed AS advertises
   `https://login.mutantgenomics.com/oauth2/authorize` (Cognito hosted UI), which
   is **not** the React route — confirm visually and record the observed URL and
   whether `mutantgenomics.com/...authorize...` was ever loaded.
3. Run the DNA import flow with a synthetic fixture; confirm the component parses
   locally and only matched variants are submitted.
4. Capture the observed model-selected tool calls from the deployment logs:

```powershell
npm run record:trace -- --prompt "<entry prompt>" --state READY_FREE `
  --calls <log-export.json> --user <sub> --from <iso> --to <iso> --write
$env:GOLDEN_TRACES_REQUIRED = '1'
npm exec -- vitest run tests/golden-prompt-routing.test.ts
Remove-Item Env:\GOLDEN_TRACES_REQUIRED
```

Missing evidence must remain incomplete. Withheld `query` values are refused with
an explanation rather than imported; that is a routing finding, not a capture.

## 6. Portal build / served artifact

```powershell
aws cloudfront list-distributions --region us-east-1 `
  --query "DistributionList.Items[].[Id,DomainName,Comment,Aliases.Items]" --output json
aws cloudfront get-distribution --id E24PU371ANVRGN `
  --query "Distribution.DistributionConfig.Origins.Items[].DomainName" --output json
aws s3api head-object --bucket mutantbt-frontend-web --key index.html --region us-west-2 `
  --query "{LastModified:LastModified,ETag:ETag}" --output json
aws s3api get-bucket-versioning --bucket mutantbt-frontend-web --region us-west-2
```

Reconcile the two local roots (`front-end-web/package.json` vs
`front-end-web/front-end-web/package.json`) with what the hosted pipeline builds.
Fetch the rendered live `https://mutantgenomics.com/privacy` and `/data-policy`
(render in a browser; raw HTML is the SPA shell) and record the shown version vs
the source `2026-09-18` policy.

## 7. Data-store retention spot-checks

```powershell
aws s3api get-bucket-lifecycle-configuration --bucket mutantbt-genetic-data --region us-west-2
aws s3api get-bucket-versioning --bucket mutantbt-genetic-data --region us-west-2
aws s3api get-bucket-encryption --bucket mutantbt-genetic-data --region us-west-2 `
  --query "ServerSideEncryptionConfiguration.Rules[].ApplyServerSideEncryptionByDefault.SSEAlgorithm"
foreach ($t in @('Results','UserGenomics','Assessments','Status','Recommendations','CacheVersions')) {
  aws dynamodb describe-time-to-live --table-name $t --region us-west-2 --query TimeToLiveDescription
}
```

Do **not** list object keys under `users/` or query table items — that would
expose real user identifiers; only bucket/table configuration is needed.

## 8. Refresh checklist

1. Re-run §1-§4, §6, §7; update `deployment-manifest.md` values and the
   last-refresh date.
2. Re-run §5 for a synthetic new and existing account; update §9 of the manifest
   (consent route) and the routing traces.
3. Move any resolved `TBD` rows out of `owner-decisions.md`.
