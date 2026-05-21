$ErrorActionPreference = 'Stop'

$Manifest    = Get-Content -Raw plugin.json | ConvertFrom-Json
$PluginId    = $Manifest.id
$Version     = $Manifest.version
$BundleName  = "$PluginId-$Version"
$Root        = $PSScriptRoot

Write-Host "Building $BundleName" -ForegroundColor Cyan

# --- Ensure `go` is on PATH (fall back to common install locations) ---
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    $candidates = @(
        "$env:ProgramFiles\Go\bin",
        "${env:ProgramFiles(x86)}\Go\bin",
        "$env:LOCALAPPDATA\Programs\Go\bin",
        "$env:USERPROFILE\go\bin",
        'C:\Go\bin'
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c 'go.exe'))) {
            $env:PATH = "$c;$env:PATH"
            Write-Host "Using go from: $c" -ForegroundColor DarkGray
            break
        }
    }
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        throw "go executable not found"
    }
}

# --- Clean ---
$DistRoot   = Join-Path $Root 'dist'
$ServerDist = Join-Path $Root 'server\dist'
$WebDist    = Join-Path $Root 'webapp\dist'
foreach ($d in @($DistRoot, $ServerDist, $WebDist)) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    New-Item -ItemType Directory -Path $d | Out-Null
}

# --- Resolve Go dependencies ---
Write-Host "go mod tidy" -ForegroundColor Yellow
Push-Location $Root
try {
    # Pipe between proxies = fall through on any error (including 403).
    # Try goproxy.cn first since it caches Mattermost's transitive deps that
    # proxy.golang.org sometimes rejects with 403.
    $env:GOPROXY = 'https://goproxy.cn|https://proxy.golang.org|direct'
    $env:GOSUMDB = 'off'
    go mod tidy
    if ($LASTEXITCODE -ne 0) { throw "go mod tidy failed" }
} finally {
    Remove-Item Env:GOPROXY -ErrorAction SilentlyContinue
    Remove-Item Env:GOSUMDB -ErrorAction SilentlyContinue
    Pop-Location
}

# --- Build Go binaries ---
$targets = @(
    @{GOOS = 'linux';   GOARCH = 'amd64'; Out = 'plugin-linux-amd64'},
    @{GOOS = 'linux';   GOARCH = 'arm64'; Out = 'plugin-linux-arm64'},
    @{GOOS = 'darwin';  GOARCH = 'amd64'; Out = 'plugin-darwin-amd64'},
    @{GOOS = 'darwin';  GOARCH = 'arm64'; Out = 'plugin-darwin-arm64'},
    @{GOOS = 'windows'; GOARCH = 'amd64'; Out = 'plugin-windows-amd64.exe'}
)

Push-Location $Root
try {
    foreach ($t in $targets) {
        Write-Host ("go build {0}/{1}" -f $t.GOOS, $t.GOARCH) -ForegroundColor Yellow
        $env:GOOS        = $t.GOOS
        $env:GOARCH      = $t.GOARCH
        $env:CGO_ENABLED = '0'
        $outPath = Join-Path $ServerDist $t.Out
        go build -trimpath -ldflags '-s -w' -o $outPath ./server
        if ($LASTEXITCODE -ne 0) { throw ("go build failed for {0}/{1}" -f $t.GOOS, $t.GOARCH) }
    }
} finally {
    Remove-Item Env:GOOS        -ErrorAction SilentlyContinue
    Remove-Item Env:GOARCH      -ErrorAction SilentlyContinue
    Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}

# --- Build webapp ---
Push-Location (Join-Path $Root 'webapp')
try {
    Write-Host "npm install" -ForegroundColor Yellow
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Host "npm run build" -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
    Pop-Location
}

# --- Verify build outputs before staging ---
$WebBundle = Join-Path $WebDist 'main.js'
if (-not (Test-Path $WebBundle)) {
    throw "webapp build produced no main.js at $WebBundle"
}
$WebBundleSize = (Get-Item $WebBundle).Length
if ($WebBundleSize -lt 200) {
    throw "webapp main.js is suspiciously small ($WebBundleSize bytes)"
}
foreach ($t in $targets) {
    $bin = Join-Path $ServerDist $t.Out
    if (-not (Test-Path $bin)) {
        throw ("missing server binary {0}" -f $bin)
    }
}

# --- Stage bundle ---
$Stage = Join-Path $DistRoot $BundleName
New-Item -ItemType Directory -Path $Stage | Out-Null
Copy-Item (Join-Path $Root 'plugin.json') $Stage

$StageServer = Join-Path $Stage 'server\dist'
New-Item -ItemType Directory -Path $StageServer -Force | Out-Null
Copy-Item (Join-Path $ServerDist '*') $StageServer -Recurse

$StageWeb = Join-Path $Stage 'webapp\dist'
New-Item -ItemType Directory -Path $StageWeb -Force | Out-Null
Copy-Item (Join-Path $WebDist '*') $StageWeb -Recurse

if (-not (Test-Path (Join-Path $StageWeb 'main.js'))) {
    throw "staged webapp/dist/main.js missing after copy"
}

# --- Pack via Go packer (sets +x on server binaries; Windows bsdtar can't do that) ---
$OutTar = Join-Path $DistRoot ("$BundleName.tar.gz")
if (Test-Path $OutTar) { Remove-Item -Force $OutTar }
Write-Host "go run ./tools/pack $Stage $OutTar" -ForegroundColor Yellow
Push-Location $Root
try {
    $env:CGO_ENABLED = '0'
    go run ./tools/pack $Stage $OutTar
    if ($LASTEXITCODE -ne 0) { throw "go run pack failed" }
} finally {
    Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}

$Out = Join-Path $DistRoot ("$BundleName.tar.gz")

# --- Verify final tarball contents ---
$expected = @(
    "$BundleName/plugin.json",
    "$BundleName/webapp/dist/main.js",
    "$BundleName/server/dist/plugin-linux-amd64"
)
$listing = & tar -tzf $Out 2>$null
foreach ($e in $expected) {
    if (-not ($listing -contains $e)) {
        throw "verification failed: $e missing from $Out"
    }
}

Write-Host ""
Write-Host "Built: $Out" -ForegroundColor Green
Write-Host "Verified: plugin.json + webapp/dist/main.js + server binaries present" -ForegroundColor Green
Write-Host "Upload via: System Console > Plugin Management > Choose File" -ForegroundColor Green
