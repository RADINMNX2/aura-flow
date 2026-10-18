# Capture a top-level window exactly as composited on the desktop (transparency included).
#   powershell -File tools/capture-window.ps1 -Title "flow. setup" -Out dev/shots/window.png
param(
  [string]$Title = "flow. setup",
  [string]$Out = "window.png",
  [switch]$Foreground
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class WinCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "window not found: $Title"; exit 2 }
if ($Foreground) { [WinCap]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null; [WinCap]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 500 }
$r = New-Object RECT
if (-not [WinCap]::GetWindowRect($proc.MainWindowHandle, [ref]$r)) { Write-Error "GetWindowRect failed"; exit 3 }
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Error "bad window size ${w}x${h}"; exit 4 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$dir = [System.IO.Path]::GetDirectoryName($full)
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"SAVED $full ($w x $h) proc=$($proc.ProcessName) pid=$($proc.Id)"
