# Diagnostic helper: wait for DSH to exit, then relaunch it with a local DevTools port.
# Not part of the plugin. Launching DSH normally afterwards removes the port.
# ASCII only: Windows PowerShell 5.1 mis-parses UTF-8 without a BOM.
param(
  [string]$Exe = 'B:\deepseek harness\DeepSeek Harness.exe',
  [int]$Port = 9222,
  [int]$WaitExitSec = 1200,
  [string]$LogFile = "$env:TEMP\dsh-launcher.log"
)

function Note([string]$line) {
  $text = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $line
  Add-Content -Path $LogFile -Value $text -Encoding utf8
}

Note "launcher started; waiting for DSH to exit (max ${WaitExitSec}s)"

$deadline = (Get-Date).AddSeconds($WaitExitSec)
while ((Get-Date) -lt $deadline) {
  $alive = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  if ($null -eq $alive) { break }
  Start-Sleep -Milliseconds 800
}

$graceDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $graceDeadline) {
  $left = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if (-not $left) { break }
  Start-Sleep -Milliseconds 800
}
$left = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($left) {
  Note "TIMEOUT: DSH still running; not restarting"
  exit 2
}
Note 'DSH stopped; relaunching with --remote-debugging-port'

Start-Sleep -Seconds 2
Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port"
Note "started $Exe"

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      Note "CDP ready: $($response.Content)"
      $ok = $true
      break
    }
  } catch {
  }
}
if (-not $ok) { Note 'CDP_NOT_READY' }
Note 'launcher done'
