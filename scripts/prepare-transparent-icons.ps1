param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'assets\icon\icon-512.png'
$outputDirectory = Join-Path $root '.generated\icons'
$pngSizes = @(16, 24, 32, 48, 64, 128, 256, 512)

# Normalized rounded rectangle of the icon body. Source files stay read-only.
$iconBody = @{
  X = (70.0 / 512.0)
  Y = (72.0 / 512.0)
  Width = (374.0 / 512.0)
  Height = (368.0 / 512.0)
  Radius = (60.0 / 512.0)
}

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $diameter = $Radius * 2.0
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-NormalizedBitmap {
  param([System.Drawing.Image]$Image)

  $bitmap = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($Image, [System.Drawing.Rectangle]::new(0, 0, 512, 512))
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Test-MeaningfulAlpha {
  param([System.Drawing.Bitmap]$Bitmap)

  $checked = 0
  $transparent = 0
  for ($y = 0; $y -lt $Bitmap.Height; $y += 4) {
    for ($x = 0; $x -lt $Bitmap.Width; $x += 4) {
      $checked++
      if ($Bitmap.GetPixel($x, $y).A -lt 250) { $transparent++ }
    }
  }
  return $checked -gt 0 -and ($transparent / $checked) -gt 0.01
}

function New-BodyMask {
  $scale = 4
  $size = 512 * $scale
  $large = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($large)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $path = New-RoundedRectanglePath `
    -X ([float]($iconBody.X * $size)) `
    -Y ([float]($iconBody.Y * $size)) `
    -Width ([float]($iconBody.Width * $size)) `
    -Height ([float]($iconBody.Height * $size)) `
    -Radius ([float]($iconBody.Radius * $size))
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.FillPath($brush, $path)
  } finally {
    $path.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
  }

  $mask = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($mask)
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($large, [System.Drawing.Rectangle]::new(0, 0, 512, 512))
  } finally {
    $graphics.Dispose()
    $large.Dispose()
  }
  return $mask
}

function Add-AlphaMask {
  param(
    [System.Drawing.Bitmap]$Source,
    [System.Drawing.Bitmap]$Mask
  )

  $output = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $rectangle = [System.Drawing.Rectangle]::new(0, 0, 512, 512)
  $pixelFormat = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  $sourceData = $Source.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $pixelFormat)
  $maskData = $Mask.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $pixelFormat)
  $outputData = $output.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $pixelFormat)
  try {
    $byteCount = [Math]::Abs($sourceData.Stride) * $sourceData.Height
    $sourceBytes = [byte[]]::new($byteCount)
    $maskBytes = [byte[]]::new($byteCount)
    $outputBytes = [byte[]]::new($byteCount)
    [System.Runtime.InteropServices.Marshal]::Copy($sourceData.Scan0, $sourceBytes, 0, $byteCount)
    [System.Runtime.InteropServices.Marshal]::Copy($maskData.Scan0, $maskBytes, 0, $byteCount)

    for ($offset = 0; $offset -lt $byteCount; $offset += 4) {
      $outputBytes[$offset] = $sourceBytes[$offset]
      $outputBytes[$offset + 1] = $sourceBytes[$offset + 1]
      $outputBytes[$offset + 2] = $sourceBytes[$offset + 2]
      $outputBytes[$offset + 3] = $maskBytes[$offset + 3]
    }
    [System.Runtime.InteropServices.Marshal]::Copy($outputBytes, 0, $outputData.Scan0, $byteCount)
  } finally {
    $Source.UnlockBits($sourceData)
    $Mask.UnlockBits($maskData)
    $output.UnlockBits($outputData)
  }
  return $output
}

function Resize-TransparentBitmap {
  param(
    [System.Drawing.Bitmap]$Source,
    [int]$Size
  )

  $output = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($output)
  try {
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
  } finally {
    $graphics.Dispose()
  }
  return $output
}

function Write-MultiSizeIco {
  param(
    [string]$Destination,
    [hashtable]$PngFiles
  )

  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = @{}
  foreach ($size in $sizes) { $images[$size] = [System.IO.File]::ReadAllBytes($PngFiles[$size]) }

  $stream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    foreach ($size in $sizes) {
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$images[$size].Length)
      $writer.Write([uint32]$offset)
      $offset += $images[$size].Length
    }
    foreach ($size in $sizes) { $writer.Write($images[$size]) }
    [System.IO.File]::WriteAllBytes($Destination, $stream.ToArray())
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

function Assert-TransparentIcon {
  param([string]$Path)

  $image = [System.Drawing.Bitmap]::FromFile($Path)
  try {
    $corners = @(
      $image.GetPixel(0, 0).A,
      $image.GetPixel($image.Width - 1, 0).A,
      $image.GetPixel(0, $image.Height - 1).A,
      $image.GetPixel($image.Width - 1, $image.Height - 1).A
    )
    if (@($corners | Where-Object { $_ -ne 0 }).Count -gt 0) {
      throw "Transparency validation failed: $Path"
    }
  } finally {
    $image.Dispose()
  }
}

function Assert-TransparentIco {
  param([string]$Path)

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 22 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
    throw "Invalid ICO file: $Path"
  }
  $count = [BitConverter]::ToUInt16($bytes, 4)
  for ($index = 0; $index -lt $count; $index++) {
    $entry = 6 + $index * 16
    $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
    $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
    if ($offset + $length -gt $bytes.Length) { throw "Invalid ICO entry: $Path" }
    $imageBytes = [byte[]]::new($length)
    [Array]::Copy($bytes, $offset, $imageBytes, 0, $length)
    $stream = [System.IO.MemoryStream]::new($imageBytes, $false)
    $image = [System.Drawing.Bitmap]::FromStream($stream)
    try {
      $corners = @(
        $image.GetPixel(0, 0).A,
        $image.GetPixel($image.Width - 1, 0).A,
        $image.GetPixel(0, $image.Height - 1).A,
        $image.GetPixel($image.Width - 1, $image.Height - 1).A
      )
      if (@($corners | Where-Object { $_ -ne 0 }).Count -gt 0) {
        throw "ICO transparency validation failed: $Path"
      }
    } finally {
      $image.Dispose()
      $stream.Dispose()
    }
  }
}

if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Icon source not found: $sourcePath" }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
$normalized = $null
$mask = $null
$master = $null
try {
  $normalized = New-NormalizedBitmap -Image $sourceImage
  if (Test-MeaningfulAlpha -Bitmap $normalized) {
    $master = $normalized.Clone()
  } else {
    $mask = New-BodyMask
    $master = Add-AlphaMask -Source $normalized -Mask $mask
  }

  $pngFiles = @{}
  foreach ($size in $pngSizes) {
    $destination = Join-Path $outputDirectory "icon-$size.png"
    $resized = Resize-TransparentBitmap -Source $master -Size $size
    try {
      $resized.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $resized.Dispose()
    }
    $pngFiles[$size] = $destination
    Assert-TransparentIcon -Path $destination
  }

  Copy-Item -LiteralPath $pngFiles[256] -Destination (Join-Path $outputDirectory 'icon.png') -Force
  $icoPath = Join-Path $outputDirectory 'icon.ico'
  Write-MultiSizeIco -Destination $icoPath -PngFiles $pngFiles
  Assert-TransparentIco -Path $icoPath
} finally {
  if ($master) { $master.Dispose() }
  if ($mask) { $mask.Dispose() }
  if ($normalized) { $normalized.Dispose() }
  $sourceImage.Dispose()
}

$sourceHashAfter = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
if ($sourceHashAfter -ne $sourceHash) { throw 'Icon source changed during generation' }

Write-Host "Transparent icons generated: $outputDirectory"
Write-Host "Source unchanged: $sourceHash"
