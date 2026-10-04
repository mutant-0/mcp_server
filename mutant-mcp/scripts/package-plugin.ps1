param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $pluginRoot 'submission'
}

$manifestPath = Join-Path $pluginRoot 'plugin.json'
$connectionPath = Join-Path $pluginRoot 'mcp.json'
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

# Package only the manifests and their two declared brand assets.
# Server source, environment files, recordings and credentials are excluded.
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
$zipPath = Join-Path $OutputDirectory ($manifest.name + '-' + $manifest.version + '.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fileStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($sourcePath in @($manifestPath, $connectionPath) + $assetPaths) {
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
Write-Output 'Before final review: confirm the packaged video link is reviewer-accessible, enter demo credentials privately in the dashboard, and verify the production connection and domain.'
