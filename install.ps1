<#
.SYNOPSIS
  把本仓库的 pi 扩展和助理模板同步到 pi 的配置目录。

.DESCRIPTION
  源 1：本脚本所在目录下的扩展 → <agentDir>\extensions
        扩展有两种形态：
          ① 根级单文件    xxx.ts
          ② 目录式插件    <名字>\index.ts（·整棵目录一起同步）
  源 2：本脚本所在目录下 assistants\*.md → <agentDir>\assistants
  <agentDir> = $env:PI_CODING_AGENT_DIR，默认 ~\.pi\agent

  用哈希比对，所以能看出「哪个文件真的变了」，不会白写一遍。

  还会「清理孤儿」：目标目录里已经不存在于源里的根级 .ts/.js 和插件目录会被删掉。
  这一步是必要的 —— pi 会同时加载 extensions\*.ts 和 extensions\<name>\index.ts，
  旧形态没删干净就会和新目录同时生效，同一个工具被注册两遍。

.PARAMETER Name
  只同步指定的名字（不带扩展名，可写多个），同时匹配 .ts 和 .md。
  如：.\install.ps1 db

.PARAMETER List
  只对比、只打印，不写任何文件。

.PARAMETER Force
  无条件覆盖，跳过哈希比对。

.PARAMETER ForceExtensions
  即使检测到「pi 包」通道已加载本扩展，也强制同步扩展（不推荐：会和包通道各装一份）。

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

	[switch]$Force,

	[switch]$ForceExtensions
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

# ---------- 2. 收集待同步的文件 ----------
# 扩展有两种形态：
#   ① 根级单文件      xxx.ts
#   ② 目录式插件      <名字>/index.ts（整棵目录一起同步）
# pi 两种都加载 —— 所以两种都要同步。
$extItems = New-Object System.Collections.Generic.List[object]
$pluginNames = New-Object System.Collections.Generic.List[string]

foreach ($f in @(Get-ChildItem -Path (Join-Path $srcDir '*.ts') -File -ErrorAction SilentlyContinue)) {
	$extItems.Add([pscustomobject]@{ Rel = $f.Name; Src = $f.FullName; Key = $f.BaseName; Stamp = $f.LastWriteTime })
}
foreach ($d in @(Get-ChildItem -Path $srcDir -Directory -ErrorAction SilentlyContinue)) {
	$entry = @('index.ts', 'index.js') |
		ForEach-Object { Join-Path $d.FullName $_ } |
		Where-Object { Test-Path -LiteralPath $_ } |
		Select-Object -First 1
	if (-not $entry) { continue }
	$pluginNames.Add($d.Name)
	foreach ($f in @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File -ErrorAction SilentlyContinue)) {
		$rel = $f.FullName.Substring($srcDir.Length).TrimStart('\', '/')
		$extItems.Add([pscustomobject]@{ Rel = $rel; Src = $f.FullName; Key = $d.Name; Stamp = $f.LastWriteTime })
	}
}

$asstFiles = @(Get-ChildItem -Path (Join-Path $asstSrcDir '*.md') -File -ErrorAction SilentlyContinue)

if ($extItems.Count -eq 0 -and $asstFiles.Count -eq 0) {
	Write-Host "错误：在 $srcDir 里没找到任何扩展（.ts 或含 index.ts 的目录），也没有 assistants\*.md。" -ForegroundColor Red
	exit 1
}

$partial = $false
if ($Name -and $Name.Count -gt 0) {
	$partial = $true
	$wanted = @($Name | ForEach-Object { $_.Trim() -replace '\.(ts|md)$', '' } | Where-Object { $_ })
	$allKeys = @($extItems.Key | Sort-Object -Unique) + @($asstFiles.BaseName)
	$missing = @($wanted | Where-Object { $allKeys -notcontains $_ })
	if ($missing.Count -gt 0) {
		Write-Host ("错误：找不到这些名字：{0}" -f ($missing -join ', ')) -ForegroundColor Red
		Write-Host ("  可用：{0}" -f (($allKeys | Sort-Object) -join ', ')) -ForegroundColor DarkGray
		exit 1
	}
	$extItems = @($extItems | Where-Object { $wanted -contains $_.Key })
	$pluginNames = @($pluginNames | Where-Object { $wanted -contains $_ })
	$asstFiles = @($asstFiles | Where-Object { $wanted -contains $_.BaseName })
}

# ---------- 2b. 双通道护栅：别和「pi 包」通道各装一份 ----------
# pi 从两个地方加载扩展：
#   ① settings.json 的 packages（pi install 装的「包」）
#   ② extensions\*.ts / extensions\<名字>\index.ts（本脚本同步的形态）
# 两条通道都命中 = 同一个工具注册两遍 = 扩展整个加载失败（Tool "progress" conflicts）。
# 检测到「包」通道时，本脚本对扩展退让（不写、也不清孤儿），只同步助理模板。
$settingsPath = Join-Path $agentDir 'settings.json'
$packageChannel = $null
if (Test-Path -LiteralPath $settingsPath) {
	try {
		$pkgSettings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
		$packageChannel = @($pkgSettings.packages | Where-Object { $_ -match 'pi-extensions' }) | Select-Object -First 1
	} catch {
		Write-Host "  （读 settings.json 失败，跳过双通道检查：$($_.Exception.Message)）" -ForegroundColor DarkGray
	}
}

$skipExtensions = $false
if ($packageChannel -and -not $ForceExtensions) {
	$skipExtensions = $true
	Write-Host ''
	Write-Host '⚠ 检测到扩展已由「pi 包」通道加载：' -ForegroundColor Yellow
	Write-Host ("    {0}" -f $packageChannel) -ForegroundColor Yellow
	Write-Host '  两条通道各装一份会让同一个工具注册两遍（Tool "progress" conflicts），' -ForegroundColor Yellow
	Write-Host '  扩展会整个加载失败。本次 **跳过扩展同步**（不写、也不清孤儿），只同步助理模板。' -ForegroundColor Yellow
	Write-Host ''
	Write-Host '  要让本脚本接管扩展，二选一：' -ForegroundColor DarkGray
	Write-Host '    1) 先解除包通道：pi remove git:github.com/zeke-center/pi-extensions' -ForegroundColor DarkGray
	Write-Host '       再删掉 extensions\ai-configure（若存在），重启 pi' -ForegroundColor DarkGray
	Write-Host '    2) 或加 -ForceExtensions 强制同步（不推荐：会和包通道双份）' -ForegroundColor DarkGray
	Write-Host ''
	$extItems = @()
	$pluginNames = @()
}

# ---------- 3. 比对并同步 ----------
function Sync-Tree {
	param(
		[object[]]$Items,
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

	foreach ($it in $Items) {
		$target = Join-Path $Dest $it.Rel
		$parent = Split-Path -Path $target -Parent
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
			$hSrc = (Get-FileHash -LiteralPath $it.Src -Algorithm SHA256).Hash
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

		$line = "  [{0}] {1}" -f $status, $it.Rel
		if ($status -eq '更新' -or $status -eq '覆盖') {
			$line += ("  （{0} → {1}）" -f $it.Stamp.ToString('yyyy-MM-dd HH:mm'), (Get-Item -LiteralPath $target).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
		}
		Write-Host $line -ForegroundColor $color

		if (-not $List -and $status -ne '最新') {
			if (-not (Test-Path -LiteralPath $parent)) {
				New-Item -ItemType Directory -Path $parent -Force | Out-Null
			}
			Copy-Item -LiteralPath $it.Src -Destination $target -Force
		}
	}

	return [pscustomobject]@{ Added = $added; Updated = $updated; Same = $same; Total = $Items.Count }
}

$extResult = if ($skipExtensions) { $null } else { Sync-Tree -Items $extItems -Dest $destDir }

# ---------- 3b. 清理孤儿 ----------
# pi 同时加载 extensions\*.ts 和 extensions\<name>\index.ts。
# 旧形态没删干净 = 新旧同时生效 = 同一个工具被注册两遍。
# 删除范围严格限定：① 根级 .ts / .js  ② 含 index.ts / index.js 的子目录。
if (-not $partial -and -not $skipExtensions) {
	$orphans = @()
	if (Test-Path -LiteralPath $destDir) {
		$keepRel = @($extItems.Rel)
		foreach ($f in @(Get-ChildItem -LiteralPath $destDir -File -ErrorAction SilentlyContinue)) {
			if ($f.Extension -notin @('.ts', '.js')) { continue }
			if ($keepRel -contains $f.Name) { continue }
			$orphans += [pscustomobject]@{ Path = $f.FullName; Rel = $f.Name; IsDir = $false }
		}
		$keepPlugins = @($pluginNames)
		foreach ($d in @(Get-ChildItem -LiteralPath $destDir -Directory -ErrorAction SilentlyContinue)) {
			if ($keepPlugins -contains $d.Name) { continue }
			$looksLikePlugin = @('index.ts', 'index.js') |
				Where-Object { Test-Path -LiteralPath (Join-Path $d.FullName $_) }
			if (-not $looksLikePlugin) { continue }
			$orphans += [pscustomobject]@{ Path = $d.FullName; Rel = "$($d.Name)\  （整个目录）"; IsDir = $true }
		}
	}
	if ($orphans.Count -gt 0) {
		Write-Host ''
		foreach ($o in $orphans) {
			$tag = if ($List) { '待清理' } else { '清理' }
			Write-Host ("  [{0}] {1}" -f $tag, $o.Rel) -ForegroundColor Magenta
			if (-not $List) { Remove-Item -LiteralPath $o.Path -Recurse -Force }
		}
	} elseif ($partial) {
		Write-Host ''
		Write-Host '  （指定了 -Name，跳过孤儿清理）' -ForegroundColor DarkGray
	}
}

$asstResult = $null
if ($asstFiles.Count -gt 0) {
	Write-Host ''
	$asstItems = @($asstFiles | ForEach-Object {
		[pscustomobject]@{ Rel = $_.Name; Src = $_.FullName; Key = $_.BaseName; Stamp = $_.LastWriteTime }
	})
	$asstResult = Sync-Tree -Items $asstItems -Dest $asstDestDir
}

# ---------- 4. 汇总 ----------
Write-Host ''
$changed = 0
if ($extResult) { $changed = $extResult.Updated + $extResult.Added }
if ($extResult -and $extResult.Total -gt 0) {
	Write-Host ("扩展：{0} 个文件（{1} 更新, {2} 新增, {3} 未变）" -f $extResult.Total, $extResult.Updated, $extResult.Added, $extResult.Same)
} elseif ($skipExtensions) {
	Write-Host '扩展：已跳过（检测到「pi 包」通道，避免重复加载）' -ForegroundColor DarkGray
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
