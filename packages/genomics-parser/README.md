# Shared browser DNA parser

`@mutant/genomics-parser` is the single source for 23andMe, Ancestry, VCF,
and gzipped VCF parsing in the portal and ChatGPT app. Both browser apps call
`parseFile(file, { catalog, onProgress, signal, cooperative })`. This function
reads the raw file in the browser and returns only normalized genetic calls
and import metadata. Each app fetches the catalog through its own transport.

The package is distributed as a versioned tarball rather than through a
registry. The same artifact is checked into both apps' `vendor/` directories
and pinned in each `package-lock.json`. This lets the apps deploy separately
without copying parser source or depending on a package registry.

## Updating the parser

1. Change `src/` here and add or update a fixture test for the behavior.
2. Increment `version` in `package.json` and `PARSER_VERSION` in
   `src/version.js` together.
3. Run `npm pack` in this directory. Copy the resulting `.tgz` unchanged into
   `mutant-mcp/vendor/` and the portal's `vendor/`.
4. Update both app dependencies to the new `file:vendor/...` artifact and run
   `npm install` in each app to refresh its lockfile.
5. Record the artifact SHA-256 in `release.json` and both apps'
   `check-parser-package` scripts. Run `npm run check:genomics` in both apps.
6. Run the package fixture tests and both apps' parser/import tests. Build both
   apps before deploying either one.

The import payload records `parser_version`, `catalog_version`, and
`catalog_digest` in `upload_meta`. `catalog_digest` is a stable diagnostic
fingerprint, not a security hash. Compare these values first when two reports
from the same DNA file disagree. Existing reports without the fields remain
valid. Do not put the raw file or full catalog in an error report or log.
