$ErrorActionPreference = 'Stop'
$hostName = 'com.superboj.core'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'SUPER_BOJ'
$registration = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$manifest = Join-Path $dataDirectory "$hostName.json"
$binary = Join-Path $dataDirectory 'bin\super-boj-core.exe'
foreach ($path in @($registration, $manifest, $binary)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
Write-Output "Removed Chrome registration and native binary. Local data: $dataDirectory"
