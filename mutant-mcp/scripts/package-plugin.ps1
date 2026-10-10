param(
    [string]$OutputDirectory,
    [ValidateSet('Codex', 'Portable')]
    [string]$PackageFormat = 'Codex',
    [ValidateSet('New', 'Existing')]
    [string]$SubmissionTarget = 'New'
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $pluginRoot 'submission'
}

$manifestPath = Join-Path $pluginRoot 'plugin.json'
$connectionFileName = if ($PackageFormat -eq 'Codex') { '.mcp.json' } else { 'mcp.json' }
$connectionPath = Join-Path $pluginRoot $connectionFileName
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$connections = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
$openaiMetadata = $manifest.extensions.'com.openai'
$interface = $openaiMetadata.interface

$supportedCategories = @(
    'Productivity', 'Creativity', 'Developer Tools', 'Business & Operations',
    'Data & Analytics', 'Communication', 'Education & Research', 'Security',
    'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other'
)
if ($interface.category -cnotin $supportedCategories) {
    throw "Unsupported category: $($interface.category). Use an exact supported category title."
}

if ($interface.displayName.Length -gt 30 -or $interface.shortDescription.Length -gt 30) {
    throw 'Listing name and subtitle must each be at most 30 characters.'
}
foreach ($field in @('websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL')) {
    if ($interface.$field -notmatch '^https://') {
        throw "Missing HTTPS listing field: $field"
    }
}
if (@($openaiMetadata.review.test_cases.positive).Count -ne 5 -or
    @($openaiMetadata.review.test_cases.negative).Count -ne 3) {
    throw 'The review package must contain five positive and three negative cases.'
}
if ($openaiMetadata.review.demo_recording_url -notmatch '^https://') {
    throw 'The review package must contain an HTTPS video walkthrough URL.'
}
foreach ($case in $openaiMetadata.review.test_cases.positive) {
    foreach ($field in @('description', 'prompt', 'tools_triggered', 'expected_behavior')) {
        if ([string]::IsNullOrWhiteSpace($case.$field)) {
            throw "Positive case is missing $field"
        }
    }
}
foreach ($case in $openaiMetadata.review.test_cases.negative) {
    foreach ($field in @('description', 'prompt', 'expected_behavior')) {
        if ([string]::IsNullOrWhiteSpace($case.$field)) {
            throw "Negative case is missing $field"
        }
    }
}
$serverEntries = @($connections.mcpServers.PSObject.Properties)
if ($serverEntries.Count -ne 1 -or $serverEntries[0].Value.url -notmatch '^https://') {
    throw 'Expected one remote HTTPS MCP server.'
}
if ($PackageFormat -eq 'Codex') {
    if ([string]::IsNullOrWhiteSpace($serverEntries[0].Value.oauth.clientId)) {
        throw 'The Codex submission requires predefined oauth.clientId.'
    }
    if ($SubmissionTarget -eq 'New') {
        if ($serverEntries[0].Value.type -cne 'http') {
            throw 'Use type http for the new Codex-format OAuth submission.'
        }
    } else {
        # Existing drafts reject server configuration replacements. Preserve
        # identity here; the portal also needs to accept any OAuth changes.
        $originalConnections = Get-Content -LiteralPath (Join-Path $pluginRoot 'mcp.json') -Raw | ConvertFrom-Json
        $originalServers = @($originalConnections.mcpServers.PSObject.Properties)
        if ($originalServers.Count -ne 1 -or
            $serverEntries[0].Name -cne $originalServers[0].Name -or
            $serverEntries[0].Value.type -cne $originalServers[0].Value.type -or
            $serverEntries[0].Value.url -cne $originalServers[0].Value.url) {
            throw 'The OAuth package changes the original MCP configuration; create a new plugin instead.'
        }
    }
    # Derive the compatibility manifest from the existing listing source so the
    # two submission formats retain the same identity and review materials.
    $packageManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $packageManifest.PSObject.Properties.Remove('$schema')
    $packageManifest | Add-Member -NotePropertyName mcpServers -NotePropertyValue './.mcp.json'
    $packageManifest | Add-Member -NotePropertyName interface -NotePropertyValue $packageManifest.extensions.'com.openai'.interface
    $packageManifest.extensions.'com.openai'.PSObject.Properties.Remove('interface')
    if (-not $packageManifest.interface.PSObject.Properties['capabilities']) {
        $packageManifest.interface | Add-Member -NotePropertyName capabilities -NotePropertyValue @(
            'Explore DNA findings', 'Review supporting evidence', 'Import DNA data'
        )
    }
    $packageManifestJson = $packageManifest | ConvertTo-Json -Depth 30
}

# Package only the selected manifests and their two declared brand assets.
# The public OAuth client ID is included; server source, environment files,
# recordings, passwords, client secrets and access tokens are excluded.
$assetPaths = @()
foreach ($field in @('logo', 'composerIcon')) {
    $assetReference = $interface.$field
    if ($assetReference -notmatch '^\./assets/[a-zA-Z0-9._-]+$') {
        throw "Unsupported asset path for $field"
    }
    $assetPath = Join-Path $pluginRoot $assetReference.Substring(2)
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
        throw "Missing asset: $assetReference"
    }
    if ((Get-Item -LiteralPath $assetPath).Length -gt 5MB) {
        throw "Asset exceeds 5 MiB: $assetReference"
    }
    $assetPaths += $assetPath
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$zipSuffix = if ($PackageFormat -eq 'Codex' -and $SubmissionTarget -eq 'New') { '-oauth-new-plugin.zip' } else { '.zip' }
$zipPath = Join-Path $OutputDirectory ($manifest.name + '-' + $manifest.version + $zipSuffix)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fileStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    if ($PackageFormat -eq 'Codex') {
        # Omit the portable root manifest: otherwise it takes precedence over
        # .codex-plugin/plugin.json and the portable schema rejects OAuth fields.
        $manifestEntry = $archive.CreateEntry('.codex-plugin/plugin.json')
        $manifestWriter = [System.IO.StreamWriter]::new(
            $manifestEntry.Open(), [System.Text.UTF8Encoding]::new($false)
        )
        try { $manifestWriter.Write($packageManifestJson) }
        finally { $manifestWriter.Dispose() }
        $sourcePaths = @($connectionPath) + $assetPaths
    } else {
        $sourcePaths = @($manifestPath, $connectionPath) + $assetPaths
    }
    foreach ($sourcePath in $sourcePaths) {
        $entryName = $sourcePath.Substring($pluginRoot.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $sourcePath, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
    $fileStream.Dispose()
}
Write-Output "Created $zipPath"
Write-Output "Package format: $PackageFormat"
Write-Output "Submission target: $SubmissionTarget"
Write-Output 'Before final review: confirm the packaged video link is reviewer-accessible, enter demo credentials privately in the dashboard, and verify the production connection and domain.'
