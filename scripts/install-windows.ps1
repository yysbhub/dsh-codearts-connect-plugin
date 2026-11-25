<#
.SYNOPSIS
  在另一台 Windows 机器上安装 dsh-codearts-connect。

.DESCRIPTION
  前提：
    1. 该机已安装 DeepSeek Harness 桌面版（0.2.x）并能正常启动；
    2. 该机已安装 CodeArts Agent（码道）桌面端，并已登录过一次；
    3. Python 3 可用（`python --version`），且装有 cryptography
       （仅 `bin.js login` 需要它读取码道登录态）。

  脚本做四件事，全部幂等：
    a. 把插件解包/复制到 %USERPROFILE%\.dsh\plugins\dsh-codearts-connect
    b. dsh plugin --profile <profile> add "file:<该目录>"
    c. 把插件名补进该 profile 的 dsh.profile.bundles
    d. 检查登录态文档；缺失时打印 bin.js login 的用法

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Profile migrate
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Source .\dsh-codearts-connect-0.4.0.zip
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    # 包来源：插件目录、.zip 或 .tgz。默认取脚本所在目录的上一层（即插件根目录）。
    [string]$Source = '',
    [string]$DshHome = '',
    # 已把 .codearts-session.json 放到默认位置时用 -SkipLoginHint 静默跳过。
    [switch]$SkipLoginHint
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-codearts-connect'

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$dshHome = $DshHome
$target = Join-Path $dshHome "plugins\$pluginName"
$profileDir = Join-Path $dshHome "profiles\$Profile"
$sessionFile = Join-Path $dshHome '.codearts-session.json'

if (-not $Source) {
    # 脚本位于 <plugin>/scripts/ 时，插件根目录是上一层。
    $Source = Split-Path -Parent $PSScriptRoot
}

Write-Host "== 插件目标目录: $target"
Write-Host "== profile     : $profileDir"
Write-Host "== 包来源      : $Source"

# ── a. 放置插件文件 ────────────────────────────────────────────────────
# 在给定目录里定位插件根（兼容 zip 的 <name>-<version>/ 前缀与 npm 的 package/ 前缀）
function Resolve-PluginRoot([string]$Dir) {
    if (Test-Path (Join-Path $Dir 'package.json')) { return $Dir }
    $candidates = @(Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
    foreach ($candidate in $candidates) {
        try {
            if ((Get-Content (Join-Path $candidate.FullName 'package.json') -Raw -Encoding utf8 |
                    ConvertFrom-Json).name -eq $pluginName) {
                return $candidate.FullName
            }
        } catch { }
    }
    if ($candidates.Count -eq 1) { return $candidates[0].FullName }
    throw "来源里找不到插件根目录（没有 package.json）: $Dir"
}

if (Test-Path $Source -PathType Leaf) {
    $ext = [IO.Path]::GetExtension($Source).ToLowerInvariant()
    $stage = Join-Path ([IO.Path]::GetTempPath()) ("codearts-stage-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    if ($ext -eq '.zip') {
        Expand-Archive -LiteralPath $Source -DestinationPath $stage -Force
    } elseif ($ext -eq '.tgz' -or $ext -eq '.tar') {
        tar -xzf $Source -C $stage
    } else {
        throw "不支持的包类型: $ext（用 .zip 或 .tgz）"
    }
    $Source = Resolve-PluginRoot $stage
    # 记住临时目录，结束时清理
    $stagedSource = $Source
    $stagedRoot = $stage
} else {
    $Source = Resolve-PluginRoot $Source
}

function Get-PluginFingerprint([string]$Dir) {
    # 版本 + 主入口内容即可判断是否为同一份代码，避免重复备份/复制。
    $manifestPath = Join-Path $Dir 'package.json'
    if (-not (Test-Path $manifestPath)) { return $null }
    $version = (Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json).version
    $entry = Join-Path $Dir 'lib\index.js'
    $hash = if (Test-Path $entry) { (Get-FileHash $entry -Algorithm SHA256).Hash } else { '' }
    return "$version|$hash"
}

$sourceFingerprint = Get-PluginFingerprint $Source
$targetFingerprint = if (Test-Path $target) { Get-PluginFingerprint $target } else { $null }
$samePath = (Resolve-Path $Source).Path -eq (Resolve-Path $target -ErrorAction SilentlyContinue).Path

if ($samePath) {
    Write-Host "   插件已在目标目录，跳过复制"
} elseif ($sourceFingerprint -and $sourceFingerprint -eq $targetFingerprint) {
    Write-Host "   目标目录已是同一版本（$($sourceFingerprint.Split('|')[0])），跳过复制"
} else {
    if (Test-Path $target) {
        # 保留已有的（可能被本地改过的）配置文件，整体覆盖代码。
        $backup = "$target.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
        Copy-Item -LiteralPath $target -Destination $backup -Recurse -Force
        Write-Host "   已备份旧版本到 $backup"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $target -Recurse -Force
    Write-Host "   插件文件已就位"
}

# ── b. 注册到 profile ─────────────────────────────────────────────────
if (-not (Test-Path $profileDir)) {
    throw "profile 不存在: $profileDir（先用 DSH 桌面版启动一次，或指定 -Profile）"
}

$dshCli = $null
foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )) {
    if (Test-Path $candidate) { $dshCli = $candidate; break }
}
if (-not $dshCli) {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { $dshCli = $command.Source }
}

$specifier = 'file:' + ($target -replace '\\', '/')
$pluginInstalled = Test-Path (Join-Path $profileDir "node_modules\$pluginName\package.json")
if ($dshCli) {
    Write-Host "== dsh plugin add $specifier"
    # Start-Process 把两个输出流都写进文件：pnpm 的警告走 stderr，而本脚本
    # EAP=Stop，若让 stderr 进入 PowerShell 管道会被当成致命错误中断后续步骤。
    $logBase = Join-Path ([IO.Path]::GetTempPath()) ("codearts-plugin-add-" + [guid]::NewGuid().ToString('N'))
    $outLog = "$logBase.out.log"
    $errLog = "$logBase.err.log"
    $process = Start-Process -FilePath $dshCli -ArgumentList @('plugin', '--profile', $Profile, 'add', $specifier) `
        -Wait -PassThru -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $code = $process.ExitCode
    $logText = @()
    foreach ($file in @($outLog, $errLog)) {
        if (Test-Path $file) { $logText += Get-Content $file -Raw -ErrorAction SilentlyContinue }
    }
    $logText = ($logText -join "`n")
    # pnpm 11 exits 1 on ERR_PNPM_IGNORED_BUILDS even though the install itself
    # succeeded (the ignored scripts belong to peer deps DSH provides at runtime).
    $pluginInstalled = Test-Path (Join-Path $profileDir "node_modules\$pluginName\package.json")
    if ($pluginInstalled) {
        if ($code -ne 0 -and $logText -match 'ERR_PNPM_IGNORED_BUILDS') {
            Write-Host "   插件已装入（pnpm 因 peer 依赖的构建脚本被忽略而返回 $code，可忽略）"
        } else {
            Write-Host "   插件已装入"
        }
    } else {
        Write-Warning "dsh plugin add 未装成（退出码 $code）；手工执行：dsh plugin --profile $Profile add `"$specifier`""
        if ($logText) { Write-Host ($logText.Trim() -split "`n" | Select-Object -Last 10 | Out-String) }
    }
    Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
} else {
    Write-Warning "没找到 dsh CLI。请手动在该 profile 目录执行: pnpm add `"$specifier`""
}
if (-not $pluginInstalled) {
    throw "插件未安装到 profile（$profileDir\node_modules\$pluginName）"
}

# ── c. 补 bundles 列表 ────────────────────────────────────────────────
$profileManifest = Join-Path $profileDir 'package.json'
$manifest = Get-Content -LiteralPath $profileManifest -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $manifest.dsh.profile.bundles) {
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains $pluginName) {
    $manifest.dsh.profile.bundles = @($bundles + $pluginName)
    # DSH parses this file with JSON.parse, which rejects a UTF-8 BOM — and
    # PowerShell 5.1's `Set-Content -Encoding utf8` writes one. Write no-BOM.
    $json = $manifest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($profileManifest, $json, [Text.UTF8Encoding]::new($false))
    Write-Host "   已把 $pluginName 加入 profile bundles"
} else {
    Write-Host "   profile bundles 已包含 $pluginName"
}

# ── d. 登录态 ─────────────────────────────────────────────────────────
if (Test-Path $sessionFile) {
    Write-Host "== 登录态文档已存在: $sessionFile"
    Write-Host "   如已过期，在插件目录执行: node `"$target\bin.js`" login"
} elseif (-not $SkipLoginHint) {
    Write-Host "== 还没有登录态文档，下一步执行："
    Write-Host "   node `"$target\bin.js`" login"
    Write-Host "   （需要码道桌面端已登录；也可以用 import 导入另一台机器导出的 session 文档）"
}

Write-Host ""
Write-Host "完成。重启 DeepSeek Harness 后，模型选择器里会出现 CodeArts Agent（码道）分组。"
Write-Host "核对模型目录: node `"$target\bin.js`" models"

if ($stagedRoot) {
    Remove-Item -LiteralPath $stagedRoot -Recurse -Force -ErrorAction SilentlyContinue
}
