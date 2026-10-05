# Build script for native helpers
#
# MSVC is the toolchain the shipped Windows helpers are built with. The MinGW
# and clang fallbacks exist only so contributors without Visual Studio can get
# a working local build.
#
# Pass -Strict (CI does) to require MSVC and refuse every fallback. Without it,
# an MSVC compile error is silently papered over by whichever other compiler
# happens to accept the file, which is how a helper that no compiler could
# build reached master and stalled the publish for a month.

[CmdletBinding()]
param(
    [switch]$Strict
)

if (-not $Strict -and $env:STELLA_NATIVE_STRICT) { $Strict = $true }

$outputDir = Join-Path $PSScriptRoot "out\win32"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$defaultLibs = @("user32.lib", "gdi32.lib", "gdiplus.lib", "ole32.lib", "oleaut32.lib", "uuid.lib")
$defaultGccLibs = @("-luser32", "-lgdi32", "-lgdiplus", "-lole32", "-loleaut32", "-luuid")
$windowInfoLibs = $defaultLibs + @("dwmapi.lib")
$windowInfoGccLibs = $defaultGccLibs + @("-ldwmapi")

$targets = @(
    @{ kind = "cpp"; src = "src\window_info.cpp"; out = (Join-Path $outputDir "window_info.exe"); libs = $windowInfoLibs; gccLibs = $windowInfoGccLibs },
    @{ kind = "cpp"; src = "src\recent_apps.cpp"; out = (Join-Path $outputDir "recent_apps.exe"); libs = @("user32.lib", "dwmapi.lib"); gccLibs = @("-luser32", "-ldwmapi") },
    @{ kind = "cpp"; src = "src\window_text.cpp"; out = (Join-Path $outputDir "window_text.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\selected_text.cpp"; out = (Join-Path $outputDir "selected_text.exe"); libs = $defaultLibs; gccLibs = $defaultGccLibs },
    @{ kind = "cpp"; src = "src\dictation_bridge.cpp"; out = (Join-Path $outputDir "dictation_bridge.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "user32.lib", "shell32.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-luser32", "-lshell32") },
    @{ kind = "cpp"; src = "src\stella_computer_helper.cpp"; out = (Join-Path $outputDir "stella-computer-helper.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "user32.lib", "gdi32.lib", "gdiplus.lib", "shell32.lib", "advapi32.lib", "dwmapi.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-luser32", "-lgdi32", "-lgdiplus", "-lshell32", "-ladvapi32", "-ldwmapi") },
    @{ kind = "cpp"; src = "src\meeting_capture.cpp"; out = (Join-Path $outputDir "meeting_capture.exe"); libs = @("ole32.lib", "oleaut32.lib", "uuid.lib", "shell32.lib"); gccLibs = @("-lole32", "-loleaut32", "-luuid", "-lshell32") }
)

function Build-WithMSVC($vcvars, $srcFile, $outFile, $libs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    $cwd = (Get-Location).Path
    $libArgs = ($libs -join " ")
    $cmd = "call `"$vcvars`" && cd /d `"$cwd`" && cl /O2 /EHsc /nologo `"$srcFile`" /link $libArgs /OUT:`"$outFile`""
    # Stream cmd's stdout/stderr to the host so they don't bleed into the
    # function's pipeline output (which would make the returned boolean
    # array-truthy regardless of actual success).
    cmd /c $cmd 2>&1 | ForEach-Object { Write-Host $_ }
    $exit = $LASTEXITCODE
    $exists = Test-Path $outFile
    Write-Host "    cl exit=$exit, output exists=$exists, target=$outFile"
    return ($exit -eq 0 -and $exists)
}

function Build-WithGpp($srcFile, $outFile, $gccLibs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & g++ -O2 -static $srcFile -o $outFile @gccLibs 2>&1 | ForEach-Object { Write-Host $_ }
    $exit = $LASTEXITCODE
    $exists = Test-Path $outFile
    Write-Host "    g++ exit=$exit, output exists=$exists, target=$outFile"
    return ($exit -eq 0 -and $exists)
}

function Build-WithClang($srcFile, $outFile, $gccLibs) {
    if (Test-Path $outFile) {
        Remove-Item $outFile -Force
    }
    & clang++ -O2 $srcFile -o $outFile @gccLibs 2>&1 | ForEach-Object { Write-Host $_ }
    $exit = $LASTEXITCODE
    $exists = Test-Path $outFile
    Write-Host "    clang++ exit=$exit, output exists=$exists, target=$outFile"
    return ($exit -eq 0 -and $exists)
}

# Detect compiler
$vcvars = $null
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
    $vsPath = & $vsWhere -latest -property installationPath
    $candidate = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path $candidate) { $vcvars = $candidate }
}
$hasGpp = [bool](Get-Command g++ -ErrorAction SilentlyContinue)
$hasClang = [bool](Get-Command clang++ -ErrorAction SilentlyContinue)

if ($Strict) {
    Write-Host "Strict mode: MSVC is required and fallback compilers are disabled."
    if (-not $vcvars) {
        Write-Host "ERROR: -Strict requires Visual Studio with the C++ workload, but vcvars64.bat was not found."
        exit 1
    }
} elseif (-not $vcvars -and -not $hasGpp -and -not $hasClang) {
    Write-Host "ERROR: No C++ compiler found. Install one of:"
    Write-Host "  - Visual Studio with C++ workload"
    Write-Host "  - MinGW-w64 (g++)"
    Write-Host "  - LLVM/Clang"
    exit 1
}

$allOk = $true
$compilerUsed = [ordered]@{}

foreach ($t in $targets) {
    $leaf = Split-Path $t.out -Leaf
    Write-Host "Building $leaf..."
    $built = $false
    $with = $null

    if ($vcvars) {
        Write-Host "  Using MSVC..."
        $built = Build-WithMSVC $vcvars $t.src $t.out $t.libs
        if ($built) { $with = "MSVC" }
    }

    if (-not $built -and $Strict) {
        Write-Host "::error::MSVC failed to build $leaf. Strict mode does not fall back to another compiler."
        $compilerUsed[$leaf] = "FAILED"
        $allOk = $false
        continue
    }

    if ($hasGpp -and -not $built) {
        Write-Host "  Using MinGW g++..."
        $built = Build-WithGpp $t.src $t.out $t.gccLibs
        if ($built) { $with = "MinGW g++" }
    }
    if ($hasClang -and -not $built) {
        Write-Host "  Using clang++..."
        $built = Build-WithClang $t.src $t.out $t.gccLibs
        if ($built) { $with = "clang++" }
    }

    if ($built) {
        Write-Host "  Build successful: $($t.out) [$with]"
        if ($with -ne "MSVC") {
            Write-Warning "$leaf was built with $with, not MSVC. Shipping builds use MSVC; re-run with -Strict to treat this as a failure."
        }
        $compilerUsed[$leaf] = $with
    } else {
        Write-Host "  ERROR: Failed to build $($t.out)"
        $compilerUsed[$leaf] = "FAILED"
        $allOk = $false
    }
}

Write-Host ""
Write-Host "Compiler summary:"
foreach ($name in $compilerUsed.Keys) {
    Write-Host ("  {0,-32} {1}" -f $name, $compilerUsed[$name])
}
Write-Host ""

if (-not $allOk) { exit 1 }

# wakeword_listener — Rust binary, x86_64 Windows via cargo. Skipped silently
# when cargo is unavailable so non-Rust contributors aren't blocked, but it
# ships in the helper set, so -Strict requires it.
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) {
    Write-Host "Building wakeword_listener.exe..."
    Push-Location (Join-Path $PSScriptRoot "wakeword")
    try {
        & cargo build --release --quiet --target x86_64-pc-windows-msvc
        if ($LASTEXITCODE -eq 0) {
            $src = Join-Path (Get-Location) "target\x86_64-pc-windows-msvc\release\wakeword_listener.exe"
            $dst = Join-Path $outputDir "wakeword_listener.exe"
            Copy-Item -Force $src $dst
            $modelsDir = Join-Path $outputDir "wakeword_models"
            New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
            Copy-Item -Force (Join-Path $PSScriptRoot "wakeword\models\hey_stella.onnx") (Join-Path $modelsDir "hey_stella.onnx")
            Write-Host "  Build successful: $dst"
        } else {
            Write-Host "  ERROR: cargo build failed"
            exit 1
        }
    } finally {
        Pop-Location
    }
} elseif ($Strict) {
    Write-Host "ERROR: cargo is required with -Strict; wakeword_listener.exe ships in the helper set."
    exit 1
} else {
    Write-Host "Skipping wakeword_listener: cargo not on PATH (install rustup to enable)."
}

exit 0
