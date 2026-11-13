<#
================================================================================
 install.ps1 — 闲鱼自动化 · 一键安装（幂等，可以反复跑）

 设计原则（每一条都是踩出来的）：
   1. 幂等 —— 每一步都先判断"是不是已经好了"，重跑不会越装越乱。
   2. 失败软着陆 —— 拿不到中台配置、克隆失败、服务起不来，都【不中断】：
      把能装的装完，把缺的列成清单打印出来。学员电脑上能自动装的东西
      不该被一次网络问题全废掉。
   3. 不覆盖已有非空配置 —— 重装/升级不能把老板手工填的值冲掉。要覆盖加 -Force。
   4. 密钥不出现在屏幕上 —— 只打掩码。
   5. -DryRun 先预演，什么都不改。

 用法:
   powershell -ExecutionPolicy Bypass -File install.ps1
   powershell -ExecutionPolicy Bypass -File install.ps1 -InstallCode <码>
   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipDeps -NoStart   # 只落配置

 退出码: 0 = 骨架已装好（哪怕还有缺项）；1 = 参数错或前置不满足（缺少 node 等）
================================================================================
#>
[CmdletBinding()]
param(
    [string]$InstallCode = '',
    [string]$MiddleBase  = '',   # 中台下发的服务端地址；公开版留空（内部地址不入库）。要用时传 -MiddleBase <地址>
    [string]$GitBase     = 'https://gitlab.com/hym-company',
    [string]$GitToken    = '',            # 私有仓库只读 token；也可由中台下发
    [switch]$SkipDeps,                    # 跳过克隆 / npm install
    [switch]$NoStart,                     # 不启动 8093 服务
    [switch]$Force,                       # 允许覆盖已有非空配置
    [switch]$DryRun                       # 只打印计划
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Root   = $PSScriptRoot
$Parent = Split-Path -Parent $Root
$achunCfg = Join-Path $Root 'config.local.json'
$Missing = New-Object System.Collections.ArrayList
$Warned  = New-Object System.Collections.ArrayList

function Read-Json([string]$p) {
    if (-not (Test-Path $p)) { return $null }
    try { return ([System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { return $null }
}

<#
 找到依赖仓库的位置。
   ① 已有 config.local.json 里配的（重跑/升级时最重要）
   ② 环境变量
   ③ 问 lib/env.js —— 路径的约定式自愈规则只有那一份，别在这里抄第二遍
      （第一版就是抄了一遍、还漏了 Desktop 那条，把明明装好的 xianyu-monitor 当成"要克隆"）
   ④ 都没有 → 返回约定位置 <parent>\<名字>，让调用方去克隆
#>
function Resolve-DepDir([string]$Key, [string]$DefaultName, [string]$EnvName) {
    $c = Read-Json $achunCfg
    if ($c -and $c.paths) {
        $p = [string]$c.paths.$Key
        if ($p -and (Test-Path $p)) { return $p }
    }
    $e = [Environment]::GetEnvironmentVariable($EnvName)
    if ($e -and (Test-Path $e)) { return $e }
    $pp = Join-Path $Root 'tools\print-paths.js'
    if ($NodeExe -and (Test-Path $pp)) {
        try {
            $out = (& $NodeExe $pp 2>$null | Out-String)
            if ($out) {
                $o = $out | ConvertFrom-Json
                $p = [string]$o.paths.$Key
                if ($p -and (Test-Path $p)) { return $p }
            }
        } catch { }
    }
    foreach ($cand in @((Join-Path $Parent $DefaultName),
                        (Join-Path $env:USERPROFILE ('.kun\default_workspace\' + $DefaultName)))) {
        if (Test-Path $cand) { return $cand }
    }
    return (Join-Path $Parent $DefaultName)
}

function Head($t) { Write-Host ''; Write-Host ('── ' + $t + ' ' + ('─' * [Math]::Max(0, 58 - $t.Length))) -ForegroundColor Cyan }
function Ok($t)   { Write-Host ('  [ok]   ' + $t) -ForegroundColor Green }
function Info($t) { Write-Host ('  [..]   ' + $t) }
function Warn($t) { Write-Host ('  [warn] ' + $t) -ForegroundColor Yellow; [void]$Warned.Add($t) }
function Bad($t)  { Write-Host ('  [FAIL] ' + $t) -ForegroundColor Red }
function Miss($t) { Write-Host ('  [缺]   ' + $t) -ForegroundColor Yellow; [void]$Missing.Add($t) }
function Mask($s) { if (-not $s) { return '' }; if ($s.Length -le 8) { return '****' }; return $s.Substring(0,5) + '****' + $s.Substring($s.Length-3) }

# 执行一条外部命令；-DryRun 时只打印不执行
# ⚠️ 参数名不叫 $Args —— $Args 是 PowerShell 的自动变量，用它当形参会出诡异问题。
function Run([string]$Exe, [string[]]$ArgList, [string]$Why) {
    if ($DryRun) { Info ('[DryRun] ' + $Exe + ' ' + ($ArgList -join ' ') + '    # ' + $Why); return 0 }
    Info ($Why + ' -> ' + $Exe + ' ' + ($ArgList -join ' '))
    & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
    return $LASTEXITCODE
}

Write-Host ''
Write-Host '============================================================'
Write-Host '  闲鱼自动化 · 安装'
Write-Host '============================================================'
Write-Host ("  仓库根 : " + $Root)
if ($DryRun) { Write-Host '  模式   : DryRun（只预演，不改任何东西）' -ForegroundColor Yellow }

# ── 1. 前置：node / git ──────────────────────────────────────────
Head '前置检查'

# node：和 run-node.cmd 同一套四级回退，别写死版本号（自动升级会改名）
$NodeExe = $null
$vd = if ($env:XY_NODE_VERSIONS) { $env:XY_NODE_VERSIONS } else { Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions' }
if ($env:XY_NODE -and (Test-Path $env:XY_NODE)) { $NodeExe = $env:XY_NODE }
if (-not $NodeExe -and (Test-Path (Join-Path $vd 'current'))) {
    $v = ([System.IO.File]::ReadAllText((Join-Path $vd 'current'))).Trim()
    if ($v -and (Test-Path (Join-Path $vd "$v\node.exe"))) { $NodeExe = Join-Path $vd "$v\node.exe" }
}
if (-not $NodeExe -and (Test-Path $vd)) {
    $hit = Get-ChildItem $vd -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' -and $_.Name -ne 'locks' } |
        Sort-Object LastWriteTime -Descending |
        Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
    if ($hit) { $NodeExe = Join-Path $hit.FullName 'node.exe' }
}
if (-not $NodeExe) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $NodeExe = $c.Source } }

if (-not $NodeExe) {
    # 2026-11-13：这里是学员的【第一道坎】，原来只说"请先装 Node.js 18+"，
    # 没告诉他去哪下、装哪个、装完为什么还可能找不到。补全。
    Bad '找不到 Node.js —— 这是必须先装的第一个东西，装完其它才谈得上。'
    Write-Host ''
    Write-Host '  怎么装（3 步）：' -ForegroundColor Yellow
    Write-Host '    1) 打开 https://nodejs.org/zh-cn  → 下载 LTS 版'
    Write-Host '    2) 一路下一步装完（不用改任何选项）'
    Write-Host '    3) 【关掉所有命令行窗口】再双击 install.cmd'
    Write-Host '       （不关的话新装的 PATH 不生效，还会报同样的错）'
    Write-Host ''
    Write-Host '  已经装过、但这个脚本找不到？'
    Write-Host '    命令行跑  where node  看它在哪，然后 set XY_NODE=<那个路径> 再跑'
    Write-Host ''
    exit 1
}
Ok ('node: ' + $NodeExe + '  (' + (& $NodeExe -v) + ')')

$GitExe = $null
if (-not $SkipDeps) {
    $g = Get-Command git -ErrorAction SilentlyContinue
    if ($g) { $GitExe = $g.Source; Ok ('git: ' + $GitExe) }
    else { Warn '找不到 git —— 依赖仓库只能靠手动解压（见下面「下一步」）' }
}

# ── 2. 依赖仓库（这里只定义函数，调用在第 4b 步）──────────────────
# ⚠️ 注意顺序：Resolve-DepDir / Ensure-Repo 的【调用】放在「本机配置」和「中台下发」之后。
#    原因：中台下发的 git.token 要能用于克隆，而 Resolve-DepDir 要先读 config.local.json
#    才知道仓库该放哪。第一版把克隆放在最前面，于是"token 由中台给"这条路径根本走不通
#    （token 拿到时已经错过克隆了）。函数定义留在这里，调用挪到后面。
function Ensure-Repo([string]$Dir, [string]$RepoName, [string]$Marker, [string]$Why) {
    # Marker = "这个仓库确实在"的标志文件：服务是 package.json，monitor 是 publish.js
    # （xianyu-monitor 本来就没有 package.json —— 它是浏览器控制台 JS，没有构建步骤）
    if (Test-Path (Join-Path $Dir $Marker)) { Ok ($RepoName + ' 已就位: ' + $Dir); return $true }
    if (Test-Path (Join-Path $Dir '.git')) { Ok ($RepoName + ' 已克隆: ' + $Dir); return $true }
    if (Test-Path $Dir) {
        $n = @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue).Count
        if ($n -gt 0) { Warn ($RepoName + ' 目录非空但缺 ' + $Marker + ': ' + $Dir + '（' + $n + ' 项）'); return $false }
    }
    if ($SkipDeps) { Miss ($RepoName + ' 不存在（-SkipDeps）：' + $Dir + '  —— ' + $Why); return $false }
    if (-not $GitExe) { Miss ($RepoName + ' 需要手动放置到 ' + $Dir + '（没有 git，无法克隆）'); return $false }
    $url = $GitBase.TrimEnd('/') + '/' + $RepoName + '.git'
    if ($GitToken) { $url = $url -replace '^https://', ('https://oauth2:' + $GitToken + '@') }
    # ⚠️ 打印一律走脱敏 URL：DryRun 的输出最常被复制粘贴进聊天，带上 token 就是泄漏。
    $safeUrl = $url -replace 'oauth2:[^@]+@', 'oauth2:***@'
    Info ('克隆 ' + $RepoName + ' -> ' + $Dir)
    if ($DryRun) { Info ('[DryRun] git clone ' + $safeUrl + ' ' + $Dir); return $false }
    & $GitExe clone --depth 1 $url $Dir 2>&1 | ForEach-Object { Write-Host ('         ' + ($_ -replace 'oauth2:[^@]+@', 'oauth2:***@')) }
    if ($LASTEXITCODE -ne 0) {
        Miss ($RepoName + ' 克隆失败（私有仓库要 token）：git clone ' + $safeUrl + ' ' + $Dir)
        return $false
    }
    Ok ($RepoName + ' 克隆完成: ' + $Dir)
    return $true
}

# ── 3. 本机配置（paths / node）──────────────────────────────────
Head '本机配置'
$cfgTool = Join-Path $Root 'tools\install-config.js'
if (-not (Test-Path $cfgTool)) {
    Bad ('找不到 ' + $cfgTool + ' —— 仓库不完整，install-config.js 必须存在')
    exit 1
}
$argv = @($cfgTool, '--derive', '--apply')
if ($Force) { $argv += '--force' }
if ($DryRun) { $argv = @($cfgTool, '--derive') }
[void](Run $NodeExe $argv '推导本机路径并写 config.local.json')

# ── 4. 中台下发（可失败）────────────────────────────────────────
Head '中台配置下发'
$tmpResp = Join-Path $env:TEMP ('xy-install-' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.json')
$gotRemote = $false
if (-not $InstallCode) {
    Warn '没有给 -InstallCode，跳过中台下发（密钥/账号要事后手工补）'
} elseif ($DryRun) {
    Info ('[DryRun] GET ' + $MiddleBase.TrimEnd('/') + '/api/xianyu-install-config  (X-Install-Code: ' + (Mask $InstallCode) + ')')
} else {
    $url = $MiddleBase.TrimEnd('/') + '/api/xianyu-install-config'
    Info ('GET ' + $url + '  (X-Install-Code: ' + (Mask $InstallCode) + ')')
    try {
        $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 30 -Headers @{ 'X-Install-Code' = $InstallCode }
        if ($resp -and $resp.ok -eq $true) {
            ($resp | ConvertTo-Json -Depth 12) | Out-File -FilePath $tmpResp -Encoding UTF8
            Ok '中台配置已取到'
            if ($resp.git -and $resp.git.token -and -not $GitToken) { $GitToken = $resp.git.token; Info '中台下发了 git 只读 token（用于后续拉代码）' }
            $gotRemote = $true
        } else {
            Warn ('中台返回 ok!=true：' + ($resp | ConvertTo-Json -Compress -Depth 4))
            Miss '中台没有下发配置 —— 装好骨架后把 config.local.json 补齐再重跑'
        }
    } catch {
        Warn ('中台不可达 / 安装码失效：' + $_.Exception.Message)
        Miss '中台没有下发配置 —— 装好骨架后把 config.local.json 补齐再重跑'
    }
}
if ($gotRemote -and -not $DryRun) {
    $argv2 = @($cfgTool, ('--from=' + $tmpResp), '--apply')
    if ($Force) { $argv2 += '--force' }
    [void](Run $NodeExe $argv2 '把中台配置合并进 config.local.json')
}

# ── 4b. 依赖仓库（必须在"中台下发"之后 —— git.token 要能用于克隆）──
Head '依赖仓库'
# 约定布局：两个仓库并排放在本仓库的上一级。
#   <parent>\playwright-service     （gitlab: xianyu-playwright-service）
#   <parent>\xianyu-monitor
# 找不到就克隆；克隆不了就记一笔缺失，继续往下装。
$SvcDir = Resolve-DepDir 'playwrightService' 'playwright-service' 'XY_PLAYWRIGHTSERVICE'
$MonDir = Resolve-DepDir 'xianyuMonitor'     'xianyu-monitor'     'XY_XIANYUMONITOR'
$svcOk = Ensure-Repo $SvcDir 'xianyu-playwright-service' 'package.json' '8093 浏览器服务（出图/发布/账号全靠它）'
$monOk = Ensure-Repo $MonDir 'xianyu-monitor' 'publish.js' '桌面发布台 + 文案/版式库（publish.js / publish_dashboard.js）'

# ── 5. 服务侧密钥对齐 ───────────────────────────────────────────
Head '服务侧密钥'
# 8093 服务每次启动都会保证 service.local.json 里有一把密钥（没有就随机生成）。
# 这里只做检查与提示：两边不一致的话，客户端所有请求都会 401。
$svcCfg = Join-Path $SvcDir 'service.local.json'
# Read-Json / $achunCfg 在文件顶部已定义（那时就要用来找依赖仓库的路径）
$sc = Read-Json $svcCfg
$ac = Read-Json $achunCfg
if (-not (Test-Path $svcCfg)) {
    Info ('服务还没启动过，service.local.json 未生成：' + $svcCfg)
    Info '  服务第一次启动时会自己生成一把随机密钥；生成后要把同样的值填进 config.local.json 的 service.apiKey。'
} elseif ($sc -and $sc.apiKey -and $ac -and $ac.service -and $ac.service.apiKey) {
    if ($sc.apiKey -eq $ac.service.apiKey) { Ok ('两边一致：' + (Mask $sc.apiKey)) }
    else {
        Warn ('两边 apiKey 不一致！服务=' + (Mask $sc.apiKey) + '  客户端=' + (Mask $ac.service.apiKey))
        if ($DryRun) { Info '[DryRun] 会把服务侧的密钥同步进 config.local.json' }
        else {
            if (-not $ac.service) { $ac | Add-Member -NotePropertyName service -NotePropertyValue ([pscustomobject]@{}) }
            $ac.service.apiKey = $sc.apiKey
            [System.IO.File]::WriteAllText($achunCfg, ($ac | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
            Ok '已把服务侧密钥同步进 config.local.json'
        }
    }
} else { Warn '读不到其中一边的 apiKey，跳过对齐' }

# ── 6. 服务依赖 ─────────────────────────────────────────────────
Head '服务依赖'
$svcModules = Join-Path $SvcDir 'node_modules'
if ($SkipDeps) { Info '-SkipDeps：跳过 npm install' }
elseif (Test-Path (Join-Path $svcModules 'express')) { Ok 'node_modules 已就位（express/playwright/sharp）' }
else {
    # 2026-11-12 修：Get-Command npm 取的是 PATH 里第一个 npm，可能和上面检测到的
    # node 不是一套（实测：node=workbuddy v22，npm=scoop 的 npm.ps1）。版本错配装依赖会出怪问题。
    # 优先用 node 同目录的 npm，找不到才回落 PATH。
    $npm = $null
    if ($NodeExe) {
        $nodeDir = Split-Path $NodeExe -Parent
        foreach ($n in @('npm.cmd', 'npm.exe', 'npm')) {
            $cand = Join-Path $nodeDir $n
            if (Test-Path $cand) { $npm = [pscustomobject]@{ Source = $cand }; break }
        }
    }
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { Miss '需要 npm 来装服务依赖（express / playwright / sharp）' }
    else {
        Info '装服务依赖（express / playwright / sharp），首次会下载 Chromium，比较慢…'
        if ($DryRun) { Info ('[DryRun] ' + $npm.Source + ' install  (cwd=' + $SvcDir + ')') }
        else {
            Push-Location $SvcDir
            & $npm.Source install 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
            $code = $LASTEXITCODE
            Pop-Location
            if ($code -eq 0 -and (Test-Path (Join-Path $svcModules 'express'))) { Ok '服务依赖装好' }
            else { Miss '服务依赖安装失败（退出码 ' + $code + '）—— 进 ' + $SvcDir + ' 手动跑 npm install' }
        }
    }
}

# ── 7. 启动并探活 ───────────────────────────────────────────────
Head '启动 8093 服务'
$Port = 8093
if ($ac -and $ac.service -and $ac.service.port) { $Port = [int]$ac.service.port }
$probeUrl = 'http://127.0.0.1:' + $Port + '/api/agent/status'
function Test-Service {
    try { $r = Invoke-WebRequest -Uri $probeUrl -TimeoutSec 5 -UseBasicParsing; return ($r.StatusCode -eq 200) } catch { return $false }
}
if (Test-Service) { Ok ('服务已在运行：' + $probeUrl) }
elseif ($NoStart) { Info '-NoStart：不启动。手动启动：' + (Join-Path $SvcDir 'start.bat') }
elseif ($DryRun) { Info ('[DryRun] 启动 ' + (Join-Path $SvcDir 'start.bat') + ' 然后探活 ' + $probeUrl) }
else {
    $startBat = Join-Path $SvcDir 'start.bat'
    if (-not (Test-Path $startBat)) { Miss ('找不到启动脚本：' + $startBat) }
    else {
        Info '后台启动服务…'
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $startBat + '"') -WorkingDirectory $SvcDir -WindowStyle Minimized | Out-Null
        $up = $false
        for ($i = 1; $i -le 30; $i++) { Start-Sleep -Seconds 2; if (Test-Service) { $up = $true; break } }
        if ($up) { Ok ('服务已起来：' + $probeUrl) } else { Miss ('服务 60 秒内没起来，看 ' + (Join-Path $SvcDir 'startup.log')) }
    }
}

# ── 7.5 文案模板库（~/.xianyu-templates.json）────────────────────
# 2026-11-12 加：这个文件在【用户目录】下，不在代码包里。
#   而 first-publish.js 读不到它会直接报「❌ 读不到文案模板（~/.xianyu-templates.json）。先跑一次 install.ps1」——
#   但原来 install.ps1 根本不生成它，学员装完第一次发链接就卡在这个死循环上。
#   现在：包里带一份 xianyu-templates.example.json（10 套通用文案），装的时候复制到用户目录，
#   并把 storeTemplates 的占位店铺名换成学员 service.local.json 里的真实店名。
Head '文案模板库'
$tplUser    = Join-Path $env:USERPROFILE '.xianyu-templates.json'
$tplExample = Join-Path $Root 'xianyu-templates.example.json'

# 学员的店铺名：从 service.local.json 读第一个 localAccounts[].name
$studentStore = ''
$svcLocal = Join-Path $SvcDir 'service.local.json'
if (Test-Path $svcLocal) {
    try {
        $sj = Get-Content -Raw -Encoding UTF8 $svcLocal | ConvertFrom-Json
        if ($sj.localAccounts -and $sj.localAccounts.Count -gt 0) { $studentStore = [string]$sj.localAccounts[0].name }
    } catch { }
}

if (Test-Path $tplUser) {
    Ok ('已存在，不覆盖: ' + $tplUser)
}
elseif (-not (Test-Path $tplExample)) {
    Warn '包里没有 xianyu-templates.example.json —— 发布时会缺文案模板，把这条发给管理员'
}
else {
    if ($DryRun) {
        Info ('[DryRun] 生成 ' + $tplUser + '  (storeTemplates 填: ' + $(if ($studentStore) { $studentStore } else { '<你的店铺名>' }) + ')')
    }
    else {
        # 用 node 走一遍，避免 PowerShell 处理中文 JSON 转义出错
        $mk = Join-Path $Root 'tools\make-templates-from-example.js'
        if (Test-Path $mk) {
            & $NodeExe $mk --store=$studentStore 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
            if (Test-Path $tplUser) { Ok ('已生成: ' + $tplUser) }
            else { Warn '生成失败，发布时会缺文案模板' }
        }
        else { Warn '缺 tools\make-templates-from-example.js（把这条发给管理员）' }
    }
}

# ── 7.6 出图客户端（museav-cli）──────────────────────────────────
# 2026-11-12 加：老板要求「主图模板引导学员用 museav 中台」，
#   而 store-wizard.js / make-base-img.js 都要调 museav CLI。原来 install.ps1 完全不装它，
#   学员配店走到第③步必然「❌ 出图失败」，只能退回到大麦海报（抓不到就干脆没图）。
#   注意：这不影响「发布」本身 —— publish-one.js 出图走 8093 的 /api/poster/make。
#   这里装的是【店铺专属底图】那项能力。装不上不阻断，只警告。
Head '出图客户端（museav）'
$museavCmd = $null
$mg = Get-Command museav -ErrorAction SilentlyContinue
if ($mg) { $museavCmd = $mg.Source }

if ($museavCmd) {
    Ok ('museav 已装: ' + $museavCmd)
}
else {
    # 找 npm：和上面"服务依赖"同一套规则（优先 node 同目录）
    $npmForGlobal = ''
    if ($NodeExe) {
        $nd = Split-Path $NodeExe -Parent
        foreach ($n in @('npm.cmd', 'npm.exe', 'npm')) {
            $cand = Join-Path $nd $n
            if (Test-Path $cand) { $npmForGlobal = $cand; break }
        }
    }
    if (-not $npmForGlobal) { $g2 = Get-Command npm -ErrorAction SilentlyContinue; if ($g2) { $npmForGlobal = $g2.Source } }

    if (-not $npmForGlobal) { Warn '找不到 npm，装不了 museav —— 出图会退回大麦海报（不影响发布）' }
    elseif ($DryRun) { Info ('[DryRun] ' + $npmForGlobal + ' install -g museav-cli@latest') }
    else {
        Info '装 museav-cli（用于生成店铺专属底图，约 1 分钟）…'
        & $npmForGlobal install -g museav-cli@latest 2>&1 | ForEach-Object { Write-Host ('         ' + $_) }
        $mg2 = Get-Command museav -ErrorAction SilentlyContinue
        if ($mg2) {
            Ok ('museav 已装: ' + $mg2.Source)
            Info '还需要登录中台才能出图：在命令行跑一次  museav login'
        }
        else {
            Warn 'museav 没装上 —— 不影响发布，但配店时出不了"店铺专属底图"。'
            Warn '  手动补：' + $npmForGlobal + ' install -g museav-cli@latest'
        }
    }
}

# ── 8. 店铺骨架 + 自验收 ────────────────────────────────────────
Head '店铺骨架与自验收'
foreach ($d in @((Join-Path $Root 'stores'), (Join-Path $Root 'publish-assets'))) {
    if (Test-Path $d) { Ok ('已存在 ' + $d) }
    elseif ($DryRun) { Info ('[DryRun] 建目录 ' + $d) }
    else { New-Item -ItemType Directory -Force -Path $d | Out-Null; Ok ('建目录 ' + $d) }
}
if ((Test-Path (Join-Path $Root 'stores')) -and @(Get-ChildItem (Join-Path $Root 'stores') -Filter '*.json' -ErrorAction SilentlyContinue).Count -gt 0) {
    [void](Run $NodeExe @((Join-Path $Root 'tools\store-list.js')) '全店离线对照表')
} else {
    Info '还没有店铺档案 —— 用 tools\store-new.js 建一个（见「下一步」）'
}

# ── 9. 收尾 ─────────────────────────────────────────────────────
if (Test-Path $tmpResp) { Remove-Item $tmpResp -Force -ErrorAction SilentlyContinue }

Head '结果'
# DryRun 下 --derive 故意不带 --apply（预览就该什么都不改），所以这里不能报"缺 config.local.json"
if ($DryRun) { Info 'DryRun：config.local.json 的写入已跳过（正式跑会写）' }
elseif (Test-Path $achunCfg) { Ok 'config.local.json 已就绪' }
else { Miss 'config.local.json 还没有' }
if ($Missing.Count -eq 0) { Ok '没有缺失项' } else { Write-Host ('  有 ' + $Missing.Count + ' 项要补：') -ForegroundColor Yellow; $Missing | ForEach-Object { Write-Host ('    · ' + $_) } }

Write-Host ''
Write-Host '══════════ 剩下必须人工做的三件事 ══════════'
  # 2026-11-13：用学员实际填的店名（$studentStore），而不是让他自己对应占位符
  $N = if ($studentStore) { $studentStore } else { '<你的店铺名>' }
  Write-Host '  ① 闲鱼登录（滑块 / 短信验证码，机器做不了）'
  Write-Host ('       node tools\store-ready.js "' + $N + '"')
  Write-Host ('       node tools\store-login.js "' + $N + '" --wait=15')
  Write-Host '  ② 出一张主图看看（只出图，不发布）'
  Write-Host ('       $env:XY_STORE="' + $N + '"; node publish-one.js 杭州 那英 首开 --dry')
  Write-Host ('  ③ 副图（把图丢进 publish-assets\' + $N + '\副图\）')
Write-Host ''
Write-Host '  开新店：  node tools\store-new.js --list-accounts'
Write-Host '  看全局：  node tools\store-list.js'
Write-Host '  操作手册：闲鱼自动化-操作手册.md'
Write-Host ''
if ($DryRun) { Write-Host '（DryRun 模式：上面什么都没真的改）' -ForegroundColor Yellow }
exit 0
