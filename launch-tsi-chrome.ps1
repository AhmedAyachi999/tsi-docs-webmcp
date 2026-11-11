# Launches a dedicated Chrome profile with WebMCP enabled and the TSI Docs WebMCP
# extension loaded, then opens https://docs.tsi.com.tn/.
#
# Chrome 137+ ignores --load-extension, so the extension is loaded through the
# DevTools protocol (Extensions.loadUnpacked). That load lasts for the session,
# so run this script each time instead of opening that profile directly.
# Your normal Chrome profile is not touched.

$ErrorActionPreference = "Stop"
$chrome     = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$extension  = Join-Path $PSScriptRoot "extension"
$profileDir = Join-Path $env:LOCALAPPDATA "TSIWebMCP\ChromeProfile"
$port       = 9333
$startUrl   = "https://docs.tsi.com.tn/"

# 1. Profile with chrome://flags/#enable-webmcp-testing turned on.
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force $profileDir | Out-Null }
$localStatePath = Join-Path $profileDir "Local State"
if (Test-Path $localStatePath) {
    $state = Get-Content $localStatePath -Raw | ConvertFrom-Json
} else {
    $state = [pscustomobject]@{}
}
if (-not $state.PSObject.Properties["browser"]) { $state | Add-Member browser ([pscustomobject]@{}) }
$flags = @()
if ($state.browser.PSObject.Properties["enabled_labs_experiments"]) { $flags = @($state.browser.enabled_labs_experiments) }
if ($flags -notcontains "enable-webmcp-testing@1") {
    $flags = @($flags | Where-Object { $_ -notlike "enable-webmcp-testing@*" }) + "enable-webmcp-testing@1"
    $state.browser | Add-Member enabled_labs_experiments $flags -Force
    [IO.File]::WriteAllText($localStatePath, ($state | ConvertTo-Json -Depth 50))
}

# 2. Start Chrome (or reuse the dedicated instance if it is already running with the debug port).
function Get-DebugVersion { try { Invoke-RestMethod "http://127.0.0.1:$port/json/version" -TimeoutSec 2 } catch { $null } }
$version = Get-DebugVersion
if (-not $version) {
    # Started through WMI so Chrome is not a child of this script: when the MCP bridge
    # (Claude) starts this script, closing Claude must not close the Chrome window.
    $cmdLine = "`"$chrome`" --user-data-dir=`"$profileDir`" --enable-unsafe-extension-debugging " +
               "--remote-debugging-port=$port --no-first-run --no-default-browser-check about:blank"
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
    if ($r.ReturnValue -ne 0) { throw "Starting Chrome failed (Win32_Process.Create returned $($r.ReturnValue))." }
    for ($i = 0; $i -lt 30 -and -not $version; $i++) { Start-Sleep -Milliseconds 500; $version = Get-DebugVersion }
    if (-not $version) { throw "Chrome did not open the debugging port $port. Close the 'TSIWebMCP' Chrome window and retry." }
}

# 3. Load the unpacked extension via CDP.
function Invoke-Cdp([string]$wsUrl, [string]$method, [hashtable]$params) {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ct = [Threading.CancellationToken]::None
    $ws.ConnectAsync([Uri]$wsUrl, $ct).Wait()
    $msg = @{ id = 1; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 10
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), "Text", $true, $ct).Wait()
    $buffer = New-Object byte[] 65536
    $sb = New-Object Text.StringBuilder
    do {
        $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), $ct).Result
        [void]$sb.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
    } while (-not $res.EndOfMessage)
    $ws.Dispose()
    return $sb.ToString() | ConvertFrom-Json
}

$reply = Invoke-Cdp $version.webSocketDebuggerUrl "Extensions.loadUnpacked" @{ path = $extension }
if ($reply.error) { throw "Loading the extension failed: $($reply.error.message)" }
Write-Host "TSI Docs WebMCP extension loaded (id $($reply.result.id))."

# 4. Open the docs (the content script only runs on pages loaded after the extension).
Invoke-RestMethod -Method Put "http://127.0.0.1:$port/json/new?$startUrl" | Out-Null
Write-Host "Opened $startUrl - WebMCP tools are registered on document.modelContext."
