<#
.SYNOPSIS
  把本仓库的 pi 扩展同步到 pi 的扩展目录。

.DESCRIPTION
  源：本脚本所在目录下的 *.ts
  目标：$env:PI_CODING_AGENT_DIR\extensions（默认 ~\.pi\agent\extensions）

  用哈希比对，所以能看出「哪个文件真的变了」，不会白写一遍。

.PARAMETER Name
  只同步指定的扩展（不带 .ts，可写多个），如：.\install.ps1 ai-config

.PARAMETER List
  只对比、只打印，不写任何文件。

.PARAMETER Force
  无条件覆盖，跳过哈希比对。

.EXAMPLE
  .\install.ps1
  同步全部扩展。

.EXAMPLE
  .\install.ps1 ai-config -List
  看看 ai-config.ts 的两份是否一致。

.NOTES
  同步完记得在 pi 里执行 /reload。
#>
[CmdletBinding()]
param(
	[Parameter(Position = 0, ValueFromRemainingArguments = $true)]
	[string[]]$Name,

	[switch]$List,

	[switch]$Force
)

$ErrorActionPreference = 'Stop'

# ---------- 1. 解析目标目录 ----------
$agentDir = $env:PI_CODING_AGENT_DIR
if ([string]::IsNullOrWhiteSpace($agentDir)) {
	$agentDir = Join-Path $HOME '.pi\agent'
} else {
	$agentDir = $agentDir -replace '^~', $HOME
}
$destDir = Join-Path $agentDir 'extensions'

$srcDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($srcDir)) { $srcDir = (Get-Location).Path }

Write-Host ''
Write-Host 'pi 扩展同步' -ForegroundColor Cyan
Write-Host "  源    $srcDir"
Write-Host "  目标  $destDir"
if ($List) { Write-Host '  模式  仅对比（-List），不写文件' -ForegroundColor Yellow }
Write-Host ''

# ---------- 2. 收集待同步文件 ----------
$sources = @(Get-ChildItem -Path (Join-Path $srcDir '*.ts') -File -ErrorAction SilentlyContinue)

if ($sources.Count -eq 0) {
	Write-Host "错误：在 $srcDir 里没找到任何 .ts 扩展文件。" -ForegroundColor Red
	exit 1
}

if ($Name -and $Name.Count -gt 0) {
	$wanted = $Name | ForEach-Object { $_.Trim() -replace '\.ts$', '' } | Where-Object { $_ }
	$picked = @($sources | Where-Object { $wanted -contains $_.BaseName })
	$missing = @($wanted | Where-Object { $sources.BaseName -notcontains $_ })
	if ($missing.Count -gt 0) {
		Write-Host ("错误：找不到这些扩展：{0}" -f ($missing -join ', ')) -ForegroundColor Red
		Write-Host ("  可用：{0}" -f (($sources | ForEach-Object { $_.BaseName }) -join ', ')) -ForegroundColor DarkGray
		exit 1
	}
	$sources = $picked
}

# ---------- 3. 比对并同步 ----------
if (-not (Test-Path -LiteralPath $destDir)) {
	if ($List) {
		Write-Host "目标目录还不存在：$destDir" -ForegroundColor Yellow
	} else {
		New-Item -ItemType Directory -Path $destDir -Force | Out-Null
		Write-Host "已创建目标目录" -ForegroundColor DarkGray
	}
}

$added = 0
$updated = 0
$same = 0

foreach ($f in $sources) {
	$dest = Join-Path $destDir $f.Name
	$status = $null
	$color = 'Gray'

	if (-not (Test-Path -LiteralPath $dest)) {
		$status = '新增'
		$color = 'Green'
		$added++
	} elseif ($Force) {
		$status = '覆盖'
		$color = 'Yellow'
		$updated++
	} else {
		$hSrc = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
		$hDst = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
		if ($hSrc -eq $hDst) {
			$status = '最新'
			$color = 'DarkGray'
			$same++
		} else {
			$status = '更新'
			$color = 'Yellow'
			$updated++
		}
	}

	$line = "  [{0}] {1}" -f $status, $f.Name
	if ($status -eq '更新' -or $status -eq '覆盖') {
		$line += ("  （{0} → {1}）" -f $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'), (Get-Item -LiteralPath $dest).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
	}
	Write-Host $line -ForegroundColor $color

	if (-not $List -and $status -ne '最新') {
		Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
	}
}

# ---------- 4. 汇总 ----------
Write-Host ''
Write-Host ("{0} 个扩展：{1} 更新, {2} 新增, {3} 未变" -f $sources.Count, $updated, $added, $same)

$changed = $updated + $added
if ($List) {
	if ($changed -eq 0) {
		Write-Host '两份完全一致。' -ForegroundColor Green
	} else {
		Write-Host "有 $changed 个文件不一致，跑 .\install.ps1 同步。" -ForegroundColor Yellow
	}
} elseif ($changed -eq 0) {
	Write-Host '无需改动，不用 /reload。' -ForegroundColor Green
} else {
	Write-Host '→ 在 pi 里执行 /reload 生效' -ForegroundColor Cyan
}

exit 0
