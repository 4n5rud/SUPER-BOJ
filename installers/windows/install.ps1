param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [Parameter(Mandatory = $true)]
    [string]$Binary
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.superboj.core'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'SUPER_BOJ'
$binDirectory = Join-Path $dataDirectory 'bin'
$binaryPath = Join-Path $binDirectory 'super-boj-core.exe'
$manifestPath = Join-Path $dataDirectory "$hostName.json"
$registration = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$source = Get-Item -LiteralPath $Binary
if ($source.PSIsContainer) { throw 'Select the native host .exe file.' }
New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
$stagedBinary = Join-Path $binDirectory ("install-{0}.exe" -f [guid]::NewGuid())
$stagedManifest = Join-Path $dataDirectory ("install-{0}.json" -f [guid]::NewGuid())
try {
    Copy-Item -LiteralPath $source.FullName -Destination $stagedBinary
    $probe = & $stagedBinary doctor | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $probe.language -ne 'rust') {
        throw 'The native host failed its doctor command.'
    }
    $manifest = @{
        name = $hostName
        description = 'SUPER_BOJ Local Native Engine'
        path = $binaryPath
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    } | ConvertTo-Json
    [IO.File]::WriteAllText($stagedManifest, $manifest, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $stagedBinary -Destination $binaryPath -Force
    Move-Item -LiteralPath $stagedManifest -Destination $manifestPath -Force
    New-Item -Path $registration -Force | Out-Null
    Set-Item -LiteralPath $registration -Value $manifestPath
    if ((Get-Item -LiteralPath $registration).GetValue('') -cne $manifestPath) {
        throw 'Chrome Native Messaging registration could not be verified.'
    }
    Write-Output "Installed native binary. Chrome manifest: $manifestPath"
} finally {
    foreach ($temporary in @($stagedBinary, $stagedManifest)) {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
