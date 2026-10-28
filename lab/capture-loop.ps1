# Diagnostic helper: capture the DSH window area on a timer.
# Not part of the plugin. Safe to delete after the investigation.
# ASCII only: Windows PowerShell 5.1 mis-parses UTF-8 without a BOM.
param(
  [int]$IntervalMs = 1000,
  [int]$BudgetSec = 900,
  [string]$OutDir = "$env:TEMP\dsh-capture",
  [int]$ScalePercent = 60,
  [int]$Quality = 60
)

Add-Type -AssemblyName System.Drawing
if (-not ('Win32Rect' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct Win32Rect { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Win32Rect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

$deadline = (Get-Date).AddSeconds($BudgetSec)
$index = 0

while ((Get-Date) -lt $deadline) {
  $index++
  $stamp = Get-Date -Format 'HH:mm:ss.fff'
  $proc = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.ProcessName -eq 'DeepSeek Harness' -and [Win32Win]::IsWindowVisible($_.MainWindowHandle)
  } | Select-Object -First 1

  if ($null -eq $proc) {
    Write-Output ("{0} {1} NO_WINDOW" -f $index, $stamp)
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }

  $hwnd = $proc.MainWindowHandle
  $rect = New-Object Win32Rect
  if (-not [Win32Win]::GetWindowRect($hwnd, [ref]$rect)) {
    Write-Output ("{0} {1} NO_RECT" -f $index, $stamp)
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0 -or [Win32Win]::IsIconic($hwnd)) {
    Write-Output ("{0} {1} SKIP {2}x{3}" -f $index, $stamp, $width, $height)
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }

  try {
    $full = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($full)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    } finally {
      $graphics.Dispose()
    }
    $small = New-Object System.Drawing.Bitmap($full, [int]($width * $ScalePercent / 100), [int]($height * $ScalePercent / 100))
    $file = Join-Path $OutDir ("frame-{0:d5}.jpg" -f $index)
    $small.Save($file, $jpeg, $encoderParams)
    $small.Dispose()
    $full.Dispose()
    Write-Output ("{0} {1} pid={2} rect={3},{4} {5}x{6} saved" -f $index, $stamp, $proc.Id, $rect.Left, $rect.Top, $width, $height)
  } catch {
    Write-Output ("{0} {1} CAPTURE_ERROR {2}" -f $index, $stamp, $_.Exception.Message)
  }
  Start-Sleep -Milliseconds $IntervalMs
}

Write-Output 'DONE'
