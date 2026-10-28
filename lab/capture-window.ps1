# 白屏排查用：定时截取 DSH 主窗口区域。
# 仅用于本次诊断，不属于插件代码；排查结束后可删除。
param(
  [int]$IntervalMs = 1000,
  [int]$DurationSec = 300,
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
}
"@
}

$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -eq 'DeepSeek Harness' } | Select-Object -First 1
if ($null -eq $proc) { Write-Output 'NO_WINDOW'; exit 2 }
$hwnd = $proc.MainWindowHandle
$rect = New-Object Win32Rect
if (-not [Win32Win]::GetWindowRect($hwnd, [ref]$rect)) { Write-Output 'NO_RECT'; exit 3 }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output ("WINDOW pid={0} rect={1},{2} {3}x{4}" -f $proc.Id, $rect.Left, $rect.Top, $width, $height)
if ($width -le 0 -or $height -le 0) { Write-Output 'BAD_RECT'; exit 4 }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoder = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoder.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

$targetWidth = [int]($width * $ScalePercent / 100)
$targetHeight = [int]($height * $ScalePercent / 100)
$deadline = (Get-Date).AddSeconds($DurationSec)
$index = 0

while ((Get-Date) -lt $deadline) {
  $index++
  $stamp = Get-Date -Format 'HH:mm:ss.fff'
  if ([Win32Win]::IsIconic($hwnd)) {
    Write-Output ("{0} {1} SKIP_MINIMIZED" -f $index, $stamp)
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $full = New-Object System.Drawing.Bitmap($width, $height)
  $g = [System.Drawing.Graphics]::FromImage($full)
  try {
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  } finally {
    $g.Dispose()
  }
  $small = New-Object System.Drawing.Bitmap($full, $targetWidth, $targetHeight)
  $file = Join-Path $OutDir ("frame-{0:d4}.jpg" -f $index)
  $small.Save($file, $jpeg, $encoder)
  $small.Dispose()
  $full.Dispose()
  Write-Output ("{0} {1} saved {2}" -f $index, $stamp, [System.IO.Path]::GetFileName($file))
  Start-Sleep -Milliseconds $IntervalMs
}

Write-Output 'DONE'
