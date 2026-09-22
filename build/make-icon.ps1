# 生成 256x256 应用图标 PNG(渐变圆角卡 + "卡"字),供 Node 脚本封装为 .ico
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角矩形路径(现代 squircle 风格,圆角约 22%)
$r = 56
$rect = New-Object System.Drawing.Rectangle(8, 8, ($size - 16), ($size - 16))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = 2 * $r
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

# 品牌渐变(与应用 UI 一致:蓝紫)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 91, 108, 245),
    [System.Drawing.Color]::FromArgb(255, 139, 92, 246),
    45)
$g.FillPath($brush, $path)

# 白色"卡"(U+5361)字居中;用码位写法避免 PS1 文件非 ASCII 编码问题
$ch = [char]0x5361
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 130, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(0, -6, $size, $size)
$g.DrawString($ch, $font, [System.Drawing.Brushes]::White, $textRect, $sf)

$g.Dispose()
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "icon png saved: $($args[0])"
