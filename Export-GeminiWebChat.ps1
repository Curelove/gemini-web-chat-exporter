#requires -Version 5.1

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exporter = Join-Path $ScriptDir "gemini_web_chat_exporter.mjs"
$DefaultStateDir = if ($env:GEMINI_EXPORTER_STATE_DIR) { $env:GEMINI_EXPORTER_STATE_DIR } else { Join-Path $env:USERPROFILE ".gemini\exporter_state" }

$IncludeDetailedProcess = $false
$OutputFileName = "Gemini_Chat_Export.md"

function Write-Head {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host " Gemini 网页端对话导出工具（只读采集，绝不注入、不抢焦点）" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host ""
}

function Get-ShortText {
    param(
        [string]$Text,
        [int]$MaxLength = 46
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }

    $clean = $Text -replace "`r`n|`r|`n", " "
    $clean = $clean -replace "\s+", " "
    $clean = $clean.Trim()

    if ($clean.Length -gt $MaxLength) {
        return $clean.Substring(0, $MaxLength) + "..."
    }

    return $clean
}

function Invoke-NodeJson {
    param(
        [string[]]$Arguments
    )

    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()

    try {
        $startArgs = @{
            FilePath = "node"
            PassThru = $true
            NoNewWindow = $true
            RedirectStandardOutput = $outFile
            RedirectStandardError = $errFile
        }

        $quoted = @()
        foreach ($a in $Arguments) {
            if ($a -match "\s") { $quoted += ('"' + $a + '"') }
            else { $quoted += $a }
        }
        $startArgs["ArgumentList"] = $quoted
        $startArgs["Wait"] = $true

        $proc = Start-Process @startArgs

        $stdout = ""
        $stderr = ""
        if (Test-Path -LiteralPath $outFile) {
            $stdout = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)
        }
        if (Test-Path -LiteralPath $errFile) {
            $stderr = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8)
        }

        return [PSCustomObject]@{
            Code = $proc.ExitCode
            Out = $stdout
            Err = $stderr
        }
    }
    finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Wrap-InCodeBlock {
    param(
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }

    $cleanText = ($Text -replace "`r`n", "`n").Trim()
    $maxTicks = 0

    foreach ($match in [regex]::Matches($cleanText, '`+')) {
        if ($match.Length -gt $maxTicks) {
            $maxTicks = $match.Length
        }
    }

    $fence = '`' * [Math]::Max(3, $maxTicks + 1)

    return "$fence`n$cleanText`n$fence"
}

function Get-ClipboardGeminiUrl {
    try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { return "" }
    if ([string]::IsNullOrWhiteSpace($text)) { return "" }
    $m = [regex]::Match([string]$text, 'https://gemini\.google\.com/(?:u/\d+/)?app(?:/[0-9a-fA-F]{8,})?')
    if (-not $m.Success) { return "" }
    return $m.Value
}

function Build-MenuEntries {
    param(
        [object]$Report
    )

    $entries = New-Object System.Collections.ArrayList

    foreach ($t in @($Report.targets)) {
        $label = "[当前已打开标签页]"
        if (-not $t.readable) { $label = "[当前已打开标签页·暂不可读]" }
        $detail = ("端口 {0} · {1} 轮" -f $t.port, $t.turns)
        if ($t.is_bot_tab) { $detail = $detail + " · 原地只读" }
        [void]$entries.Add([pscustomobject]@{
            Kind   = "tab"
            Group  = "tabs"
            Label  = $label
            Title  = [string]$t.title
            Detail = $detail
            Target = $t
            Url    = [string]$t.url
            Note   = [string]$t.first_user
        })
    }

    $sidebar = $Report.sidebar
    if ($null -ne $sidebar) {
        foreach ($it in @($sidebar.pinned)) {
            [void]$entries.Add([pscustomobject]@{
                Kind   = "url"
                Group  = "sidebar"
                Label  = "[置顶对话]"
                Title  = [string]$it.title
                Detail = ("/" + $it.id)
                Target = $null
                Url    = [string]$it.url
                Note   = ""
            })
        }
        foreach ($it in @($sidebar.recent)) {
            [void]$entries.Add([pscustomobject]@{
                Kind   = "url"
                Group  = "sidebar"
                Label  = "[最新对话]"
                Title  = [string]$it.title
                Detail = ("/" + $it.id)
                Target = $null
                Url    = [string]$it.url
                Note   = ""
            })
        }
    }

    foreach ($nb in @($Report.notebooks)) {
        [void]$entries.Add([pscustomobject]@{
            Kind   = "notebook"
            Group  = "notebooks"
            Label  = "[笔记本对话]"
            Title  = [string]$nb.title
            Detail = ("/" + $nb.id)
            Target = $null
            Url    = [string]$nb.url
            Note   = ""
        })
    }

    return , $entries
}

function Show-Menu {
    param(
        [object]$Report,
        [object]$Entries,
        [string]$ClipUrl
    )

    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host " 可导出的 Gemini 会话（输入编号回车即可）" -ForegroundColor White
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray

    $groups = @(
        @{ Key = "tabs"; Title = "第一组｜当前已打开的标签页" },
        @{ Key = "sidebar"; Title = "第二组｜置顶对话 + 最近 5 个对话（已自动去重）" },
        @{ Key = "notebooks"; Title = "第三组｜笔记本与收藏对话" }
    )

    $number = 0
    $shown = 0
    foreach ($g in $groups) {
        $items = @($Entries | Where-Object { $_.Group -eq $g.Key })
        if ($items.Count -eq 0) { continue }
        Write-Host ""
        Write-Host (" " + $g.Title) -ForegroundColor DarkCyan
        foreach ($e in $items) {
            $number++
            $shown++
            Write-Host (" [{0,2}] " -f $number) -NoNewline -ForegroundColor Yellow
            Write-Host ($e.Label + " ") -NoNewline -ForegroundColor Green
            Write-Host (Get-ShortText -Text $e.Title -MaxLength 44) -NoNewline -ForegroundColor White
            Write-Host ("  " + $e.Detail) -ForegroundColor DarkGray
        }
    }

    if ($shown -eq 0) {
        Write-Host " （没扫到任何会话：受控 Chrome 里没有 Gemini 标签页，侧边栏也没读出来）" -ForegroundColor Yellow
    }

    $sidebar = $Report.sidebar
    if ($null -ne $sidebar) {
        if (-not [string]::IsNullOrWhiteSpace([string]$sidebar.error) -and [string]$sidebar.error -ne "skipped") {
            Write-Host (" 侧边栏扫描异常：" + (Get-ShortText -Text $sidebar.error -MaxLength 60)) -ForegroundColor Yellow
        }
        elseif ($sidebar.from_cache) {
            Write-Host (" （侧边栏用的是缓存，扫描于 " + [string]$sidebar.scanned_at + "，5 分钟内不重复扫）") -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    if (-not [string]::IsNullOrWhiteSpace($ClipUrl)) {
        Write-Host (" [C] 一键导出剪贴板里的 Gemini 链接（" + (Get-ShortText -Text $ClipUrl -MaxLength 52) + "）并加入收藏") -ForegroundColor Magenta
    }
    Write-Host " [B] 启动带调试端口的 Chrome 浏览器（首次登录一次 Google 账号，即可自动扫描置顶/近期/笔记本对话）" -ForegroundColor Cyan
    Write-Host " [H] 从日常普通浏览器导出（拖入保存的 .html 文件，或直接回车读取系统剪贴板）" -ForegroundColor White
    Write-Host " [U] 输入新会话 / 笔记本 URL（导出成功后自动加入收藏）" -ForegroundColor White
    Write-Host " [Q] 取消退出" -ForegroundColor White
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray

    if ($null -ne $Report.daemon -and $Report.daemon.busy -eq $true) {
        Write-Host " 提示：检测到后台自动化任务正在操作页面，将自动错峰等待" -ForegroundColor Yellow
    }
    Write-Host ""
}

function Start-DebugChrome {
    $candidates = @(
        (Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )

    $chrome = ""
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { $chrome = $c; break }
    }
    if ([string]::IsNullOrWhiteSpace($chrome)) {
        throw "没找到 Google Chrome。请先安装 Chrome（https://www.google.com/chrome/），或自行用 --remote-debugging-port=9222 启动一个已登录的浏览器。"
    }

    $profileDir = Join-Path $env:LOCALAPPDATA "GeminiWebChatExporter\chrome_profile"
    if (-not (Test-Path -LiteralPath $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }

    $chromeArgs = @(
        "--user-data-dir=`"$profileDir`"",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--no-first-run",
        "--no-default-browser-check",
        "https://gemini.google.com/app"
    )

    Start-Process -FilePath $chrome -ArgumentList $chromeArgs | Out-Null

    Write-Host ""
    Write-Host ("已启动带调试端口的 Chrome（端口 9222）：" + $chrome) -ForegroundColor Green
    Write-Host "这是一个独立的浏览器配置，第一次需要在这个窗口里登录一次 Google 账号。" -ForegroundColor Yellow
    Write-Host "登录并打开一个 Gemini 会话后，回到本窗口按回车继续。" -ForegroundColor Yellow
    Read-Host "按 Enter 键继续"
}

function Read-TargetsReport {
    $result = Invoke-NodeJson -Arguments @($Exporter, "list-targets", "--state-dir", $DefaultStateDir)
    if ($result.Code -ne 0) {
        $msg = if (-not [string]::IsNullOrWhiteSpace($result.Err)) { $result.Err.Trim() } else { $result.Out.Trim() }
        throw ("读取 Gemini 会话列表失败：" + $msg)
    }
    return ($result.Out | ConvertFrom-Json)
}

function Export-ByTarget {
    param(
        [object]$Target,
        [bool]$Detailed,
        [string]$TempJson
    )

    $nodeArgs = @(
        $Exporter, "export-cdp",
        "--port", [string]$Target.port,
        "--target", [string]$Target.targetId,
        "--state-dir", $DefaultStateDir,
        "--out-json", $TempJson
    )
    if ($Target.is_bot_tab) { $nodeArgs += "--is-bot" }
    if ($Detailed) { $nodeArgs += "--detailed" }

    $result = Invoke-NodeJson -Arguments $nodeArgs
    if ($result.Code -ne 0) {
        $msg = if (-not [string]::IsNullOrWhiteSpace($result.Err)) { $result.Err.Trim() } else { $result.Out.Trim() }
        throw $msg
    }

    if ($Target.is_bot_tab) {
        return [PSCustomObject]@{ Data = (Get-Content -LiteralPath $TempJson -Raw -Encoding UTF8 | ConvertFrom-Json); Source = "当前已打开标签页"; Bot = $true }
    }
    return [PSCustomObject]@{ Data = (Get-Content -LiteralPath $TempJson -Raw -Encoding UTF8 | ConvertFrom-Json); Source = "当前已打开标签页"; Bot = $false }
}

function Export-ByHtmlFile {
    param(
        [string]$HtmlPath,
        [bool]$Detailed,
        [string]$TempJson
    )

    $nodeArgs = @($Exporter, "export-html", "--file", $HtmlPath, "--state-dir", $DefaultStateDir, "--out-json", $TempJson)
    if ($Detailed) { $nodeArgs += "--detailed" }

    $result = Invoke-NodeJson -Arguments $nodeArgs
    if ($result.Code -ne 0) {
        $msg = if (-not [string]::IsNullOrWhiteSpace($result.Err)) { $result.Err.Trim() } else { $result.Out.Trim() }
        throw $msg
    }

    return [PSCustomObject]@{ Data = (Get-Content -LiteralPath $TempJson -Raw -Encoding UTF8 | ConvertFrom-Json); Source = "HTML导入"; Bot = $false }
}

function Export-ByUrl {
    param(
        [string]$Url,
        [int]$Port,
        [bool]$Detailed,
        [string]$TempJson,
        [string]$SourceLabel = "Gemini会话URL（后台临时窗口）",
        [switch]$NoFavorite
    )

    $nodeArgs = @($Exporter, "export-url", "--url", $Url, "--state-dir", $DefaultStateDir, "--out-json", $TempJson)
    if ($Port -gt 0) { $nodeArgs += @("--port", [string]$Port) }
    if ($Detailed) { $nodeArgs += "--detailed" }
    if ($NoFavorite) { $nodeArgs += "--no-favorite" }

    $result = Invoke-NodeJson -Arguments $nodeArgs
    if ($result.Code -ne 0) {
        $msg = if (-not [string]::IsNullOrWhiteSpace($result.Err)) { $result.Err.Trim() } else { $result.Out.Trim() }
        throw $msg
    }

    return [PSCustomObject]@{ Data = (Get-Content -LiteralPath $TempJson -Raw -Encoding UTF8 | ConvertFrom-Json); Source = $SourceLabel; Bot = $false }
}

function Build-Markdown {
    param(
        [object]$Data,
        [string]$SourceLabel,
        [bool]$Detailed,
        [bool]$BotClean
    )

    $builder = New-Object System.Text.StringBuilder

    $title = $Data.title
    if ([string]::IsNullOrWhiteSpace($title)) { $title = "Gemini 对话" }

    [void]$builder.AppendLine("# $title")
    [void]$builder.AppendLine()

    $modeText = if ($Detailed) { "详尽模式" } else { "简洁模式" }
    [void]$builder.AppendLine("> 导出模式：$modeText")
    [void]$builder.AppendLine("> 来源：$SourceLabel")
    [void]$builder.AppendLine("> 导出时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")

    $turnCount = @($Data.turns).Count
    [void]$builder.AppendLine("> 轮次：$turnCount 轮")
    [void]$builder.AppendLine()

    $turnNumber = 0
    foreach ($turn in @($Data.turns)) {
        $turnNumber++

        [void]$builder.AppendLine("## 第 $turnNumber 轮对话")
        [void]$builder.AppendLine()

        [void]$builder.AppendLine("### 用户")
        [void]$builder.AppendLine()

        $userText = if ($Detailed) { [string]$turn.user } else { [string]$turn.user_clean }
        [void]$builder.AppendLine((Wrap-InCodeBlock -Text $userText))
        [void]$builder.AppendLine()

        $thoughts = @($turn.thoughts | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($Detailed -and $thoughts.Count -gt 0) {
            $partNumber = 0
            foreach ($thought in $thoughts) {
                $partNumber++
                if ($thoughts.Count -gt 1) {
                    [void]$builder.AppendLine("### 模型详细过程 $partNumber")
                }
                else {
                    [void]$builder.AppendLine("### 模型详细过程")
                }
                [void]$builder.AppendLine()
                [void]$builder.AppendLine((Wrap-InCodeBlock -Text ([string]$thought)))
                [void]$builder.AppendLine()
            }
        }

        $modelText = if ($Detailed) { [string]$turn.model } else { [string]$turn.model_clean }
        if ([string]::IsNullOrWhiteSpace($modelText) -and -not [string]::IsNullOrWhiteSpace([string]$turn.model)) {
            # 简洁模式把 [PASS] 这类纯控制标签剥掉了：不要静默丢轮次，标一句说明
            $rawNote = (([string]$turn.model) -replace "\s+", " ").Trim()
            $modelText = "（本轮没有正文回复，原文为：" + $rawNote + "）"
        }
        if (-not [string]::IsNullOrWhiteSpace($modelText)) {
            $hasEnvelope = [string]$turn.model -match '【正文开始】|\[正文开始\]'
            if ((-not $Detailed) -and $hasEnvelope) {
                # 只有机器信封格式的回复才把 || 当气泡分隔符；普通对话原样保留
                $modelText = $modelText -replace '\|\|', "`n"
            }
            [void]$builder.AppendLine("### Gemini")
            [void]$builder.AppendLine()
            [void]$builder.AppendLine((Wrap-InCodeBlock -Text $modelText))
            [void]$builder.AppendLine()
        }
    }

    $unpaired = @($Data.unpaired_model_outputs | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($unpaired.Count -gt 0) {
        [void]$builder.AppendLine("## 未配对模型内容")
        [void]$builder.AppendLine()

        $piece = 0
        foreach ($item in $unpaired) {
            $piece++
            [void]$builder.AppendLine("### 片段 $piece")
            [void]$builder.AppendLine()
            [void]$builder.AppendLine((Wrap-InCodeBlock -Text ([string]$item)))
            [void]$builder.AppendLine()
        }
    }

    return $builder.ToString().TrimEnd()
}

function Set-ClipboardSafe {
    param(
        [string]$Text
    )

    # 剪贴板可能被其它程序短暂占用：重试几次，失败也不影响已写好的文件
    for ($i = 0; $i -lt 4; $i++) {
        try {
            Set-Clipboard -Value $Text
            return $true
        }
        catch {
            Start-Sleep -Milliseconds 150
        }
    }

    return $false
}

function Save-Export {
    param(
        [string]$Markdown
    )

    if ([string]::IsNullOrWhiteSpace($Markdown)) {
        throw "导出结果为空，已停止写入文件。"
    }

    Set-Content -LiteralPath $OutputFile -Value $Markdown -Encoding UTF8
    return (Set-ClipboardSafe -Text $Markdown)
}

# ---------------------------------------------------------------- 主流程
try {
    Write-Head

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "没找到 node 命令。请先确认 Node.js 已装好并加入 PATH。"
    }
    if (-not (Test-Path -LiteralPath $Exporter)) {
        throw ("导出内核缺失：" + $Exporter)
    }

    Write-Host "是否包含详尽内容？" -ForegroundColor White
    Write-Host " y = 导出模型思考过程、完整系统提示词与原始信封标签（详尽模式）"
    Write-Host " n = 只导出对话正文（简洁模式）"
    Write-Host ""

    $detailedChoice = Read-Host "包含详尽内容请输入 y，简洁导出请输入 n"
    $IncludeDetailedProcess = $detailedChoice -match "^(y|yes|是|详细|详尽)$"

    if ($IncludeDetailedProcess) {
        $OutputFileName = "Gemini_Chat_Export_Detailed.md"
    }
    else {
        $OutputFileName = "Gemini_Chat_Export.md"
    }

    $OutputFile = Join-Path ([Environment]::GetFolderPath("Desktop")) $OutputFileName

    Write-Host ""
    Write-Host "正在扫描受控 Chrome（侧边栏首次扫描会开一个屏外临时窗口，约 20~40 秒；5 分钟内复用缓存）..." -ForegroundColor DarkGray
    $report = Read-TargetsReport
    $entries = Build-MenuEntries -Report $report
    $clipUrl = Get-ClipboardGeminiUrl
    Write-Host ""
    Show-Menu -Report $report -Entries $entries -ClipUrl $clipUrl

    $choice = ""
    while ($true) {
        $choice = ([string](Read-Host "请选择要导出的会话编号，或输入 B / C / H / U / Q")).Trim()
        if ($choice -match "^[bB]$") {
            Start-DebugChrome
            Write-Host ""
            Write-Host "正在重新扫描浏览器..." -ForegroundColor DarkGray
            $report = Read-TargetsReport
            $entries = Build-MenuEntries -Report $report
            $clipUrl = Get-ClipboardGeminiUrl
            Write-Host ""
            Show-Menu -Report $report -Entries $entries -ClipUrl $clipUrl
            continue
        }
        break
    }

    if ($choice -match "^(q|quit|退出|取消)$" -or [string]::IsNullOrWhiteSpace($choice)) {
        Write-Host ""
        Write-Host "已取消。" -ForegroundColor Yellow
        Write-Host ""
        Read-Host "按 Enter 键关闭窗口"
        exit 0
    }

    $tempJson = Join-Path $env:TEMP ("gemini_export_" + [guid]::NewGuid().ToString("N") + ".json")
    $tempHtml = Join-Path $env:TEMP ("gemini_clip_" + [guid]::NewGuid().ToString("N") + ".html")
    $payload = $null
    $plainFallback = $null

    try {
        if ($choice -match "^[hH]$") {
            Write-Host ""
            Write-Host "把保存好的网页 .html 文件拖到本窗口后回车；直接回车则读取系统剪贴板。" -ForegroundColor White
            $pathInput = Read-Host "文件路径"
            $pathInput = ([string]$pathInput).Trim().Trim('"')

            if (-not [string]::IsNullOrWhiteSpace($pathInput)) {
                $resolved = $pathInput
                if (-not (Test-Path -LiteralPath $resolved)) {
                    throw ("文件不存在：" + $resolved)
                }
                Write-Host "正在解析本地 HTML..." -ForegroundColor DarkGray
                $payload = Export-ByHtmlFile -HtmlPath $resolved -Detailed $IncludeDetailedProcess -TempJson $tempJson
            }
            else {
                Write-Host "正在读取剪贴板..." -ForegroundColor DarkGray
                $clipHtml = $null
                try { $clipHtml = Get-Clipboard -TextFormatType Html -ErrorAction Stop } catch { $clipHtml = $null }

                $fragment = $null
                if (-not [string]::IsNullOrWhiteSpace($clipHtml)) {
                    $startTag = "<!--StartFragment-->"
                    $endTag = "<!--EndFragment-->"
                    $startIdx = $clipHtml.IndexOf($startTag)
                    $endIdx = $clipHtml.IndexOf($endTag)
                    if ($startIdx -ge 0 -and $endIdx -gt $startIdx) {
                        $fragment = $clipHtml.Substring($startIdx + $startTag.Length, $endIdx - $startIdx - $startTag.Length)
                    }
                    elseif ($clipHtml.IndexOf("<html") -ge 0) {
                        $fragment = $clipHtml.Substring($clipHtml.IndexOf("<html"))
                    }
                    else {
                        $fragment = $clipHtml
                    }
                }

                if ([string]::IsNullOrWhiteSpace($fragment)) {
                    $rawClip = ""
                    try { $rawClip = Get-Clipboard -Raw -ErrorAction Stop } catch { $rawClip = "" }
                    if ([string]::IsNullOrWhiteSpace($rawClip)) {
                        throw "剪贴板是空的，既没有 HTML 也没有文本。"
                    }
                    Write-Host "剪贴板里只有纯文本，将按原文导出。" -ForegroundColor Yellow
                    $plainFallback = $rawClip
                }
                else {
                    [System.IO.File]::WriteAllText($tempHtml, $fragment, (New-Object System.Text.UTF8Encoding($false)))
                    try {
                        Write-Host "正在解析剪贴板 HTML..." -ForegroundColor DarkGray
                        $payload = Export-ByHtmlFile -HtmlPath $tempHtml -Detailed $IncludeDetailedProcess -TempJson $tempJson
                    }
                    catch {
                        if ($_.Exception.Message -match "user-query|model-response|节点") {
                            Write-Host "剪贴板 HTML 里没有对话节点结构，改按原文导出。" -ForegroundColor Yellow
                            $rawClip = ""
                            try { $rawClip = Get-Clipboard -Raw -ErrorAction Stop } catch { $rawClip = "" }
                            if ([string]::IsNullOrWhiteSpace($rawClip)) { throw }
                            $plainFallback = $rawClip
                        }
                        else {
                            throw
                        }
                    }
                }
            }
        }
        elseif ($choice -match "^[cC]$") {
            if ([string]::IsNullOrWhiteSpace($clipUrl)) {
                throw "剪贴板里没有 Gemini 会话链接。"
            }
            $portGuess = 0
            if (@($report.ports).Count -gt 0) { $portGuess = [int](@($report.ports)[0]) }
            Write-Host ""
            Write-Host ("正在后台临时窗口里提取剪贴板链接：" + $clipUrl) -ForegroundColor DarkGray
            $payload = Export-ByUrl -Url $clipUrl -Port $portGuess -Detailed $IncludeDetailedProcess -TempJson $tempJson -SourceLabel "剪贴板链接（后台临时窗口）"
        }
        elseif ($choice -match "^[uU]$") {
            Write-Host ""
            Write-Host "仅限与受控座舱相同登录状态的 Gemini 会话/笔记本；工具会在后台开一个屏外临时窗口，读完立刻关掉。" -ForegroundColor DarkGray
            Write-Host "长对话渲染较慢，最多要等 60 秒左右。" -ForegroundColor DarkGray
            $urlInput = Read-Host "会话 URL"
            $urlInput = ([string]$urlInput).Trim().Trim('"')
            if ([string]::IsNullOrWhiteSpace($urlInput)) {
                throw "URL 为空。"
            }
            $portGuess = 0
            if (@($report.ports).Count -gt 0) { $portGuess = [int](@($report.ports)[0]) }
            Write-Host "正在后台临时窗口里提取..." -ForegroundColor DarkGray
            $payload = Export-ByUrl -Url $urlInput -Port $portGuess -Detailed $IncludeDetailedProcess -TempJson $tempJson
        }
        else {
            $index = -1
            if (-not [int]::TryParse($choice, [ref]$index)) {
                throw ("看不懂的选项：" + $choice)
            }
            $all = @($entries)
            if ($index -lt 1 -or $index -gt $all.Count) {
                throw ("编号超出范围：1 - " + $all.Count)
            }
            $entry = $all[$index - 1]

            if ($entry.Kind -eq "tab") {
                $target = $entry.Target
                if (-not $target.readable) {
                    throw ("这个标签页读不出内容：" + $target.error)
                }
                Write-Host ""
                Write-Host ("正在从「" + $target.title + "」只读提取（三拍稳定采样）...") -ForegroundColor DarkGray
                $payload = Export-ByTarget -Target $target -Detailed $IncludeDetailedProcess -TempJson $tempJson
            }
            else {
                $portGuess = 0
                if (@($report.ports).Count -gt 0) { $portGuess = [int](@($report.ports)[0]) }
                if ([string]::IsNullOrWhiteSpace($entry.Url)) {
                    throw ("这条会话没有可用的地址（" + $entry.Title + "），无法后台打开。")
                }
                Write-Host ""
                Write-Host ("正在后台临时窗口里打开「" + (Get-ShortText -Text $entry.Title -MaxLength 30) + "」，长对话可能要等 60 秒...") -ForegroundColor DarkGray
                if ($entry.Kind -eq "notebook") {
                    $payload = Export-ByUrl -Url $entry.Url -Port $portGuess -Detailed $IncludeDetailedProcess -TempJson $tempJson -SourceLabel "笔记本/收藏对话（后台临时窗口）"
                }
                else {
                    # 侧边栏里的临时会话不写入收藏，避免收藏夹被日常对话塞满
                    $payload = Export-ByUrl -Url $entry.Url -Port $portGuess -Detailed $IncludeDetailedProcess -TempJson $tempJson -SourceLabel "侧边栏历史会话（后台临时窗口）" -NoFavorite
                }
            }
        }

        if ($null -eq $payload) {
            if ([string]::IsNullOrWhiteSpace($plainFallback)) {
                throw "没有拿到可导出的内容。"
            }
            $modeText = if ($IncludeDetailedProcess) { "详尽模式" } else { "简洁模式" }
            $markdown = @(
                "# Gemini 对话（剪贴板纯文本）",
                "",
                "> 导出模式：$modeText",
                "> 来源：剪贴板纯文本（没有网页 DOM 结构，按原文保留）",
                "> 导出时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
                "",
                "## 原文",
                "",
                (Wrap-InCodeBlock -Text $plainFallback)
            ) -join "`n"
            $clipOk = Save-Export -Markdown $markdown
            Write-Host ""
            Write-Host "导出完成：剪贴板纯文本已按原文保存。" -ForegroundColor Green
            Write-Host ("文件位置：{0}" -f $OutputFile) -ForegroundColor Green
            if ($clipOk) {
                Write-Host "内容已复制到剪贴板。" -ForegroundColor Green
            }
            else {
                Write-Host "剪贴板被其它程序占用，未能自动复制（文件已保存）。" -ForegroundColor Yellow
            }
            Write-Host ""
            Read-Host "按 Enter 键关闭窗口"
            exit 0
        }

        $markdown = Build-Markdown -Data $payload.Data -SourceLabel $payload.Source -Detailed $IncludeDetailedProcess -BotClean ([bool]$payload.Bot)

        if ([string]::IsNullOrWhiteSpace($markdown) -or @($payload.Data.turns).Count -eq 0) {
            throw "这份会话里没有识别到任何一轮对话，已停止写入文件。"
        }

        $clipOk = Save-Export -Markdown $markdown

        Write-Host ""
        Write-Host ("导出完成：共 {0} 轮对话。" -f @($payload.Data.turns).Count) -ForegroundColor Green
        if ($IncludeDetailedProcess) {
            Write-Host "已包含模型思考过程、完整提示词与原始信封标签。" -ForegroundColor Green
        }
        else {
            Write-Host "已使用简洁模式（剥离信封标签）。" -ForegroundColor Green
        }
        $unpairedCount = @($payload.Data.unpaired_model_outputs | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
        if ($unpairedCount -gt 0) {
            Write-Host ("另外归档了 {0} 段未配对模型内容。" -f $unpairedCount) -ForegroundColor Yellow
        }
        Write-Host ("文件位置：{0}" -f $OutputFile) -ForegroundColor Green
        if ($clipOk) {
            Write-Host "内容已复制到剪贴板。" -ForegroundColor Green
        }
        else {
            Write-Host "剪贴板被其它程序占用，未能自动复制（文件已保存）。" -ForegroundColor Yellow
        }
    }
    finally {
        Remove-Item -LiteralPath $tempJson -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tempHtml -Force -ErrorAction SilentlyContinue
    }
}
catch {
    Write-Host ""
    Write-Host ("导出失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
}

Write-Host ""
Read-Host "按 Enter 键关闭窗口"
