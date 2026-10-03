<#
.SYNOPSIS
  把本仓库的 pi 扩展和助理模板同步到 pi 的配置目录。

.DESCRIPTION
  源 1：本脚本所在目录下的 *.ts                → <agentDir>\extensions
  源 2：本脚本所在目录下 assistants\*.md       → <agentDir>\assistants
  <agentDir> = $env:PI_CODING_AGENT_DIR，默认 ~\.pi\agent

  用哈希比对，所以能看出「哪个文件真的变了」，不会白写一遍。

.PARAMETER Name
  只同步指定的名字（不带扩展名，可写多个），同时匹配 .ts 和 .md。
  如：.\install.ps1 db

.PARAMETER List
  只对比、只打印，不写任何文件。

.PARAMETER Force
  无条件覆盖，跳过哈希比对。

.EXAMPLE
  .\install.ps1
  同步全部扩展 + 全部助理模板。

.EXAMPLE
  .\install.ps1 -List
  看看哪些文件跟生效副本不一致。

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
$asstDestDir = Join-Path $agentDir 'assistants'

$srcDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($srcDir)) { $srcDir = (Get-Location).Path }
$asstSrcDir = Join-Path $srcDir 'assistants'

Write-Host ''
Write-Host 'pi 扩展同步' -ForegroundColor Cyan
Write-Host "  源    $srcDir"
Write-Host "  目标  $agentDir"
if ($List) { Write-Host '  模式  仅对比（-List），不写文件' -ForegroundColor Yellow }
Write-Host ''

# ---------- 2. 收集待同步文件 ----------
$sources = @(Get-ChildItem -Path (Join-Path $srcDir '*.ts') -File -ErrorAction SilentlyContinue)
$asstFiles = @(Get-ChildItem -Path (Join-Path $asstSrcDir '*.md') -File -ErrorAction SilentlyContinue)

if ($sources.Count -eq 0 -and $asstFiles.Count -eq 0) {
	Write-Host "错误：在 $srcDir 里没找到任何 .ts 扩展，也没有 assistants\*.md。" -ForegroundColor Red
	exit 1
}

if ($Name -and $Name.Count -gt 0) {
	$wanted = @($Name | ForEach-Object { $_.Trim() -replace '\.(ts|md)$', '' } | Where-Object { $_ })
	$allKeys = @($sources.BaseName) + @($asstFiles.BaseName)
	$missing = @($wanted | Where-Object { $allKeys -notcontains $_ })
	if ($missing.Count -gt 0) {
		Write-Host ("错误：找不到这些名字：{0}" -f ($missing -join ', ')) -ForegroundColor Red
		Write-Host ("  可用：{0}" -f (($allKeys | Sort-Object) -join ', ')) -ForegroundColor DarkGray
		exit 1
	}
	$sources = @($sources | Where-Object { $wanted -contains $_.BaseName })
	$asstFiles = @($asstFiles | Where-Object { $wanted -contains $_.BaseName })
}

# ---------- 3. 比对并同步 ----------
function Sync-Files {
	param(
		[System.IO.FileInfo[]]$Files,
		[string]$Dest
	)
	$added = 0
	$updated = 0
	$same = 0

	if (-not (Test-Path -LiteralPath $Dest)) {
		if ($List) {
			Write-Host "  目标目录还不存在：$Dest" -ForegroundColor Yellow
		} else {
			New-Item -ItemType Directory -Path $Dest -Force | Out-Null
			Write-Host "  已创建 $Dest" -ForegroundColor DarkGray
		}
	}

	foreach ($f in $Files) {
		$target = Join-Path $Dest $f.Name
		$status = $null
		$color = 'Gray'

		if (-not (Test-Path -LiteralPath $target)) {
			$status = '新增'
			$color = 'Green'
			$added++
		} elseif ($Force) {
			$status = '覆盖'
			$color = 'Yellow'
			$updated++
		} else {
			$hSrc = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
			$hDst = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
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
			$line += ("  （{0} → {1}）" -f $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'), (Get-Item -LiteralPath $target).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
		}
		Write-Host $line -ForegroundColor $color

		if (-not $List -and $status -ne '最新') {
			Copy-Item -LiteralPath $f.FullName -Destination $target -Force
		}
	}

	return [pscustomobject]@{ Added = $added; Updated = $updated; Same = $same; Total = $Files.Count }
}

$extResult = Sync-Files -Files $sources -Dest $destDir

$asstResult = $null
if ($asstFiles.Count -gt 0) {
	Write-Host ''
	$asstResult = Sync-Files -Files $asstFiles -Dest $asstDestDir
}

# ---------- 4. 汇总 ----------
Write-Host ''
$changed = $extResult.Updated + $extResult.Added
if ($extResult.Total -gt 0) {
	Write-Host ("{0} 个扩展：{1} 更新, {2} 新增, {3} 未变" -f $extResult.Total, $extResult.Updated, $extResult.Added, $extResult.Same)
}
if ($asstResult -and $asstResult.Total -gt 0) {
	$changed += $asstResult.Updated + $asstResult.Added
	Write-Host ("{0} 个助理模板：{1} 更新, {2} 新增, {3} 未变" -f $asstResult.Total, $asstResult.Updated, $asstResult.Added, $asstResult.Same)
}

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
