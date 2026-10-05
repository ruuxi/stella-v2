// Stella's Windows launcher: installs Stella's runtimes and source, verifies
// the signed tree, supervises Electron and rolls back to the last working
// version. A port of launcher/macos (same contract, same install layout, same
// health rules); see packages/desktop/electron/launcher-client.ts for
// Electron's side of the channel, which on Windows is the named pipe whose
// name is passed in STELLA_LAUNCHER_PIPE.
//
// Install root: %STELLA_LAUNCHER_ROOT%, else %LOCALAPPDATA%\Stella:
//   app\                      the checkout
//   runtimes\bun-<v>\bun.exe  pinned Bun
//   runtimes\git-<v>\         PortableGit
//   signing.key               the DPAPI-protected signing key
//   signing.pub, launcher-state.json, logs\{launcher,electron,install}.log
// On first run the launcher copies itself to %LOCALAPPDATA%\Programs\Stella
// and adds a Start Menu shortcut carrying Stella's AppUserModelID, which is
// how Windows gives Electron's windows the Stella name and icon.
//
// The launcher updates itself from launcher/stable/ on R2 (see "update"):
// a newer Stella.exe is verified and renamed over the installed copy, and
// takes over at the next start or the next app update.
//
// WinHTTP downloads, BCrypt SHA-256 and ECDSA P-256, DPAPI for the key,
// WinVerifyTrust for the launcher's own updates, tar.exe for zips. The
// window is launcher/common/launcher.html in WebView2 (found without
// WebView2Loader.dll); without a WebView2 runtime, TaskDialogs show progress
// and recovery instead.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <objbase.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <propkey.h>
#include <propsys.h>
#include <wincrypt.h>
#include <winhttp.h>
#include <wintrust.h>
#include <softpub.h>

#include "WebView2.h"  // fetched by build.sh

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cwctype>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../common/mini_json.h"

// The build number (CI's run number, from build.sh); 0 for a local build,
// which never updates itself.
#ifndef STELLA_LAUNCHER_VERSION
#define STELLA_LAUNCHER_VERSION 0
#endif

#ifndef PF_AVX2_INSTRUCTIONS_AVAILABLE
#define PF_AVX2_INSTRUCTIONS_AVAILABLE 40
#endif

using std::string;
using std::vector;
using std::wstring;

// ------------------------------------------------------------------ pins

static const char *kBunVersion = "1.4.0";
static const wchar_t *kDefaultBackendURL = L"https://stella-v2-cloud-builder-prod.lolruuxi.workers.dev";
static const char *kUpstreamBranch = "main";
static const char *kUpstreamRemoteName = "stella-upstream";
static const char *kKnownGoodRef = "refs/stella/known-good";
static const char *kNotesRef = "stella-signed";
static const DWORD kRelaunchExitCode = 75;
static const size_t kOutputLines = 40;
static const wchar_t *kAppUserModelID = L"com.stella.app";  // STELLA_WINDOWS_APP_USER_MODEL_ID
static const unsigned long long kLauncherVersion = STELLA_LAUNCHER_VERSION;
static const wchar_t *kDefaultUpdateURL = L"https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/launcher/stable";
static const wchar_t *kUpdateSigner = L"FromYou, LLC";
static const DWORD kUpdateIntervalMs = 6 * 60 * 60 * 1000;

struct Asset {
    const char *key;
    const char *url;
    const char *sha256;
    const char *member;
};

static const Asset kBunAssets[] = {
    {"win-x64", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip",
     "e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901", "bun-windows-x64/bun.exe"},
    {"win-x64-baseline", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64-baseline.zip",
     "b929c54a9badb104a16dedd23aab6152c86793ae653d4e6b13983ffd0c882a66", "bun-windows-x64-baseline/bun.exe"},
    {"win-arm64", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-aarch64.zip",
     "f473bfe2df73ee770548c93dd5d380aea7120c218ec2aa1afdd0bbba7bf18c47", "bun-windows-aarch64/bun.exe"},
};

// PortableGit from the managed git-runtime manifest on R2
// (git-runtime/versions/2.53.0/manifest.json, windowsDistribution), pinned so
// a tampered manifest can't swap the binary.
static const char *kGitVersion = "2.53.0";
static const Asset kGitAssets[] = {
    {"x64", "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.3/PortableGit-2.53.0.3-64-bit.7z.exe",
     "b365da794b1d2225eb24d5f5e09ef7792cfd5fa26c3a3586210280c80dff3a2a", nullptr},
    {"arm64", "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.3/PortableGit-2.53.0.3-arm64.7z.exe",
     "0db54010054c01f35501cf69e1e32d3710138ecb934d188bd77093afed24300e", nullptr},
};

static bool nativeArm64() {
    USHORT process = 0, native = 0;
    typedef BOOL(WINAPI * IsWow64Process2Fn)(HANDLE, USHORT *, USHORT *);
    auto fn = (IsWow64Process2Fn)(void *)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2");
    if (fn && fn(GetCurrentProcess(), &process, &native)) return native == IMAGE_FILE_MACHINE_ARM64;
    return false;
}

static string bunPlatformKey() {
    if (nativeArm64()) return "win-arm64";
    // Bun's default x64 build needs AVX2.
    return IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE) ? "win-x64" : "win-x64-baseline";
}

// ------------------------------------------------------------- strings

static wstring wide(const string &s) {
    if (s.empty()) return wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    wstring out(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n);
    return out;
}

static string utf8(const wstring &s) {
    if (s.empty()) return string();
    int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    string out(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n, nullptr, nullptr);
    return out;
}

static string trim(const string &s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == string::npos) return string();
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

static string format(const char *fmt, ...) {
    va_list ap, copy;
    va_start(ap, fmt);
    va_copy(copy, ap);
    int n = vsnprintf(nullptr, 0, fmt, copy);
    va_end(copy);
    string out(n > 0 ? n : 0, 0);
    if (n > 0) vsnprintf(&out[0], n + 1, fmt, ap);
    va_end(ap);
    return out;
}

static vector<string> splitLines(const string &text) {
    vector<string> lines;
    size_t start = 0;
    while (start <= text.size()) {
        size_t nl = text.find('\n', start);
        string line = text.substr(start, nl == string::npos ? string::npos : nl - start);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
        if (nl == string::npos) break;
        start = nl + 1;
    }
    return lines;
}

static string lastLines(const string &text, size_t count) {
    vector<string> lines = splitLines(text);
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    size_t from = lines.size() > count ? lines.size() - count : 0;
    string out;
    for (size_t i = from; i < lines.size(); i++) {
        if (i > from) out += "\n";
        out += lines[i];
    }
    return out;
}

static string short12(const string &s) { return s.substr(0, 12); }

static string isoNow() {
    SYSTEMTIME t;
    GetSystemTime(&t);
    return format("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond,
                  t.wMilliseconds);
}

struct LauncherError {
    string message;
};
[[noreturn]] static void fail(const string &message) { throw LauncherError{message}; }

// ----------------------------------------------------------------- files

static bool exists(const wstring &path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

static bool isDir(const wstring &path) {
    DWORD a = GetFileAttributesW(path.c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static void mkdirs(const wstring &path) {
    if (path.empty() || isDir(path)) return;
    size_t slash = path.find_last_of(L"\\/");
    if (slash != wstring::npos && slash > 2) mkdirs(path.substr(0, slash));
    CreateDirectoryW(path.c_str(), nullptr);
}

static wstring parentDir(const wstring &path) {
    size_t slash = path.find_last_of(L"\\/");
    return slash == wstring::npos ? wstring() : path.substr(0, slash);
}

static bool readFile(const wstring &path, string &out) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                           OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    out.clear();
    char buf[65536];
    DWORD n = 0;
    while (ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
    CloseHandle(h);
    return true;
}

static bool writeFileAtomic(const wstring &path, const string &data) {
    wstring tmp = path + L".tmp";
    HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    bool ok = WriteFile(h, data.data(), (DWORD)data.size(), &written, nullptr) && written == data.size();
    CloseHandle(h);
    if (!ok || !MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    return true;
}

static void removeTree(const wstring &path) {
    if (!exists(path)) return;
    if (!isDir(path)) {
        SetFileAttributesW(path.c_str(), FILE_ATTRIBUTE_NORMAL);
        DeleteFileW(path.c_str());
        return;
    }
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW((path + L"\\*").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            wstring name = fd.cFileName;
            if (name == L"." || name == L"..") continue;
            wstring child = path + L"\\" + name;
            if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
                removeTree(child);
            else {
                SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
                if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryW(child.c_str());
                else DeleteFileW(child.c_str());
            }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    RemoveDirectoryW(path.c_str());
}

static wstring envVar(const wchar_t *name) {
    DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
    if (n == 0) return wstring();
    wstring out(n, 0);
    n = GetEnvironmentVariableW(name, &out[0], n);
    out.resize(n);
    return out;
}

static wstring knownFolder(REFKNOWNFOLDERID id) {
    PWSTR p = nullptr;
    wstring out;
    if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p))) out = p;
    CoTaskMemFree(p);
    return out;
}

static wstring modulePath() {
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetModuleFileNameW(nullptr, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
    return wstring(buf, n);
}

// ------------------------------------------------------------------- log

static std::mutex gLogLock;
static HANDLE gLogFile = INVALID_HANDLE_VALUE;
static HANDLE gConsole = nullptr;

static void logLine(const string &message) {
    string line = isoNow() + " " + message + "\r\n";
    std::lock_guard<std::mutex> lock(gLogLock);
    DWORD n;
    if (gLogFile != INVALID_HANDLE_VALUE) WriteFile(gLogFile, line.data(), (DWORD)line.size(), &n, nullptr);
    if (gConsole) WriteFile(gConsole, line.data(), (DWORD)line.size(), &n, nullptr);
}
#define LOG(...) logLine(format(__VA_ARGS__))

// ----------------------------------------------------------------- paths

struct Paths {
    wstring root;
    bool isolated = false;
    wstring app() const { return root + L"\\app"; }
    wstring runtimes() const { return root + L"\\runtimes"; }
    wstring logs() const { return root + L"\\logs"; }
    wstring launcherLog() const { return logs() + L"\\launcher.log"; }
    wstring electronLog() const { return logs() + L"\\electron.log"; }
    wstring installLog() const { return logs() + L"\\install.log"; }
    wstring signingPub() const { return root + L"\\signing.pub"; }
    wstring signingKey() const { return root + L"\\signing.key"; }
    wstring stateFile() const { return root + L"\\launcher-state.json"; }
    wstring lockFile() const { return root + L"\\launcher.lock"; }
    wstring isolatedUserData() const { return root + L"\\user-data"; }
    wstring isolatedHome() const { return root + L"\\stella-home"; }

    static Paths resolve() {
        Paths p;
        wstring raw = envVar(L"STELLA_LAUNCHER_ROOT");
        string t = trim(utf8(raw));
        if (!t.empty()) {
            wchar_t full[MAX_PATH * 4];
            DWORD n = GetFullPathNameW(wide(t).c_str(), (DWORD)(sizeof(full) / sizeof(full[0])), full, nullptr);
            p.root = n ? wstring(full, n) : wide(t);
            p.isolated = true;
        } else {
            p.root = knownFolder(FOLDERID_LocalAppData) + L"\\Stella";
        }
        while (p.root.size() > 3 && (p.root.back() == L'\\' || p.root.back() == L'/')) p.root.pop_back();
        return p;
    }
};

static Paths P;

// ----------------------------------------------------------------- state

struct State {
    string bunLockHash, preparedHead, installedAt;

    static State load() {
        State s;
        string data;
        if (!readFile(P.stateFile(), data)) return s;
        mj_value *json = mj_parse(data.data(), data.size());
        if (const char *v = mj_get_string(json, "bunLockHash")) s.bunLockHash = v;
        if (const char *v = mj_get_string(json, "preparedHead")) s.preparedHead = v;
        if (const char *v = mj_get_string(json, "installedAt")) s.installedAt = v;
        mj_free(json);
        return s;
    }

    void save() const {
        string out = "{";
        bool first = true;
        auto add = [&](const char *name, const string &value) {
            if (value.empty()) return;
            char *q = mj_quote(value.c_str());
            out += format("%s\n  \"%s\" : %s", first ? "" : ",", name, q);
            free(q);
            first = false;
        };
        add("bunLockHash", bunLockHash);
        add("installedAt", installedAt);
        add("preparedHead", preparedHead);
        out += "\n}\n";
        writeFileAtomic(P.stateFile(), out);
    }
};

static State S;

// --------------------------------------------------------------- options

enum class Choice { None, Return, Reinstall, Retry, Quit };

static const char *choiceName(Choice c) {
    switch (c) {
    case Choice::Return: return "return";
    case Choice::Reinstall: return "reinstall";
    case Choice::Retry: return "retry";
    case Choice::Quit: return "quit";
    default: return "none";
    }
}

static double envSeconds(const wchar_t *name, double fallback) {
    string raw = utf8(envVar(name));
    double v = raw.empty() ? 0 : atof(raw.c_str());
    return v > 0 ? v : fallback;
}

struct Options {
    bool selfTest = false;
    bool start = false;      // start right away, without waiting for Start
    DWORD after = 0;         // wait for this launcher (handing over) to exit first
    bool backendArg = false; // --backend was given (passed on at a handover)
    string source;      // a local path or git URL instead of the upstream bootstrap
    string sourceRef;
    wstring backend;
    wstring localBun;   // adopt this Bun instead of downloading
    double hold = 0;    // self-test: stay up this long after ready
    Choice recoveryChoice = Choice::None;
    wstring captureDir; // self-test: save PNGs of the launcher's window here
    double readyTimeout = envSeconds(L"STELLA_LAUNCHER_READY_TIMEOUT_SECONDS", 90);
    double stableSeconds = envSeconds(L"STELLA_LAUNCHER_STABLE_SECONDS", 60);
};

static Options O;

static const char *kUsage =
    "usage: Stella.exe [--self-test] [--source <path|git url>] [--source-ref <ref>]\n"
    "                  [--backend <url>] [--bun <path>] [--hold <seconds>]\n"
    "                  [--recovery-choice return|retry|quit] [--capture-dir <dir>]\n"
    "                  [--start] [--after <pid>]\n"
    "       Stella.exe --version\n"
    "\n"
    "Environment: STELLA_LAUNCHER_ROOT (install root, for testing),\n"
    "STELLA_LAUNCHER_KEY_FILE (PKCS#8 PEM instead of the DPAPI key),\n"
    "STELLA_LAUNCHER_BACKEND_URL, STELLA_LAUNCHER_STABLE_SECONDS,\n"
    "STELLA_LAUNCHER_READY_TIMEOUT_SECONDS, STELLA_LAUNCHER_PREPARE_TIMEOUT_SECONDS,\n"
    "STELLA_LAUNCHER_INSTALL_DIR (instead of %LOCALAPPDATA%\\Programs\\Stella),\n"
    "STELLA_LAUNCHER_UPDATE_URL, STELLA_LAUNCHER_UPDATE_DELAY_SECONDS and\n"
    "STELLA_LAUNCHER_UPDATE_SKIP_SIGNATURE=1 (with an update URL; for testing).\n";

static void parseOptions() {
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    wstring backend = envVar(L"STELLA_LAUNCHER_BACKEND_URL");
    O.backend = backend.empty() ? kDefaultBackendURL : backend;
    for (int i = 1; i < argc; i++) {
        wstring a = argv[i];
        auto value = [&]() -> wstring {
            if (i + 1 >= argc) {
                LOG("%s needs a value\n%s", utf8(a).c_str(), kUsage);
                ExitProcess(64);
            }
            return argv[++i];
        };
        if (a == L"--self-test") O.selfTest = true;
        else if (a == L"--source") O.source = utf8(value());
        else if (a == L"--source-ref") O.sourceRef = utf8(value());
        else if (a == L"--backend") { O.backend = value(); O.backendArg = true; }
        else if (a == L"--start") O.start = true;
        else if (a == L"--after") O.after = wcstoul(value().c_str(), nullptr, 10);
        else if (a == L"--bun") O.localBun = value();
        else if (a == L"--hold") O.hold = _wtof(value().c_str());
        else if (a == L"--capture-dir") O.captureDir = value();
        else if (a == L"--recovery-choice") {
            wstring v = value();
            if (v == L"return") O.recoveryChoice = Choice::Return;
            else if (v == L"retry") O.recoveryChoice = Choice::Retry;
            else if (v == L"quit") O.recoveryChoice = Choice::Quit;
            else { LOG("unknown recovery choice"); ExitProcess(64); }
        } else if (a == L"-h" || a == L"--help" || a == L"/?") {
            LOG("%s", kUsage);
            ExitProcess(0);
        } else {
            LOG("launcher: ignoring argument %s", utf8(a).c_str());
        }
    }
    LocalFree(argv);
}

// ----------------------------------------------------------- environment

struct CaseInsensitiveLess {
    bool operator()(const wstring &a, const wstring &b) const { return _wcsicmp(a.c_str(), b.c_str()) < 0; }
};
using Env = std::map<wstring, wstring, CaseInsensitiveLess>;

static Env currentEnvironment() {
    Env env;
    LPWCH block = GetEnvironmentStringsW();
    for (LPWCH p = block; *p; p += wcslen(p) + 1) {
        wstring entry = p;
        size_t eq = entry.find(L'=', 1);  // entries like "=C:=C:\" start with '='
        if (eq == wstring::npos || entry[0] == L'=') continue;
        env[entry.substr(0, eq)] = entry.substr(eq + 1);
    }
    FreeEnvironmentStringsW(block);
    return env;
}

static vector<wchar_t> environmentBlock(const Env &env) {
    vector<wchar_t> block;
    for (auto &kv : env) {  // std::map keeps it sorted, as CreateProcess wants
        wstring entry = kv.first + L"=" + kv.second;
        block.insert(block.end(), entry.begin(), entry.end());
        block.push_back(0);
    }
    block.push_back(0);
    if (block.size() == 1) block.push_back(0);
    return block;
}

// --------------------------------------------------------------- process

// Quote one argument by the rules CommandLineToArgvW and the MSVC runtime use.
static wstring quoteArg(const wstring &arg) {
    if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == wstring::npos) return arg;
    wstring out = L"\"";
    for (size_t i = 0;; i++) {
        size_t backslashes = 0;
        while (i < arg.size() && arg[i] == L'\\') { i++; backslashes++; }
        if (i == arg.size()) { out.append(backslashes * 2, L'\\'); break; }
        if (arg[i] == L'"') { out.append(backslashes * 2 + 1, L'\\'); out.push_back(L'"'); }
        else { out.append(backslashes, L'\\'); out.push_back(arg[i]); }
    }
    out.push_back(L'"');
    return out;
}

static wstring commandLine(const vector<wstring> &argv) {
    wstring out;
    for (size_t i = 0; i < argv.size(); i++) {
        if (i) out += L" ";
        out += quoteArg(argv[i]);
    }
    return out;
}

struct CmdResult {
    DWORD code = 0;
    string out;
    string err;  // with an output file: that file's tail
    bool timedOut = false;
};

static string fileTail(const wstring &path, size_t bytes) {
    string data;
    if (!readFile(path, data)) return string();
    return data.size() > bytes ? data.substr(data.size() - bytes) : data;
}

static void drainPipe(HANDLE h, string *into) {
    char buf[16384];
    DWORD n = 0;
    while (ReadFile(h, buf, sizeof(buf), &n, nullptr) && n > 0) into->append(buf, n);
}

// Creates a process with exactly the given handles inheritable.
static bool createProcess(const wstring &exe, wstring cmdline, const wstring &cwd, const Env &env, HANDLE in, HANDLE out,
                          HANDLE err, DWORD flags, PROCESS_INFORMATION *pi) {
    vector<HANDLE> handles;
    for (HANDLE h : {in, out, err})
        if (h && std::find(handles.begin(), handles.end(), h) == handles.end()) handles.push_back(h);
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    vector<char> attrBuf(size);
    auto attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)attrBuf.data();
    InitializeProcThreadAttributeList(attrs, 1, 0, &size);
    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.data(), handles.size() * sizeof(HANDLE),
                              nullptr, nullptr);
    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = in;
    si.StartupInfo.hStdOutput = out;
    si.StartupInfo.hStdError = err;
    si.lpAttributeList = attrs;
    vector<wchar_t> block = environmentBlock(env);
    BOOL ok = CreateProcessW(exe.c_str(), &cmdline[0], nullptr, nullptr, TRUE,
                             flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, block.data(),
                             cwd.empty() ? nullptr : cwd.c_str(), &si.StartupInfo, pi);
    DeleteProcThreadAttributeList(attrs);
    return ok != 0;
}

static HANDLE openNul() {
    SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
    return CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
}

// Run a console program without a window. With outputFile, stdout and stderr
// are appended there. The child runs in a job object, so a timeout kills its
// whole tree. A raw `cmdline` overrides the quoted argv (7-Zip SFX switches).
static CmdResult runCmd(const vector<wstring> &argv, const wstring &cwd, const Env &env, const wstring &outputFile = L"",
                        double timeoutSeconds = 0, const wstring &rawCmdline = L"") {
    CmdResult r;
    SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
    HANDLE nul = openNul();
    HANDLE outRead = nullptr, outWrite = nullptr, errRead = nullptr, errWrite = nullptr, logH = INVALID_HANDLE_VALUE;
    if (!outputFile.empty()) {
        logH = CreateFileW(outputFile.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
        string header = "\r\n$ " + utf8(rawCmdline.empty() ? commandLine(argv) : rawCmdline) + "\r\n";
        DWORD n;
        if (logH != INVALID_HANDLE_VALUE) WriteFile(logH, header.data(), (DWORD)header.size(), &n, nullptr);
        // An unopenable log must not put an invalid handle in the inherit list.
        outWrite = errWrite = logH != INVALID_HANDLE_VALUE ? logH : nul;
    } else {
        CreatePipe(&outRead, &outWrite, &sa, 0);
        CreatePipe(&errRead, &errWrite, &sa, 0);
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
    }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    wstring cmdline = rawCmdline.empty() ? commandLine(argv) : rawCmdline;
    bool started = createProcess(argv[0], cmdline, cwd, env, nul, outWrite, errWrite, CREATE_NO_WINDOW | CREATE_SUSPENDED, &pi);
    DWORD startError = GetLastError();
    if (outputFile.empty()) {
        CloseHandle(outWrite);
        CloseHandle(errWrite);
    } else if (logH != INVALID_HANDLE_VALUE) {
        CloseHandle(logH);
    }
    CloseHandle(nul);
    if (!started) {
        if (outRead) CloseHandle(outRead);
        if (errRead) CloseHandle(errRead);
        CloseHandle(job);
        fail(format("could not run %s (error %lu)", utf8(argv[0]).c_str(), startError));
    }
    AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    std::thread outThread, errThread;
    if (outRead) outThread = std::thread(drainPipe, outRead, &r.out);
    if (errRead) errThread = std::thread(drainPipe, errRead, &r.err);
    DWORD wait = WaitForSingleObject(pi.hProcess, timeoutSeconds > 0 ? (DWORD)(timeoutSeconds * 1000) : INFINITE);
    if (wait == WAIT_TIMEOUT) {
        LOG("shell: %s exceeded %ds; killing its process tree", utf8(argv[0]).c_str(), (int)timeoutSeconds);
        TerminateJobObject(job, 1);
        WaitForSingleObject(pi.hProcess, 10000);
        r.timedOut = true;
    }
    GetExitCodeProcess(pi.hProcess, &r.code);
    CloseHandle(pi.hProcess);
    // Closing the job kills any grandchild still holding our pipes open.
    CloseHandle(job);
    if (outThread.joinable()) outThread.join();
    if (errThread.joinable()) errThread.join();
    if (outRead) CloseHandle(outRead);
    if (errRead) CloseHandle(errRead);
    if (!outputFile.empty()) r.err = fileTail(outputFile, 4000);
    return r;
}

// ----------------------------------------------------------------- crypto

static string hexOf(const unsigned char *data, size_t len) {
    static const char *digits = "0123456789abcdef";
    string out;
    for (size_t i = 0; i < len; i++) {
        out.push_back(digits[data[i] >> 4]);
        out.push_back(digits[data[i] & 15]);
    }
    return out;
}

struct Sha256 {
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    Sha256() {
        BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
        BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0);
    }
    ~Sha256() {
        if (hash) BCryptDestroyHash(hash);
        if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    }
    void update(const void *data, size_t len) { BCryptHashData(hash, (PUCHAR)data, (ULONG)len, 0); }
    vector<unsigned char> finish() {
        vector<unsigned char> out(32);
        BCryptFinishHash(hash, out.data(), 32, 0);
        return out;
    }
};

static string sha256File(const wstring &path) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN,
                           nullptr);
    if (h == INVALID_HANDLE_VALUE) fail("cannot read " + utf8(path));
    Sha256 sha;
    vector<char> buf(1 << 20);
    DWORD n = 0;
    while (ReadFile(h, buf.data(), (DWORD)buf.size(), &n, nullptr) && n > 0) sha.update(buf.data(), n);
    CloseHandle(h);
    vector<unsigned char> digest = sha.finish();
    return hexOf(digest.data(), digest.size());
}

static string base64(const vector<unsigned char> &data) {
    DWORD n = 0;
    CryptBinaryToStringA(data.data(), (DWORD)data.size(), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &n);
    string out(n, 0);
    CryptBinaryToStringA(data.data(), (DWORD)data.size(), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, &out[0], &n);
    out.resize(n);
    while (!out.empty() && (out.back() == 0 || out.back() == '\r' || out.back() == '\n')) out.pop_back();
    return out;
}

static bool unbase64(const string &text, DWORD flags, vector<unsigned char> &out) {
    DWORD n = 0;
    if (!CryptStringToBinaryA(text.c_str(), (DWORD)text.size(), flags, nullptr, &n, nullptr, nullptr)) return false;
    out.resize(n);
    if (!CryptStringToBinaryA(text.c_str(), (DWORD)text.size(), flags, out.data(), &n, nullptr, nullptr)) return false;
    out.resize(n);
    return true;
}

// ECDSA signatures: BCrypt speaks raw r||s; the contract (and CryptoKit,
// OpenSSL and Node) speak DER.
static void derInteger(vector<unsigned char> &out, const unsigned char *v, size_t len) {
    while (len > 1 && v[0] == 0) { v++; len--; }
    bool pad = v[0] & 0x80;
    out.push_back(0x02);
    out.push_back((unsigned char)(len + (pad ? 1 : 0)));
    if (pad) out.push_back(0);
    out.insert(out.end(), v, v + len);
}

static vector<unsigned char> rawToDer(const vector<unsigned char> &raw) {
    vector<unsigned char> body;
    derInteger(body, raw.data(), 32);
    derInteger(body, raw.data() + 32, 32);
    vector<unsigned char> out = {0x30, (unsigned char)body.size()};
    out.insert(out.end(), body.begin(), body.end());
    return out;
}

static bool derToRaw(const vector<unsigned char> &der, vector<unsigned char> &raw) {
    size_t i = 0;
    auto readLen = [&](size_t &len) -> bool {
        if (i >= der.size()) return false;
        unsigned char b = der[i++];
        if (b < 0x80) { len = b; return true; }
        if (b == 0x81 && i < der.size()) { len = der[i++]; return true; }
        return false;
    };
    size_t len;
    if (der.size() < 8 || der[i++] != 0x30 || !readLen(len) || i + len != der.size()) return false;
    raw.assign(64, 0);
    for (int part = 0; part < 2; part++) {
        if (i >= der.size() || der[i++] != 0x02 || !readLen(len) || i + len > der.size()) return false;
        const unsigned char *v = der.data() + i;
        size_t n = len;
        while (n > 0 && v[0] == 0) { v++; n--; }
        if (n > 32) return false;
        memcpy(raw.data() + part * 32 + (32 - n), v, n);
        i += len;
    }
    return i == der.size();
}

static const unsigned char kP256SpkiPrefix[] = {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                                0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};
static const unsigned char kP256CurveOidDer[] = {0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07};

// Signs and verifies the app tree: ECDSA P-256 / SHA-256 over
// `stella-tree-v1\n<HEAD^{tree}>\n`, DER, base64, as a git note under
// refs/notes/stella-signed. The private key is a DPAPI-protected (current
// user) BCRYPT_ECCPRIVATE_BLOB in signing.key; STELLA_LAUNCHER_KEY_FILE points
// at a PKCS#8 PEM instead, for testing.
class TreeSigner {
public:
    TreeSigner() {
        if (BCryptOpenAlgorithmProvider(&alg_, BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) != 0) fail("ECDSA is unavailable");
        string file = trim(utf8(envVar(L"STELLA_LAUNCHER_KEY_FILE")));
        if (!file.empty()) loadOrCreateFileKey(wide(file));
        else loadOrCreateProtectedKey();
        string pem = "-----BEGIN PUBLIC KEY-----\n";
        string b64 = base64(spki());
        for (size_t i = 0; i < b64.size(); i += 64) pem += b64.substr(i, 64) + "\n";
        pem += "-----END PUBLIC KEY-----\n";
        string existing;
        if (!readFile(P.signingPub(), existing) || existing != pem) writeFileAtomic(P.signingPub(), pem);
    }
    ~TreeSigner() {
        if (key_) BCryptDestroyKey(key_);
        if (alg_) BCryptCloseAlgorithmProvider(alg_, 0);
    }

    // Base64 SPKI DER: STELLA_LAUNCHER_PUBKEY for Electron.
    string publicKeySPKIBase64() const { return base64(spki()); }

    static string message(const string &tree) { return "stella-tree-v1\n" + tree + "\n"; }

    string signature(const string &tree) const {
        vector<unsigned char> digest = hash(message(tree));
        vector<unsigned char> raw(64);
        ULONG n = 0;
        if (BCryptSignHash(key_, nullptr, digest.data(), 32, raw.data(), 64, &n, 0) != 0 || n != 64) fail("signing failed");
        return base64(rawToDer(raw));
    }

    bool verify(const string &tree, const string &note) const {
        vector<unsigned char> der, raw;
        if (!unbase64(trim(note), CRYPT_STRING_BASE64, der) || !derToRaw(der, raw)) return false;
        vector<unsigned char> digest = hash(message(tree));
        return BCryptVerifySignature(key_, nullptr, digest.data(), 32, raw.data(), 64, 0) == 0;
    }

private:
    BCRYPT_ALG_HANDLE alg_ = nullptr;
    BCRYPT_KEY_HANDLE key_ = nullptr;
    vector<unsigned char> x_, y_, d_;

    static vector<unsigned char> hash(const string &text) {
        Sha256 sha;
        sha.update(text.data(), text.size());
        return sha.finish();
    }

    vector<unsigned char> spki() const {
        vector<unsigned char> out(kP256SpkiPrefix, kP256SpkiPrefix + sizeof(kP256SpkiPrefix));
        out.push_back(0x04);
        out.insert(out.end(), x_.begin(), x_.end());
        out.insert(out.end(), y_.begin(), y_.end());
        return out;
    }

    vector<unsigned char> privateBlob() const {
        BCRYPT_ECCKEY_BLOB header = {BCRYPT_ECDSA_PRIVATE_P256_MAGIC, 32};
        vector<unsigned char> blob((unsigned char *)&header, (unsigned char *)&header + sizeof(header));
        blob.insert(blob.end(), x_.begin(), x_.end());
        blob.insert(blob.end(), y_.begin(), y_.end());
        blob.insert(blob.end(), d_.begin(), d_.end());
        return blob;
    }

    void importBlob(const vector<unsigned char> &blob) {
        if (blob.size() != sizeof(BCRYPT_ECCKEY_BLOB) + 96) fail("the signing key is malformed");
        auto header = (const BCRYPT_ECCKEY_BLOB *)blob.data();
        if (header->dwMagic != BCRYPT_ECDSA_PRIVATE_P256_MAGIC || header->cbKey != 32) fail("the signing key is not P-256");
        const unsigned char *p = blob.data() + sizeof(BCRYPT_ECCKEY_BLOB);
        x_.assign(p, p + 32);
        y_.assign(p + 32, p + 64);
        d_.assign(p + 64, p + 96);
        if (BCryptImportKeyPair(alg_, nullptr, BCRYPT_ECCPRIVATE_BLOB, &key_, (PUCHAR)blob.data(), (ULONG)blob.size(), 0) != 0)
            fail("the signing key could not be imported");
    }

    void generate() {
        BCRYPT_KEY_HANDLE k = nullptr;
        if (BCryptGenerateKeyPair(alg_, &k, 256, 0) != 0 || BCryptFinalizeKeyPair(k, 0) != 0) fail("key generation failed");
        ULONG n = 0;
        BCryptExportKey(k, nullptr, BCRYPT_ECCPRIVATE_BLOB, nullptr, 0, &n, 0);
        vector<unsigned char> blob(n);
        BCryptExportKey(k, nullptr, BCRYPT_ECCPRIVATE_BLOB, blob.data(), n, &n, 0);
        BCryptDestroyKey(k);
        importBlob(blob);
        SecureZeroMemory(blob.data(), blob.size());
    }

    void loadOrCreateProtectedKey() {
        static const char kEntropy[] = "stella-launcher-tree-signing";
        DATA_BLOB entropy = {(DWORD)strlen(kEntropy), (BYTE *)kEntropy};
        string stored;
        if (readFile(P.signingKey(), stored)) {
            DATA_BLOB in = {(DWORD)stored.size(), (BYTE *)stored.data()}, out = {0, nullptr};
            if (!CryptUnprotectData(&in, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out))
                fail(format("Could not unlock the signing key (error %lu).", GetLastError()));
            vector<unsigned char> blob(out.pbData, out.pbData + out.cbData);
            SecureZeroMemory(out.pbData, out.cbData);
            LocalFree(out.pbData);
            importBlob(blob);
            SecureZeroMemory(blob.data(), blob.size());
            return;
        }
        generate();
        vector<unsigned char> blob = privateBlob();
        DATA_BLOB in = {(DWORD)blob.size(), blob.data()}, out = {0, nullptr};
        BOOL ok = CryptProtectData(&in, L"Stella app signing key", &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out);
        SecureZeroMemory(blob.data(), blob.size());
        if (!ok) fail(format("Could not protect the signing key (error %lu).", GetLastError()));
        bool written = writeFileAtomic(P.signingKey(), string((char *)out.pbData, out.cbData));
        LocalFree(out.pbData);
        if (!written) fail("Could not write " + utf8(P.signingKey()));
        LOG("signing: generated a DPAPI-protected key");
    }

    void loadOrCreateFileKey(const wstring &path) {
        string pem;
        if (readFile(path, pem)) {
            vector<unsigned char> der;
            if (!unbase64(pem, CRYPT_STRING_BASE64HEADER, der)) fail(utf8(path) + " is not a PEM file.");
            // PKCS#8 wraps SEC1; a bare SEC1 "EC PRIVATE KEY" works too.
            vector<unsigned char> sec1 = der;
            CRYPT_PRIVATE_KEY_INFO *pkcs8 = nullptr;
            DWORD size = 0;
            if (CryptDecodeObjectEx(X509_ASN_ENCODING, PKCS_PRIVATE_KEY_INFO, der.data(), (DWORD)der.size(),
                                    CRYPT_DECODE_ALLOC_FLAG, nullptr, &pkcs8, &size)) {
                sec1.assign(pkcs8->PrivateKey.pbData, pkcs8->PrivateKey.pbData + pkcs8->PrivateKey.cbData);
                LocalFree(pkcs8);
            }
            CRYPT_ECC_PRIVATE_KEY_INFO *ec = nullptr;
            if (!CryptDecodeObjectEx(X509_ASN_ENCODING, X509_ECC_PRIVATE_KEY, sec1.data(), (DWORD)sec1.size(),
                                     CRYPT_DECODE_ALLOC_FLAG, nullptr, &ec, &size))
                fail(utf8(path) + " is not a P-256 private key.");
            bool ok = ec->PrivateKey.cbData <= 32 && ec->PublicKey.cbData == 65 && ec->PublicKey.pbData[0] == 0x04;
            if (ok) {
                vector<unsigned char> d(32, 0);
                memcpy(d.data() + 32 - ec->PrivateKey.cbData, ec->PrivateKey.pbData, ec->PrivateKey.cbData);
                BCRYPT_ECCKEY_BLOB header = {BCRYPT_ECDSA_PRIVATE_P256_MAGIC, 32};
                vector<unsigned char> blob((unsigned char *)&header, (unsigned char *)&header + sizeof(header));
                blob.insert(blob.end(), ec->PublicKey.pbData + 1, ec->PublicKey.pbData + 65);
                blob.insert(blob.end(), d.begin(), d.end());
                LocalFree(ec);
                importBlob(blob);
                return;
            }
            LocalFree(ec);
            fail(utf8(path) + " is not a P-256 private key (it needs its public key).");
        }
        generate();
        // SEC1 ECPrivateKey inside PKCS#8, as OpenSSL and CryptoKit write it.
        CRYPT_ECC_PRIVATE_KEY_INFO ec;
        ZeroMemory(&ec, sizeof(ec));
        vector<unsigned char> point = {0x04};
        point.insert(point.end(), x_.begin(), x_.end());
        point.insert(point.end(), y_.begin(), y_.end());
        ec.dwVersion = CRYPT_ECC_PRIVATE_KEY_INFO_v1;
        ec.PrivateKey = {(DWORD)d_.size(), d_.data()};
        ec.szCurveOid = (LPSTR)szOID_ECC_CURVE_P256;
        ec.PublicKey.cbData = (DWORD)point.size();
        ec.PublicKey.pbData = point.data();
        BYTE *sec1 = nullptr;
        DWORD sec1Len = 0;
        if (!CryptEncodeObjectEx(X509_ASN_ENCODING, X509_ECC_PRIVATE_KEY, &ec, CRYPT_ENCODE_ALLOC_FLAG, nullptr, &sec1, &sec1Len))
            fail("could not encode the signing key");
        CRYPT_PRIVATE_KEY_INFO info;
        ZeroMemory(&info, sizeof(info));
        info.Algorithm.pszObjId = (LPSTR)szOID_ECC_PUBLIC_KEY;
        info.Algorithm.Parameters = {(DWORD)sizeof(kP256CurveOidDer), (BYTE *)kP256CurveOidDer};
        info.PrivateKey = {sec1Len, sec1};
        BYTE *pkcs8 = nullptr;
        DWORD pkcs8Len = 0;
        BOOL ok = CryptEncodeObjectEx(X509_ASN_ENCODING, PKCS_PRIVATE_KEY_INFO, &info, CRYPT_ENCODE_ALLOC_FLAG, nullptr,
                                      &pkcs8, &pkcs8Len);
        LocalFree(sec1);
        if (!ok) fail("could not encode the signing key");
        string b64 = base64(vector<unsigned char>(pkcs8, pkcs8 + pkcs8Len));
        LocalFree(pkcs8);
        string out = "-----BEGIN PRIVATE KEY-----\n";
        for (size_t i = 0; i < b64.size(); i += 64) out += b64.substr(i, 64) + "\n";
        out += "-----END PRIVATE KEY-----\n";
        mkdirs(parentDir(path));
        if (!writeFileAtomic(path, out)) fail("Could not write " + utf8(path));
        LOG("signing: generated a key file at %s", utf8(path).c_str());
    }
};

// ------------------------------------------------------------------- net

struct HttpResponse {
    DWORD status = 0;
    string body;
};

// GET (to a file, or into memory) or POST through WinHTTP, following redirects
// and using the system proxy settings.
static HttpResponse http(const wstring &url, const wchar_t *method, const string &body, const wstring &toFile) {
    URL_COMPONENTS parts;
    ZeroMemory(&parts, sizeof(parts));
    parts.dwStructSize = sizeof(parts);
    wchar_t host[512], path[4096];
    parts.lpszHostName = host;
    parts.dwHostNameLength = 512;
    parts.lpszUrlPath = path;
    parts.dwUrlPathLength = 4096;
    wchar_t extra[4096];
    parts.lpszExtraInfo = extra;
    parts.dwExtraInfoLength = 4096;
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &parts)) fail("Invalid URL " + utf8(url));
    wstring target = wstring(path, parts.dwUrlPathLength) + wstring(extra, parts.dwExtraInfoLength);

    HINTERNET session = WinHttpOpen(L"StellaLauncher/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session)
        session = WinHttpOpen(L"StellaLauncher/1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                              WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) fail("WinHTTP is unavailable");
    WinHttpSetTimeouts(session, 30000, 30000, 60000, 60000);
    HINTERNET connect = WinHttpConnect(session, wstring(host, parts.dwHostNameLength).c_str(), parts.nPort, 0);
    HINTERNET request = connect ? WinHttpOpenRequest(connect, method, target.c_str(), nullptr, WINHTTP_NO_REFERER,
                                                     WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                     parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)
                                : nullptr;
    auto cleanup = [&]() {
        if (request) WinHttpCloseHandle(request);
        if (connect) WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
    };
    const wchar_t *headers = body.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : L"Content-Type: application/json\r\n";
    if (!request ||
        !WinHttpSendRequest(request, headers, body.empty() ? 0 : (DWORD)-1L, (LPVOID)(body.empty() ? nullptr : body.data()),
                            (DWORD)body.size(), (DWORD)body.size(), 0) ||
        !WinHttpReceiveResponse(request, nullptr)) {
        DWORD error = GetLastError();
        cleanup();
        fail(format("Could not reach %s (error %lu).", utf8(url).c_str(), error));
    }
    HttpResponse response;
    DWORD size = sizeof(response.status);
    WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                        &response.status, &size, WINHTTP_NO_HEADER_INDEX);
    HANDLE file = INVALID_HANDLE_VALUE;
    if (!toFile.empty() && response.status == 200) {
        file = CreateFileW(toFile.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) { cleanup(); fail("Could not write " + utf8(toFile)); }
    }
    vector<char> buf(1 << 16);
    for (;;) {
        DWORD n = 0;
        if (!WinHttpReadData(request, buf.data(), (DWORD)buf.size(), &n)) {
            DWORD error = GetLastError();
            if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
            cleanup();
            fail(format("Download of %s was interrupted (error %lu).", utf8(url).c_str(), error));
        }
        if (n == 0) break;
        if (file != INVALID_HANDLE_VALUE) {
            DWORD w;
            WriteFile(file, buf.data(), n, &w, nullptr);
        } else {
            response.body.append(buf.data(), n);
        }
    }
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    cleanup();
    return response;
}

// Download to `dest`, refusing anything whose sha256 differs.
static void download(const string &url, const wstring &dest, const string &sha256) {
    wstring staging = dest + L".download";
    DeleteFileW(staging.c_str());
    HttpResponse r = http(wide(url), L"GET", string(), staging);
    if (r.status != 200) {
        DeleteFileW(staging.c_str());
        fail(format("Download of %s failed (HTTP %lu).", url.c_str(), r.status));
    }
    string actual = sha256File(staging);
    if (_stricmp(actual.c_str(), sha256.c_str()) != 0) {
        DeleteFileW(staging.c_str());
        fail("Checksum mismatch for " + url + ": expected " + sha256 + ", got " + actual + ".");
    }
    MoveFileExW(staging.c_str(), dest.c_str(), MOVEFILE_REPLACE_EXISTING);
}

// ------------------------------------------------------------------- git

static Env baseEnvironment();

static const vector<std::pair<wstring, wstring>> kIdentityEnv = {
    {L"GIT_AUTHOR_NAME", L"Stella"},
    {L"GIT_AUTHOR_EMAIL", L"stella@localhost"},
    {L"GIT_COMMITTER_NAME", L"Stella"},
    {L"GIT_COMMITTER_EMAIL", L"stella@localhost"},
};

// PortableGit under runtimes\git-<v>, with the environment it needs; the same
// variables go to Electron, matching bundled-runtime-environment.ts.
struct GitTool {
    wstring root;
    wstring bin() const { return root + L"\\cmd\\git.exe"; }

    vector<std::pair<wstring, wstring>> runtimeEnv() const {
        return {
            {L"STELLA_GIT_BIN", bin()},
            {L"LOCAL_GIT_DIRECTORY", root},
            {L"GIT_EXEC_PATH", root + L"\\mingw64\\libexec\\git-core"},
            {L"GIT_TEMPLATE_DIR", root + L"\\mingw64\\share\\git-core\\templates"},
            {L"STELLA_GIT_BASH", root + L"\\usr\\bin\\bash.exe"},
        };
    }

    vector<wstring> pathEntries() const { return {root + L"\\cmd", root + L"\\mingw64\\bin", root + L"\\usr\\bin"}; }

    CmdResult raw(const vector<string> &args, const wstring &cwd,
                  const vector<std::pair<wstring, wstring>> &extra = {}) const {
        Env env = baseEnvironment();
        for (auto &kv : runtimeEnv())
            if (kv.first != L"STELLA_GIT_BIN" && kv.first != L"LOCAL_GIT_DIRECTORY" && kv.first != L"STELLA_GIT_BASH")
                env[kv.first] = kv.second;
        env[L"GIT_TERMINAL_PROMPT"] = L"0";
        for (auto &kv : extra) env[kv.first] = kv.second;
        vector<wstring> argv = {bin()};
        for (auto &a : args) argv.push_back(wide(a));
        return runCmd(argv, cwd, env);
    }

    string run(const vector<string> &args, const wstring &cwd, const vector<std::pair<wstring, wstring>> &extra = {}) const {
        CmdResult r = raw(args, cwd, extra);
        if (r.code != 0) {
            string detail = trim(r.err);
            fail("git " + (args.empty() ? string() : args[0]) + " failed: " +
                 (detail.empty() ? format("exit %lu", r.code) : detail));
        }
        return trim(r.out);
    }
};

static std::unique_ptr<GitTool> gGit;
static std::unique_ptr<TreeSigner> gSigner;
static wstring gBunBin;
static string gBunVersion;

// ------------------------------------------------------------ environments

// The environment for git, bun and Electron: the managed runtimes first on
// PATH, and none of the launcher's own secrets.
static Env baseEnvironment() {
    Env env = currentEnvironment();
    bool usesTestKey = !trim(utf8(envVar(L"STELLA_LAUNCHER_KEY_FILE"))).empty();
    for (const wchar_t *key :
         {L"STELLA_LAUNCHER_KEY_FILE", L"STELLA_LAUNCHER_ROOT", L"ELECTRON_RUN_AS_NODE", L"STELLA_V2_DEV_DATA_DIR",
          L"STELLA_APP_DIR", L"STELLA_RUNTIME_STATE_DIR", L"STELLA_DEV_RESTART_REQUEST_FILE",
          L"STELLA_DEV_USER_QUIT_REQUEST_FILE", L"STELLA_ELECTRON_DEV_RUNNER_PID", L"STELLA_ELECTRON_READY_FILE",
          L"NODE_OPTIONS", L"STELLA_LAUNCHER_PIPE"})
        env.erase(key);
    // The dev harness opens Electron to debugging, so it passes through only
    // for a test root signed with a test key file.
    if (!(P.isolated && usesTestKey))
        for (const wchar_t *key : {L"STELLA_DEV_HARNESS", L"STELLA_DEV_HARNESS_STORAGE_KEY", L"STELLA_V2_DEV_USER_DATA_DIR",
                                   L"STELLA_REMOTE_DEBUG_PORT", L"STELLA_DEV_HARNESS_SESSION_TOKEN"})
            env.erase(key);
    if (P.isolated) env.erase(L"STELLA_DATA_DIR");
    vector<wstring> front;
    if (!gBunBin.empty()) front.push_back(parentDir(gBunBin));
    if (gGit)
        for (auto &e : gGit->pathEntries()) front.push_back(e);
    wstring path;
    for (auto &e : front) path += e + L";";
    auto existing = env.find(L"PATH");
    path += existing != env.end() && !existing->second.empty() ? existing->second
                                                               : envVar(L"SystemRoot") + L"\\System32;" + envVar(L"SystemRoot");
    env.erase(L"PATH");
    env[L"Path"] = path;
    return env;
}

static Env electronEnvironment(const wstring &pipeName) {
    Env env = baseEnvironment();
    env[L"STELLA_LAUNCHER"] = L"1";
    // The backend this launcher installs from is the one the app talks to.
    env[L"VITE_STELLA_BACKEND_URL"] = O.backend;
    env[L"STELLA_LAUNCHER_PIPE"] = pipeName;
    if (!gBunBin.empty()) env[L"STELLA_BUN_PATH"] = gBunBin;
    if (gGit)
        for (auto &kv : gGit->runtimeEnv()) env[kv.first] = kv.second;
    if (gSigner) env[L"STELLA_LAUNCHER_PUBKEY"] = wide(gSigner->publicKeySPKIBase64());
    if (P.isolated) {
        // A test root never touches the real profile or Stella home.
        env[L"STELLA_LAUNCHER_USER_DATA_DIR"] = P.isolatedUserData();
        env[L"STELLA_DATA_DIR"] = P.isolatedHome();
        env[L"STELLA_V2_DEV_DATA_DIR"] = P.isolatedHome();
    }
    return env;
}

// -------------------------------------------------------------------- UI

// What the work loop needs from a UI. WebUi (launcher/common/launcher.html in
// WebView2) is the normal one; DialogUi, TaskDialogs, stands in when no
// WebView2 runtime is installed. Every call comes from the work thread.
struct Recovery {
    string reason;
    vector<string> output;
    bool hasKnownGood = false;
    Choice automation = Choice::None;  // self-test: choose this after automationDelay
    double automationDelay = 0;
    wstring capturePath;
};

class Ui {
public:
    virtual ~Ui() {}
    // Idle: wait for Start (Retry), Return, Reinstall or Quit.
    virtual Choice idle() = 0;
    // Starting: what is happening now; `show` brings a hidden window up.
    // Starting: what is happening in plain words, and the part of setup it
    // covers (from..to, 0..1; the window's bar eases between them).
    virtual void starting(const string &status, double from, double to, bool show) = 0;
    // Electron is ready.
    virtual void running() = 0;
    // Failed: show why, then wait for a choice.
    virtual Choice failed(const Recovery &recovery) = 0;
    // Settings' Version and Return to last working version.
    virtual void installInfo(const string &version, bool hasKnownGood) {}
};

static Ui *gUi = nullptr;

// A step worth telling the user about; like the old progress dialog, it
// brings the window up.
static void progress(const string &status, double from, double to) {
    LOG("progress: %s", status.c_str());
    gUi->starting(status, from, to, true);
}

static void requestShutdown();

// ------------------------------------------------- UI: TaskDialog fallback

// The install/prepare progress panel: a marquee TaskDialog on its own thread.
class ProgressWindow {
public:
    void show(const string &status) {
        std::unique_lock<std::mutex> lock(mutex_);
        status_ = wide(status);
        if (hwnd_) {
            HWND h = hwnd_;
            wstring text = status_;
            lock.unlock();
            SendMessageW(h, TDM_SET_ELEMENT_TEXT, TDE_CONTENT, (LPARAM)text.c_str());
            return;
        }
        if (running_) return;
        running_ = true;
        closing_ = false;
        if (thread_.joinable()) thread_.detach();
        thread_ = std::thread([this]() { run(); });
    }

    void hide() {
        std::unique_lock<std::mutex> lock(mutex_);
        closing_ = true;
        HWND h = hwnd_;
        lock.unlock();
        if (h) PostMessageW(h, TDM_CLICK_BUTTON, IDCANCEL, 0);
        if (thread_.joinable()) thread_.join();
    }

private:
    std::mutex mutex_;
    std::thread thread_;
    HWND hwnd_ = nullptr;
    bool running_ = false, closing_ = false;
    wstring status_;

    static HRESULT CALLBACK callback(HWND hwnd, UINT msg, WPARAM, LPARAM, LONG_PTR ref) {
        auto self = (ProgressWindow *)ref;
        switch (msg) {
        case TDN_CREATED: {
            SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_MARQUEE, TRUE, 30);
            std::lock_guard<std::mutex> lock(self->mutex_);
            self->hwnd_ = hwnd;
            if (self->closing_) PostMessageW(hwnd, TDM_CLICK_BUTTON, IDCANCEL, 0);
            SendMessageW(hwnd, TDM_SET_ELEMENT_TEXT, TDE_CONTENT, (LPARAM)self->status_.c_str());
            break;
        }
        case TDN_BUTTON_CLICKED: {
            std::lock_guard<std::mutex> lock(self->mutex_);
            if (!self->closing_) {
                // Cancel during install quits the launcher.
                LOG("launcher: install cancelled");
                ExitProcess(1);
            }
            break;
        }
        case TDN_DESTROYED: {
            std::lock_guard<std::mutex> lock(self->mutex_);
            self->hwnd_ = nullptr;
            break;
        }
        }
        return S_OK;
    }

    void run() {
        TASKDIALOGCONFIG config;
        ZeroMemory(&config, sizeof(config));
        config.cbSize = sizeof(config);
        config.hInstance = GetModuleHandleW(nullptr);
        config.dwFlags = TDF_SHOW_MARQUEE_PROGRESS_BAR | TDF_POSITION_RELATIVE_TO_WINDOW | TDF_SIZE_TO_CONTENT;
        config.dwCommonButtons = TDCBF_CANCEL_BUTTON;
        config.pszWindowTitle = L"Stella";
        config.pszMainInstruction = L"Getting Stella ready";
        config.pszContent = L" ";
        config.cxWidth = 220;
        config.pfCallback = callback;
        config.lpCallbackData = (LONG_PTR)this;
        TaskDialogIndirect(&config, nullptr, nullptr, nullptr);
        std::lock_guard<std::mutex> lock(mutex_);
        running_ = false;
        hwnd_ = nullptr;
    }
};

static ProgressWindow gProgress;

// "Stella couldn't start": the reason, the last 40 lines Electron wrote, and
// Return to last working / Try again / Quit. Blocks until a choice is made.
struct RecoveryDialog {
    const Recovery &recovery;
    bool clicked = false;

    enum { kReturn = 101, kReinstall = 102, kRetry = 103, kQuit = 104 };

    static HRESULT CALLBACK callback(HWND hwnd, UINT msg, WPARAM wParam, LPARAM, LONG_PTR ref) {
        auto self = (RecoveryDialog *)ref;
        const Recovery &r = self->recovery;
        if (msg == TDN_CREATED) {
            SetForegroundWindow(hwnd);
        } else if (msg == TDN_TIMER && !self->clicked && r.automation != Choice::None && wParam > r.automationDelay * 1000) {
            self->clicked = true;
            // "return" means the primary button, "Reinstall" without a known-good version.
            int id = r.automation == Choice::Return ? (r.hasKnownGood ? kReturn : kReinstall)
                     : r.automation == Choice::Retry ? kRetry
                                                     : kQuit;
            LOG("recovery: self-test clicks %s", choiceName(r.automation));
            PostMessageW(hwnd, TDM_CLICK_BUTTON, id, 0);
        }
        return S_OK;
    }

    Choice present() {
        const Recovery &r = recovery;
        string joined;
        for (size_t i = 0; i < r.output.size(); i++) joined += (i ? "\n" : "") + r.output[i];
        wstring content = wide(r.reason);
        wstring details = wide(r.output.empty() ? string("(Stella wrote no output.)") : joined);
        TASKDIALOG_BUTTON buttons[] = {
            {r.hasKnownGood ? kReturn : kReinstall, r.hasKnownGood ? L"Return to last working version" : L"Reinstall"},
            {kRetry, L"Try again"},
            {kQuit, L"Quit"},
        };
        TASKDIALOGCONFIG config;
        ZeroMemory(&config, sizeof(config));
        config.cbSize = sizeof(config);
        config.hInstance = GetModuleHandleW(nullptr);
        config.dwFlags = TDF_EXPANDED_BY_DEFAULT | TDF_CALLBACK_TIMER | TDF_ALLOW_DIALOG_CANCELLATION;
        config.pszWindowTitle = L"Stella";
        config.pszMainIcon = TD_WARNING_ICON;
        config.pszMainInstruction = L"Stella couldn't start";
        config.pszContent = content.c_str();
        config.pszExpandedInformation = details.c_str();
        config.pszExpandedControlText = L"Hide output";
        config.pszCollapsedControlText = L"Show output";
        config.pButtons = buttons;
        config.cButtons = 3;
        config.nDefaultButton = buttons[0].nButtonID;
        config.cxWidth = 320;
        config.pfCallback = callback;
        config.lpCallbackData = (LONG_PTR)this;
        LOG("recovery: shown reason: %s", r.reason.c_str());
        int pressed = kQuit;
        if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) {
            LOG("recovery: the dialog could not be shown");
            pressed = r.automation == Choice::Retry ? kRetry : r.automation == Choice::Return ? kReturn : kQuit;
        }
        Choice choice = pressed == kReturn ? Choice::Return
                        : pressed == kReinstall ? Choice::Reinstall
                        : pressed == kRetry ? Choice::Retry
                                            : Choice::Quit;
        if (choice == Choice::Return && !r.hasKnownGood) choice = Choice::Reinstall;
        LOG("recovery: chose %s", choiceName(choice));
        return choice;
    }
};

class DialogUi : public Ui {
public:
    // No Start button here: start right away, as the launcher always did.
    Choice idle() override { return Choice::Retry; }
    void starting(const string &status, double, double, bool show) override {
        if (show) gProgress.show(status);
    }
    void running() override { gProgress.hide(); }
    Choice failed(const Recovery &recovery) override {
        gProgress.hide();
        RecoveryDialog dialog{recovery};
        return dialog.present();
    }
};

// ------------------------------------------------------- UI: WebView2 loader

// Stella.exe ships no WebView2Loader.dll; it does the loader's job for the
// installed Evergreen runtime. EdgeUpdate records the runtime's directory
// under ClientState\{stable channel} (EBWebView) and its version under
// Clients\{stable channel} (pv); the runtime's EmbeddedBrowserWebView.dll
// exports the factory that CreateCoreWebView2EnvironmentWithOptions calls.
typedef HRESULT(STDMETHODCALLTYPE *CreateWebViewEnvironmentFn)(
    bool checkRunningInstance, int runtimeType /* 0: installed */, PCWSTR userDataFolder, IUnknown *options,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *handler);

static wstring registryString(HKEY root, const wstring &key, const wchar_t *name) {
    wchar_t buf[1024];
    DWORD size = sizeof(buf);
    // EdgeUpdate is a 32-bit program: its HKLM keys are under WOW6432Node.
    if (RegGetValueW(root, key.c_str(), name, RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY, nullptr, buf, &size) != ERROR_SUCCESS)
        return wstring();
    return buf;
}

static CreateWebViewEnvironmentFn loadWebView2(string &dllPath) {
    static const wstring kStableChannel = L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
#if defined(__aarch64__)
    static const wchar_t *kArch = L"arm64";
#else
    static const wchar_t *kArch = L"x64";
#endif
    vector<wstring> dirs;
    for (HKEY root : {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER}) {
        wstring dir = registryString(root, L"SOFTWARE\\Microsoft\\EdgeUpdate\\ClientState\\" + kStableChannel, L"EBWebView");
        if (!dir.empty()) dirs.push_back(dir);
        // Per-machine installs live under Program Files (x86), per-user ones under LocalAppData.
        wstring pv = registryString(root, L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\" + kStableChannel, L"pv");
        if (!pv.empty() && pv != L"0.0.0.0")
            dirs.push_back((root == HKEY_LOCAL_MACHINE ? envVar(L"ProgramFiles(x86)") : knownFolder(FOLDERID_LocalAppData)) +
                           L"\\Microsoft\\EdgeWebView\\Application\\" + pv);
    }
    for (auto &dir : dirs) {
        wstring dll = dir + L"\\EBWebView\\" + kArch + L"\\EmbeddedBrowserWebView.dll";
        if (!exists(dll)) continue;
        HMODULE module = LoadLibraryExW(dll.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
        auto fn = module ? (CreateWebViewEnvironmentFn)(void *)GetProcAddress(module, "CreateWebViewEnvironmentWithOptionsInternal")
                         : nullptr;
        if (fn) {
            dllPath = utf8(dll);
            return fn;
        }
        LOG("ui: could not load %s (error %lu)", utf8(dll).c_str(), GetLastError());
    }
    return nullptr;
}

// WebView2.h declares its IIDs for WebView2LoaderStatic.lib to define; these
// are the ones Stella.exe needs, from the header's MIDL_INTERFACE lines.
static const IID kIID_EnvironmentCompleted = {0x4e8a3389, 0xc9d8, 0x4bd2, {0xb6, 0xb5, 0x12, 0x4f, 0xee, 0x6c, 0xc1, 0x4d}};
static const IID kIID_ControllerCompleted = {0x6c4819f3, 0xc9b7, 0x4260, {0x81, 0x27, 0xc9, 0xf5, 0xbd, 0xe7, 0xf6, 0x8c}};
static const IID kIID_WebMessageReceived = {0x57213f19, 0x00e6, 0x49fa, {0x8e, 0x07, 0x89, 0x8e, 0xa0, 0x1e, 0xcb, 0xd2}};
static const IID kIID_NavigationCompleted = {0xd33a35bf, 0x1c49, 0x4f98, {0x93, 0xab, 0x00, 0x6e, 0x05, 0x33, 0xfe, 0x1c}};
static const IID kIID_CapturePreviewCompleted = {0x697e05e9, 0x3d8f, 0x45fa, {0x96, 0xf4, 0x8f, 0xfe, 0x1e, 0xde, 0xda, 0xf5}};
static const IID kIID_Controller2 = {0xc979903e, 0xd4ca, 0x4228, {0x92, 0xeb, 0x47, 0xee, 0x3f, 0xa9, 0x6e, 0xab}};
static const IID kIID_Settings3 = {0xfdb5ab74, 0xaf33, 0x4854, {0x84, 0xf0, 0x0a, 0x63, 0x1d, 0xeb, 0x5e, 0xba}};

// A COM callback from a lambda: each WebView2 handler interface is IUnknown
// plus one Invoke. Created with one reference, which the creator releases
// after handing it to WebView2 (which holds its own).
template <typename I, typename M = decltype(&I::Invoke)> class Callback;
template <typename I, typename... A> class Callback<I, HRESULT (STDMETHODCALLTYPE I::*)(A...)> final : public I {
public:
    Callback(const IID &iid, std::function<HRESULT(A...)> fn) : iid_(iid), fn_(std::move(fn)) {}
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG n = --refs_;
        if (n == 0) delete this;
        return n;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **out) override {
        if (!IsEqualIID(riid, IID_IUnknown) && !IsEqualIID(riid, iid_)) {
            *out = nullptr;
            return E_NOINTERFACE;
        }
        *out = static_cast<I *>(this);
        AddRef();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Invoke(A... args) override { return fn_(args...); }

private:
    const IID &iid_;
    std::function<HRESULT(A...)> fn_;
    std::atomic<ULONG> refs_{1};
};

// --------------------------------------------------------- UI: the window

// The page, embedded as RCDATA (stella-launcher.rc), so the window never
// depends on the checkout the launcher may be recovering.
static string launcherPage() {
    HRSRC res = FindResourceW(nullptr, L"LAUNCHER_HTML", RT_RCDATA);
    HGLOBAL data = res ? LoadResource(nullptr, res) : nullptr;
    if (!data) return string();
    return string((const char *)LockResource(data), SizeofResource(nullptr, res));
}

static bool systemUsesDarkTheme() {
    DWORD light = 1, size = sizeof(light);
    RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme",
                 RRF_RT_REG_DWORD, nullptr, &light, &size);
    return light == 0;
}

static string jsonString(const string &s) {
    char *q = mj_quote(s.c_str());
    string out = q ? q : "\"\"";
    free(q);
    return out;
}

// A second Stella.exe finds the running launcher's window by its class and a
// property naming the install root.
static const wchar_t *kWindowClass = L"StellaLauncherWindow";
static const wchar_t *kRootProperty = L"StellaLauncherRoot";

static ULONG_PTR rootTag() {
    // FNV-1a over the lowercased root.
    uint32_t h = 2166136261u;
    for (wchar_t c : P.root) {
        h ^= (uint32_t)towlower(c);
        h *= 16777619u;
    }
    return h | 1;
}

enum : UINT {
    WM_UI_RENDER = WM_APP + 1,  // the state changed
    WM_UI_VISIBLE,              // show or hide, as wantVisible_ says
    WM_UI_SCRIPT,               // lParam: a new'd wstring of script to run
    WM_UI_CAPTURE,              // wParam: request id; lParam: a new'd wstring PNG path
    WM_UI_DONE,                 // the work loop returned
    WM_UI_ACTIVATE,             // show the window (a second Stella.exe sends this)
};

// One window with the shared page in WebView2. The UI thread owns the window
// and the WebView; the work thread changes the state under mutex_ and posts
// WM_UI_* messages, and blocks on cond_ for the user's commands.
class WebUi : public Ui {
public:
    // UI thread: create the window and the WebView, pumping messages until
    // the WebView is ready. False: use the fallback.
    bool create() {
        string dll;
        CreateWebViewEnvironmentFn createEnvironment = loadWebView2(dll);
        if (!createEnvironment) {
            LOG("ui: no WebView2 runtime; using the TaskDialog fallback");
            return false;
        }
        LOG("ui: WebView2 runtime %s", dll.c_str());

        HINSTANCE instance = GetModuleHandleW(nullptr);
        WNDCLASSEXW wc;
        ZeroMemory(&wc, sizeof(wc));
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = windowProc;
        wc.hInstance = instance;
        wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
        wc.hIconSm = (HICON)LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                       GetSystemMetrics(SM_CYSMICON), 0);
        wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        wc.lpszClassName = kWindowClass;
        RegisterClassExW(&wc);

        // 380x460 client at 96 DPI, scaled for and centered on the monitor
        // under the pointer. Hidden until the page has rendered.
        POINT cursor = {0, 0};
        GetCursorPos(&cursor);
        MONITORINFO monitor;
        monitor.cbSize = sizeof(monitor);
        GetMonitorInfoW(MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY), &monitor);
        const RECT &work = monitor.rcWork;
        DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        hwnd_ = CreateWindowExW(0, kWindowClass, L"Stella", style, work.left, work.top, 380, 460, nullptr, nullptr, instance, this);
        if (!hwnd_) {
            LOG("ui: could not create the window (error %lu); using the TaskDialog fallback", GetLastError());
            return false;
        }
        SetPropW(hwnd_, kRootProperty, (HANDLE)rootTag());
        UINT dpi = GetDpiForWindow(hwnd_);
        RECT rc = {0, 0, MulDiv(380, dpi, 96), MulDiv(460, dpi, 96)};
        AdjustWindowRectExForDpi(&rc, style, FALSE, 0, dpi);
        int w = rc.right - rc.left, h = rc.bottom - rc.top;
        SetWindowPos(hwnd_, nullptr, (work.left + work.right - w) / 2, (work.top + work.bottom - h) / 2, w, h,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        applyTheme();

        wstring userData = P.root + L"\\webview";
        mkdirs(userData);
        auto *handler = new Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            kIID_EnvironmentCompleted,
            [this](HRESULT hr, ICoreWebView2Environment *env) -> HRESULT { return environmentCreated(hr, env); });
        HRESULT hr = createEnvironment(true, 0, userData.c_str(), nullptr, handler);
        handler->Release();
        if (FAILED(hr)) {
            LOG("ui: WebView2 could not start (0x%08lx); using the TaskDialog fallback", (unsigned long)hr);
        } else {
            SetTimer(hwnd_, kCreateTimer, 30000, nullptr);
            MSG msg;
            while (creating_ == 0 && GetMessageW(&msg, nullptr, 0, 0) > 0) {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            KillTimer(hwnd_, kCreateTimer);
            if (creating_ == 1) return true;
            LOG("ui: WebView2 did not start; using the TaskDialog fallback");
        }
        creating_ = -1;
        if (controller_) controller_->Close();
        DestroyWindow(hwnd_);
        hwnd_ = nullptr;
        return false;
    }

    // UI thread: run the work loop on its own thread, pumping messages until it returns.
    int run(int (*work)()) {
        int code = 1;
        std::thread worker([&]() {
            CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            code = work();
            CoUninitialize();
            PostMessageW(hwnd_, WM_UI_DONE, 0, 0);
        });
        MSG msg;
        while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        worker.join();
        return code;
    }

    // ---- the work thread

    Choice idle() override {
        update([&]() {
            phase_ = "idle";
            status_.clear();
            command_ = Choice::None;
        });
        setVisible(true);
        if (!O.selfTest) return waitCommand();
        waitLoaded();
        pause(1);
        capture(L"home.png");
        LOG("ui: self-test presses Start");
        update([&]() {
            phase_ = "starting";
            status_ = "Starting Stella…";
            progress_ = 0;
            progressTo_ = 0.05;
        });
        return Choice::Retry;
    }

    void starting(const string &status, double from, double to, bool show) override {
        update([&]() {
            phase_ = "starting";
            status_ = status;
            progress_ = from;
            progressTo_ = to;
        });
        if (show) setVisible(true);
        bool captureNow;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            captureNow = !O.captureDir.empty() && wantVisible_ && !startingCaptured_;
            if (captureNow) startingCaptured_ = true;
        }
        if (captureNow) {
            waitLoaded();
            pause(0.5);
            capture(L"starting.png");
        }
    }

    void running() override {
        bool tour;
        update([&]() {
            phase_ = "running";
            status_.clear();
            tour = O.selfTest && !toured_;
            toured_ = true;
        });
        if (tour) {
            // The window a second Stella.exe brings up, then its Settings.
            PostMessageW(hwnd_, WM_UI_ACTIVATE, 0, 0);
            waitLoaded();
            pause(0.7);
            capture(L"running.png");
            script(L"window.stellaLauncher.showSettings(true)");
            pause(0.5);
            capture(L"settings.png");
            script(L"window.stellaLauncher.showSettings(false)");
        }
        setVisible(false);
    }

    Choice failed(const Recovery &r) override {
        update([&]() {
            phase_ = "failed";
            reason_ = r.reason;
            output_ = r.output;
            hasKnownGood_ = r.hasKnownGood;
            command_ = Choice::None;
        });
        setVisible(true);
        LOG("recovery: shown reason: %s", r.reason.c_str());
        ULONGLONG shown = GetTickCount64();
        Choice choice;
        if (!r.capturePath.empty() || r.automation != Choice::None) waitLoaded();
        if (!r.capturePath.empty()) {
            pause(0.7);
            capture(r.capturePath);
        }
        if (r.automation != Choice::None) {
            double waited = (GetTickCount64() - shown) / 1000.0;
            if (waited < r.automationDelay) pause(r.automationDelay - waited);
            LOG("recovery: self-test clicks %s", choiceName(r.automation));
            choice = r.automation;
        } else {
            choice = waitCommand();
        }
        if (choice == Choice::Return && !r.hasKnownGood) choice = Choice::Reinstall;
        LOG("recovery: chose %s", choiceName(choice));
        return choice;
    }

    void installInfo(const string &version, bool hasKnownGood) override {
        update([&]() {
            version_ = version;
            hasKnownGood_ = hasKnownGood;
        });
    }

private:
    enum { kCreateTimer = 1, kLoadTimer = 2 };

    // UI thread only.
    HWND hwnd_ = nullptr;
    ICoreWebView2Controller *controller_ = nullptr;
    ICoreWebView2 *webview_ = nullptr;
    HBRUSH background_ = nullptr;
    COLORREF backgroundColor_ = 0;
    int creating_ = 0;  // 1 ready, -1 failed
    vector<wstring> pendingScripts_;

    // Shared with the work thread.
    std::mutex mutex_;
    std::condition_variable cond_;
    string phase_ = "idle", status_, reason_, version_;
    double progress_ = 0, progressTo_ = 0;
    vector<string> output_;
    bool hasKnownGood_ = false, loaded_ = false, wantVisible_ = false;
    bool startingCaptured_ = false, toured_ = false;
    Choice command_ = Choice::None;
    int captureRequests_ = 0, capturesDone_ = 0;

    // ---- work thread helpers

    void update(const std::function<void()> &change) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            change();
        }
        PostMessageW(hwnd_, WM_UI_RENDER, 0, 0);
    }

    void setVisible(bool visible) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            wantVisible_ = visible;
        }
        PostMessageW(hwnd_, WM_UI_VISIBLE, 0, 0);
    }

    void waitLoaded() {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!cond_.wait_for(lock, std::chrono::seconds(30), [&]() { return loaded_; })) LOG("ui: the page has not loaded");
    }

    static void pause(double seconds) { Sleep((DWORD)(seconds * 1000)); }

    void script(const wstring &code) { PostMessageW(hwnd_, WM_UI_SCRIPT, 0, (LPARAM) new wstring(code)); }

    // A PNG of the page (a bare name goes in --capture-dir); waits for it.
    void capture(const wstring &name) {
        if (O.captureDir.empty()) return;
        wstring path = name.find(L'\\') == wstring::npos ? O.captureDir + L"\\" + name : name;
        std::unique_lock<std::mutex> lock(mutex_);
        int id = ++captureRequests_;
        PostMessageW(hwnd_, WM_UI_CAPTURE, (WPARAM)id, (LPARAM) new wstring(path));
        if (!cond_.wait_for(lock, std::chrono::seconds(10), [&]() { return capturesDone_ >= id; }))
            LOG("ui: capture of %s timed out", utf8(path).c_str());
    }

    // Start, Try again, Return, Reinstall or closing the window. The phase
    // leaves idle/failed in the same step, so a second click isn't queued.
    Choice waitCommand() {
        Choice choice;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            cond_.wait(lock, [&]() { return command_ != Choice::None; });
            choice = command_;
            command_ = Choice::None;
            if (choice != Choice::Quit) {
                phase_ = "starting";
                status_ = choice == Choice::Return      ? "Restoring the last working version…"
                          : choice == Choice::Reinstall ? "Reinstalling Stella…"
                                                        : "Starting Stella…";
                progress_ = 0;
                progressTo_ = 0.05;
            }
        }
        PostMessageW(hwnd_, WM_UI_RENDER, 0, 0);
        return choice;
    }

    // ---- UI thread

    static LRESULT CALLBACK windowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        if (msg == WM_NCCREATE)
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)((CREATESTRUCTW *)lParam)->lpCreateParams);
        auto self = (WebUi *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        return self ? self->handle(hwnd, msg, wParam, lParam) : DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    LRESULT handle(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        switch (msg) {
        case WM_SIZE:
            if (controller_) {
                RECT rc;
                GetClientRect(hwnd, &rc);
                controller_->put_Bounds(rc);
            }
            return 0;
        case WM_DPICHANGED: {
            const RECT *r = (const RECT *)lParam;
            SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_ERASEBKGND: {
            RECT rc;
            GetClientRect(hwnd, &rc);
            FillRect((HDC)wParam, &rc, background_);
            return 1;
        }
        case WM_SETTINGCHANGE:
            if (lParam && !wcscmp((const wchar_t *)lParam, L"ImmersiveColorSet")) applyTheme();
            break;
        case WM_CLOSE:
            closeRequested();
            return 0;
        case WM_TIMER:
            KillTimer(hwnd, wParam);
            if (wParam == kCreateTimer && creating_ == 0) {
                LOG("ui: WebView2 took over 30s to start");
                creating_ = -1;
            } else if (wParam == kLoadTimer && !isLoaded()) {
                LOG("ui: the page never said it loaded; showing it anyway");
                pageLoaded();
            }
            return 0;
        case WM_UI_RENDER:
            render();
            return 0;
        case WM_UI_VISIBLE:
            applyVisibility();
            return 0;
        case WM_UI_SCRIPT: {
            std::unique_ptr<wstring> code((wstring *)lParam);
            if (isLoaded()) webview_->ExecuteScript(code->c_str(), nullptr);
            else pendingScripts_.push_back(*code);
            return 0;
        }
        case WM_UI_CAPTURE: {
            std::unique_ptr<wstring> path((wstring *)lParam);
            capturePreview((int)wParam, *path);
            return 0;
        }
        case WM_UI_ACTIVATE:
            LOG("ui: asked to show the window");
            {
                std::lock_guard<std::mutex> lock(mutex_);
                wantVisible_ = true;
            }
            applyVisibility();
            return 0;
        case WM_UI_DONE:
            if (controller_) controller_->Close();
            DestroyWindow(hwnd);
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    bool isLoaded() {
        std::lock_guard<std::mutex> lock(mutex_);
        return loaded_;
    }

    HRESULT environmentCreated(HRESULT hr, ICoreWebView2Environment *env) {
        if (creating_ != 0) return S_OK;
        if (FAILED(hr) || !env) {
            LOG("ui: WebView2 environment failed (0x%08lx)", (unsigned long)hr);
            creating_ = -1;
            return S_OK;
        }
        auto *handler = new Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            kIID_ControllerCompleted,
            [this](HRESULT hr, ICoreWebView2Controller *controller) -> HRESULT { return controllerCreated(hr, controller); });
        hr = env->CreateCoreWebView2Controller(hwnd_, handler);
        handler->Release();
        if (FAILED(hr)) {
            LOG("ui: WebView2 controller failed (0x%08lx)", (unsigned long)hr);
            creating_ = -1;
        }
        return S_OK;
    }

    HRESULT controllerCreated(HRESULT hr, ICoreWebView2Controller *controller) {
        if (FAILED(hr) || !controller) {
            LOG("ui: WebView2 controller failed (0x%08lx)", (unsigned long)hr);
            if (creating_ == 0) creating_ = -1;
            return S_OK;
        }
        if (creating_ != 0) {  // gave up waiting meanwhile
            controller->Close();
            return S_OK;
        }
        controller_ = controller;
        controller_->AddRef();
        controller_->get_CoreWebView2(&webview_);
        applyTheme();

        // A launcher window, not a browser: no context menu, dev tools, zoom,
        // status bar or browser shortcuts (F5, Ctrl+R, Ctrl+F, ...).
        ICoreWebView2Settings *settings = nullptr;
        if (SUCCEEDED(webview_->get_Settings(&settings))) {
            settings->put_AreDefaultContextMenusEnabled(FALSE);
            settings->put_AreDevToolsEnabled(FALSE);
            settings->put_IsZoomControlEnabled(FALSE);
            settings->put_IsStatusBarEnabled(FALSE);
            ICoreWebView2Settings3 *settings3 = nullptr;
            if (SUCCEEDED(settings->QueryInterface(kIID_Settings3, (void **)&settings3))) {
                settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
                settings3->Release();
            }
            settings->Release();
        }
        RECT rc;
        GetClientRect(hwnd_, &rc);
        controller_->put_Bounds(rc);

        EventRegistrationToken token;
        auto *onMessage = new Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            kIID_WebMessageReceived, [this](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
                LPWSTR text = nullptr;
                if (SUCCEEDED(args->TryGetWebMessageAsString(&text)) && text) pageMessage(utf8(text));
                CoTaskMemFree(text);
                return S_OK;
            });
        webview_->add_WebMessageReceived(onMessage, &token);
        onMessage->Release();
        // The page posts "loaded" once its fonts are ready; if that never
        // comes, show what there is shortly after the navigation.
        auto *onNavigated = new Callback<ICoreWebView2NavigationCompletedEventHandler>(
            kIID_NavigationCompleted, [this](ICoreWebView2 *, ICoreWebView2NavigationCompletedEventArgs *args) -> HRESULT {
                BOOL ok = FALSE;
                args->get_IsSuccess(&ok);
                if (!ok) {
                    COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                    args->get_WebErrorStatus(&status);
                    LOG("ui: the page failed to load (status %d)", (int)status);
                }
                SetTimer(hwnd_, kLoadTimer, 3000, nullptr);
                return S_OK;
            });
        webview_->add_NavigationCompleted(onNavigated, &token);
        onNavigated->Release();

        string page = launcherPage();
        if (page.empty() || FAILED(webview_->NavigateToString(wide(page).c_str()))) {
            LOG("ui: the launcher page could not be shown");
            creating_ = -1;
            return S_OK;
        }
        creating_ = 1;
        return S_OK;
    }

    // The title bar, the window background and the WebView's default
    // background all match the page's (#fdfdfb light, #0f0f0d dark), so
    // nothing flashes white and the caption blends in. Caption and border
    // colors need Windows 11; Windows 10 ignores them.
    void applyTheme() {
        bool dark = systemUsesDarkTheme();
        backgroundColor_ = dark ? RGB(0x0f, 0x0f, 0x0d) : RGB(0xfd, 0xfd, 0xfb);
        BOOL immersiveDark = dark;
        DwmSetWindowAttribute(hwnd_, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &immersiveDark, sizeof(immersiveDark));
        DwmSetWindowAttribute(hwnd_, 35 /* DWMWA_CAPTION_COLOR */, &backgroundColor_, sizeof(backgroundColor_));
        DwmSetWindowAttribute(hwnd_, 34 /* DWMWA_BORDER_COLOR */, &backgroundColor_, sizeof(backgroundColor_));
        if (background_) DeleteObject(background_);
        background_ = CreateSolidBrush(backgroundColor_);
        ICoreWebView2Controller2 *controller2 = nullptr;
        if (controller_ && SUCCEEDED(controller_->QueryInterface(kIID_Controller2, (void **)&controller2))) {
            COREWEBVIEW2_COLOR color = {255, GetRValue(backgroundColor_), GetGValue(backgroundColor_), GetBValue(backgroundColor_)};
            controller2->put_DefaultBackgroundColor(color);
            controller2->Release();
        }
        InvalidateRect(hwnd_, nullptr, TRUE);
    }

    void pageMessage(const string &text) {
        mj_value *json = mj_parse(text.data(), text.size());
        const char *raw = mj_get_string(json, "action");
        string action = raw ? raw : "";
        mj_free(json);
        if (action == "loaded") {
            pageLoaded();
        } else if (action == "start") {
            command(Choice::Retry, action);
        } else if (action == "return") {
            command(Choice::Return, action);
        } else if (action == "reinstall") {
            command(Choice::Reinstall, action);
        } else if (action == "shutdown") {
            bool running;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                running = phase_ == "running";
                if (running) {
                    phase_ = "stopping";
                    status_ = "Shutting down…";
                }
            }
            if (!running) return;
            LOG("ui: shut down");
            render();
            requestShutdown();
        } else if (action == "openLogs") {
            ShellExecuteW(hwnd_, L"open", P.logs().c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        } else if (action == "close") {
            PostMessageW(hwnd_, WM_CLOSE, 0, 0);
        } else if (action != "drag") {
            LOG("ui: ignored page message %s", text.substr(0, 200).c_str());
        }
    }

    // Commands only count while the work loop is idle or failed.
    void command(Choice choice, const string &action) {
        std::lock_guard<std::mutex> lock(mutex_);
        if ((phase_ != "idle" && phase_ != "failed") || command_ != Choice::None) return;
        LOG("ui: %s", action.c_str());
        command_ = choice;
        cond_.notify_all();
    }

    // The X or Alt+F4: idle or failed quits; otherwise Stella keeps running
    // and the window only hides.
    void closeRequested() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (phase_ == "idle" || phase_ == "failed") {
                LOG("ui: closed; quitting");
                command_ = Choice::Quit;
                cond_.notify_all();
                return;
            }
            wantVisible_ = false;
        }
        applyVisibility();
    }

    void pageLoaded() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (loaded_) return;
            loaded_ = true;
            cond_.notify_all();
        }
        KillTimer(hwnd_, kLoadTimer);
        LOG("ui: page loaded");
        render();
        for (auto &code : pendingScripts_) webview_->ExecuteScript(code.c_str(), nullptr);
        pendingScripts_.clear();
        applyVisibility();
    }

    // The whole state, every time.
    void render() {
        string json;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!loaded_) return;
            bool starting = phase_ == "starting";
            json = "{\"platform\":\"windows\",\"phase\":" + jsonString(phase_) + ",\"status\":" + jsonString(status_) +
                   ",\"reason\":" + jsonString(reason_) + format(",\"progress\":%.3f,\"progressTo\":%.3f",
                                                                   starting ? progress_ : 0, starting ? progressTo_ : 0) +
                   ",\"output\":[";
            for (size_t i = 0; i < output_.size(); i++) json += (i ? "," : "") + jsonString(output_[i]);
            json += string("],\"hasKnownGood\":") + (hasKnownGood_ ? "true" : "false") + ",\"version\":" + jsonString(version_) + "}";
        }
        webview_->ExecuteScript(wide("window.stellaLauncher.render(" + json + ")").c_str(), nullptr);
    }

    // Shown only once the page has rendered.
    void applyVisibility() {
        bool want, loaded;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            want = wantVisible_;
            loaded = loaded_;
        }
        if (want && loaded) {
            ShowWindow(hwnd_, IsIconic(hwnd_) ? SW_RESTORE : SW_SHOW);
            SetForegroundWindow(hwnd_);
            controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        } else if (!want && IsWindowVisible(hwnd_)) {
            ShowWindow(hwnd_, SW_HIDE);
        }
    }

    void capturePreview(int id, const wstring &path) {
        auto finish = [this, id]() {
            std::lock_guard<std::mutex> lock(mutex_);
            capturesDone_ = std::max(capturesDone_, id);
            cond_.notify_all();
        };
        mkdirs(parentDir(path));
        IStream *stream = nullptr;
        HRESULT hr = SHCreateStreamOnFileEx(path.c_str(), STGM_CREATE | STGM_WRITE, FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream);
        if (FAILED(hr)) {
            LOG("ui: could not write %s (0x%08lx)", utf8(path).c_str(), (unsigned long)hr);
            finish();
            return;
        }
        auto *done = new Callback<ICoreWebView2CapturePreviewCompletedHandler>(
            kIID_CapturePreviewCompleted, [stream, path, finish](HRESULT hr) -> HRESULT {
                stream->Release();
                if (SUCCEEDED(hr)) LOG("ui: captured %s", utf8(path).c_str());
                else LOG("ui: capture of %s failed (0x%08lx)", utf8(path).c_str(), (unsigned long)hr);
                finish();
                return S_OK;
            });
        hr = webview_->CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream, done);
        // CapturePreview takes the next frame, and a still page draws none
        // (it would capture whatever the page shows next): keep it drawing
        // for a second with an invisible change.
        webview_->ExecuteScript(L"(() => { let n = 0; const s = document.body.style;"
                                L" const t = setInterval(() => { s.opacity = ++n % 2 ? '0.999' : '';"
                                L" if (n >= 40) { clearInterval(t); s.opacity = ''; } }, 25); })()",
                                nullptr);
        done->Release();
        if (FAILED(hr)) {
            LOG("ui: capture of %s failed (0x%08lx)", utf8(path).c_str(), (unsigned long)hr);
            stream->Release();
            finish();
        }
    }
};

// A second Stella.exe for the same root: ask the running launcher to show
// its window. False when there is none (or it uses the fallback).
static bool showRunningLauncher() {
    struct Search {
        ULONG_PTR tag;
        HWND found;
    } search = {rootTag(), nullptr};
    EnumWindows(
        [](HWND hwnd, LPARAM param) -> BOOL {
            auto s = (Search *)param;
            wchar_t name[64];
            if (GetClassNameW(hwnd, name, 64) && !wcscmp(name, kWindowClass) && (ULONG_PTR)GetPropW(hwnd, kRootProperty) == s->tag) {
                s->found = hwnd;
                return FALSE;
            }
            return TRUE;
        },
        (LPARAM)&search);
    if (!search.found) return false;
    DWORD pid = 0;
    GetWindowThreadProcessId(search.found, &pid);
    AllowSetForegroundWindow(pid);
    return PostMessageW(search.found, WM_UI_ACTIVATE, 0, 0) != 0;
}

// --------------------------------------------------------------- install

// The managed git, when it is already installed.
static bool adoptGit() {
    GitTool git{P.runtimes() + L"\\git-" + wide(kGitVersion)};
    if (!exists(git.bin())) return false;
    gGit.reset(new GitTool(git));
    return true;
}

static void ensureGit() {
    if (adoptGit()) return;
    wstring root = P.runtimes() + L"\\git-" + wide(kGitVersion);
    const Asset &asset = kGitAssets[nativeArm64() ? 1 : 0];
    progress("Getting things ready…", 0.02, 0.10);
    LOG("install: downloading PortableGit %s from %s", kGitVersion, asset.url);
    mkdirs(P.runtimes());
    wstring archive = P.runtimes() + L"\\PortableGit-" + wide(kGitVersion) + L".7z.exe";
    download(asset.url, archive, asset.sha256);
    wstring staging = P.runtimes() + L"\\.git-" + wide(kGitVersion) + L".partial";
    removeTree(staging);
    // The 7-Zip self-extractor takes -o"<dir>" with the quote inside the switch.
    wstring raw = quoteArg(archive) + L" -y -o\"" + staging + L"\"";
    CmdResult r = runCmd({archive}, P.runtimes(), baseEnvironment(), P.installLog(), 15 * 60, raw);
    if (r.code != 0 || !exists(staging + L"\\cmd\\git.exe"))
        fail(format("Could not unpack git (exit %lu):\n%s", r.code, lastLines(r.err, 10).c_str()));
    DeleteFileW(archive.c_str());
    removeTree(root);
    if (!MoveFileExW(staging.c_str(), root.c_str(), 0) || !adoptGit()) fail("Could not move git into place.");
    LOG("install: git ready: %s", gGit->run({"--version"}, L"").c_str());
}

static void extractZip(const wstring &archive, const wstring &dir) {
    // tar.exe (bsdtar) ships with Windows 10 1803 and later and reads zips.
    wstring tar = envVar(L"SystemRoot") + L"\\System32\\tar.exe";
    mkdirs(dir);
    CmdResult r = runCmd({tar, L"-xf", archive, L"-C", dir}, L"", baseEnvironment(), L"", 600);
    if (r.code != 0) fail(format("Could not unpack %s: %s", utf8(archive).c_str(), trim(r.err).c_str()));
}

// Bun from the version baked into the launcher, or the one a signed tree asks
// for in packages\desktop\launcher.json:
// {"bun": {"version": "1.4.1", "assets": {"win-x64": {"url", "sha256", "member"}}}}.
static void ensureBun() {
    string key = bunPlatformKey();
    string version = kBunVersion, url, sha, member;
    for (auto &a : kBunAssets)
        if (key == a.key) { url = a.url; sha = a.sha256; member = a.member; }
    string manifest;
    if (readFile(P.app() + L"\\packages\\desktop\\launcher.json", manifest)) {
        mj_value *json = mj_parse(manifest.data(), manifest.size());
        const mj_value *bun = mj_get(json, "bun");
        const mj_value *asset = mj_get(mj_get(bun, "assets"), key.c_str());
        const char *v = mj_get_string(bun, "version");
        if (v && mj_get_string(asset, "url") && mj_get_string(asset, "sha256")) {
            version = v;
            url = mj_get_string(asset, "url");
            sha = mj_get_string(asset, "sha256");
            member = mj_get_string(asset, "member") ? mj_get_string(asset, "member") : "bun.exe";
        }
        mj_free(json);
    }

    if (!O.localBun.empty()) {
        // Offline/testing: adopt an existing Bun instead of downloading.
        CmdResult probe = runCmd({O.localBun, L"--version"}, L"", baseEnvironment(), L"", 60);
        string localVersion = trim(probe.out);
        if (probe.code != 0 || localVersion.empty()) fail(utf8(O.localBun) + " is not a working bun.");
        wstring dir = P.runtimes() + L"\\bun-" + wide(localVersion);
        wstring bin = dir + L"\\bun.exe";
        if (!exists(bin)) {
            mkdirs(dir);
            if (!CopyFileW(O.localBun.c_str(), bin.c_str(), FALSE)) fail("could not copy " + utf8(O.localBun));
            LOG("install: adopted local bun %s from %s", localVersion.c_str(), utf8(O.localBun).c_str());
        }
        gBunBin = bin;
        gBunVersion = localVersion;
        return;
    }

    wstring dir = P.runtimes() + L"\\bun-" + wide(version);
    wstring bin = dir + L"\\bun.exe";
    if (!exists(bin)) {
        if (url.empty()) fail("No Bun " + version + " for " + key + ".");
        progress("Getting things ready…", 0.30, 0.40);
        LOG("install: downloading bun %s from %s", version.c_str(), url.c_str());
        mkdirs(P.runtimes());
        wstring archive = P.runtimes() + L"\\bun-" + wide(version) + L".zip";
        download(url, archive, sha);
        wstring staging = P.runtimes() + L"\\.bun-" + wide(version) + L".partial";
        removeTree(staging);
        extractZip(archive, staging);
        wstring memberPath = staging + L"\\" + wide(member);
        std::replace(memberPath.begin(), memberPath.end(), L'/', L'\\');
        mkdirs(dir);
        DeleteFileW(bin.c_str());
        if (!MoveFileExW(memberPath.c_str(), bin.c_str(), MOVEFILE_REPLACE_EXISTING)) fail("Bun's archive has no " + member + ".");
        removeTree(staging);
        DeleteFileW(archive.c_str());
        LOG("install: bun %s ready", version.c_str());
    }
    gBunBin = bin;
    gBunVersion = version;
}

// POST <backend>/api/app-source/bootstrap → {upstream: {remote, token, expiresAt}}.
static void bootstrapAccess(string &remote, string &token) {
    wstring base = O.backend;
    while (!base.empty() && base.back() == L'/') base.pop_back();
    wstring url = base + L"/api/app-source/bootstrap";
    LOG("install: POST %s", utf8(url).c_str());
    HttpResponse r = http(url, L"POST", "{}", L"");
    if (r.status != 200) fail(format("The app source bootstrap returned HTTP %lu.", r.status));
    mj_value *json = mj_parse(r.body.data(), r.body.size());
    if (!json) fail("The app source bootstrap returned an unexpected body.");
    // Accept {remote, token} or {upstream: {remote, token}}.
    const mj_value *body = mj_get(json, "upstream");
    if (!body) body = json;
    const char *rm = mj_get_string(body, "remote"), *tk = mj_get_string(body, "token");
    if (!rm || !tk) {
        mj_free(json);
        fail("The app source bootstrap response has no remote and token.");
    }
    remote = rm;
    token = tk;
    mj_free(json);
}

// Clone into app\; staged beside it and renamed, so an interrupted install
// never leaves half a tree.
static void cloneSource() {
    progress("Downloading Stella…", 0.10, 0.30);
    wstring staging = P.root + L"\\app.partial";
    removeTree(staging);
    // LF working tree regardless of PortableGit's system autocrlf, so scripts
    // and the signed tree read the same bytes on every OS.
    vector<string> args = {"clone", "--origin", kUpstreamRemoteName, "--config", "core.autocrlf=false",
                           "--config", "core.longpaths=true"};
    vector<std::pair<wstring, wstring>> env;
    string remote;
    if (!O.source.empty()) {
        remote = O.source;
        if (!O.sourceRef.empty()) { args.push_back("--branch"); args.push_back(O.sourceRef); }
    } else {
        string token;
        bootstrapAccess(remote, token);
        args.push_back("--branch");
        args.push_back(kUpstreamBranch);
        // Through the environment: the token stays out of argv and the clone's config.
        env = {{L"GIT_CONFIG_COUNT", L"2"},
               {L"GIT_CONFIG_KEY_0", L"http.extraHeader"},
               {L"GIT_CONFIG_VALUE_0", wide("Authorization: Bearer " + token)},
               {L"GIT_CONFIG_KEY_1", L"protocol.version"},
               {L"GIT_CONFIG_VALUE_1", L"1"}};
    }
    args.push_back(remote);
    args.push_back(utf8(staging));
    LOG("install: cloning %s", remote.c_str());
    gGit->run(args, P.root, env);
    if (!MoveFileExW(staging.c_str(), P.app().c_str(), 0)) fail(format("could not move the checkout into place (error %lu)", GetLastError()));
    LOG("install: source at %s", gGit->run({"rev-parse", "HEAD"}, P.app()).c_str());
}

// Where the installed launcher lives and the shortcuts point:
// %LOCALAPPDATA%\Programs\Stella, or STELLA_LAUNCHER_INSTALL_DIR (testing).
static wstring installDir() {
    string t = trim(utf8(envVar(L"STELLA_LAUNCHER_INSTALL_DIR")));
    wstring dir = t.empty() ? knownFolder(FOLDERID_LocalAppData) + L"\\Programs\\Stella" : wide(t);
    while (dir.size() > 3 && (dir.back() == L'\\' || dir.back() == L'/')) dir.pop_back();
    return dir;
}

static wstring installedLauncher() { return installDir() + L"\\Stella.exe"; }

static bool parseVersion(const string &text, unsigned long long &out) {
    string t = trim(text);
    if (t.empty() || t.size() > 18 || t.find_first_not_of("0123456789") != string::npos) return false;
    out = strtoull(t.c_str(), nullptr, 10);
    return true;
}

// What `exe --version` says; 0 when it can't say (a launcher from before
// versions ignores the flag, finds the lock taken and exits).
static unsigned long long launcherVersionOf(const wstring &exe) {
    try {
        CmdResult r = runCmd({exe, L"--version"}, parentDir(exe), currentEnvironment(), L"", 10);
        unsigned long long version = 0;
        if (!r.timedOut && r.code == 0 && parseVersion(r.out, version)) return version;
    } catch (const LauncherError &) {
    }
    return 0;
}

// First run: copy the launcher to %LOCALAPPDATA%\Programs\Stella\Stella.exe and
// add a Start Menu shortcut with Stella's AppUserModelID, so the taskbar
// groups Electron's windows (which set the same id) under Stella's icon.
static void installSelf() {
    wstring dir = installDir();
    wstring target = installedLauncher();
    wstring self = modulePath();
    mkdirs(dir);
    unsigned long long installed = 0;
    if (_wcsicmp(self.c_str(), target.c_str()) != 0 && exists(target) &&
        (installed = launcherVersionOf(target)) > kLauncherVersion) {
        // An older download opened again doesn't undo an update.
        LOG("install: %s is %llu, newer than this %llu; leaving it", utf8(target).c_str(), installed, kLauncherVersion);
    } else if (_wcsicmp(self.c_str(), target.c_str()) != 0) {
        wstring staging = target + L".new";
        if (CopyFileW(self.c_str(), staging.c_str(), FALSE) &&
            MoveFileExW(staging.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING))
            LOG("install: copied the launcher to %s", utf8(target).c_str());
        else
            LOG("install: could not copy the launcher to %s (error %lu)", utf8(target).c_str(), GetLastError());
    }
    wstring programs = knownFolder(FOLDERID_Programs);
    if (programs.empty()) return;
    wstring link = programs + L"\\Stella.lnk";
    IShellLinkW *shell = nullptr;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, (void **)&shell))) return;
    shell->SetPath(target.c_str());
    shell->SetWorkingDirectory(dir.c_str());
    shell->SetIconLocation(target.c_str(), 0);
    shell->SetDescription(L"Stella");
    IPropertyStore *store = nullptr;
    if (SUCCEEDED(shell->QueryInterface(IID_IPropertyStore, (void **)&store))) {
        PROPVARIANT value;
        PropVariantInit(&value);
        size_t bytes = (wcslen(kAppUserModelID) + 1) * sizeof(wchar_t);
        value.vt = VT_LPWSTR;
        value.pwszVal = (LPWSTR)CoTaskMemAlloc(bytes);
        memcpy(value.pwszVal, kAppUserModelID, bytes);
        store->SetValue(PKEY_AppUserModel_ID, value);
        store->Commit();
        PropVariantClear(&value);
        store->Release();
    }
    IPersistFile *file = nullptr;
    if (SUCCEEDED(shell->QueryInterface(IID_IPersistFile, (void **)&file))) {
        if (SUCCEEDED(file->Save(link.c_str(), TRUE))) LOG("install: wrote %s", utf8(link).c_str());
        file->Release();
    }
    shell->Release();
}

// ---------------------------------------------------------------- update

// The launcher updates itself from launcher/stable/ (CI's publish uploads
// Stella.exe and SHA256SUMS, then VERSION, the build number). A background
// thread checks VERSION a minute after start and every 6 hours; a newer build
// is downloaded to Stella.exe.update, checked against SHA256SUMS, its
// Authenticode signature (FromYou, LLC) and `--version`, and renamed over the
// installed copy (a running exe can be renamed but not overwritten, so the
// installed one moves to Stella.exe.old first). It takes over at the next
// start, or when Electron exits for an app update (see handOverToUpdate).
// Failures are logged and retried at the next check.

static std::mutex gUpdateLock;                // staging and handing over
static unsigned long long gStagedVersion = 0;  // under gUpdateLock

// `sha256sum` output: "<hex>  <name>", or "<hex> *<name>" in binary mode.
static string checksumFor(const string &sums, const string &name) {
    for (auto &raw : splitLines(sums)) {
        string line = trim(raw);
        if (line.size() < 66 || line[64] != ' ') continue;
        string file = trim(line.substr(65));
        if (!file.empty() && file[0] == '*') file.erase(0, 1);
        string hash = line.substr(0, 64);
        if (file == name && hash.find_first_not_of("0123456789abcdefABCDEF") == string::npos) return hash;
    }
    return string();
}

// Authenticode: the signature must verify to a trusted root (revocation
// checked) and the signing certificate's simple name must be FromYou, LLC.
static void verifySigner(const wstring &path) {
    WINTRUST_FILE_INFO file;
    ZeroMemory(&file, sizeof(file));
    file.cbStruct = sizeof(file);
    file.pcwszFilePath = path.c_str();
    WINTRUST_DATA data;
    ZeroMemory(&data, sizeof(data));
    data.cbStruct = sizeof(data);
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &file;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    LONG status = WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &data);
    wstring signer;
    if (status == ERROR_SUCCESS) {
        CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(data.hWVTStateData);
        CRYPT_PROVIDER_SGNR *sgnr = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : nullptr;
        CRYPT_PROVIDER_CERT *cert = sgnr ? WTHelperGetProvCertFromChain(sgnr, 0) : nullptr;
        wchar_t name[256];
        if (cert && cert->pCert && CertGetNameStringW(cert->pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, name, 256) > 1)
            signer = name;
    }
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &data);
    if (status != ERROR_SUCCESS) fail(format("its signature does not verify (0x%08lx)", (unsigned long)status));
    if (signer != kUpdateSigner) fail("it is signed by \"" + utf8(signer) + "\", not " + utf8(kUpdateSigner));
}

// Make `update` the installed launcher. The installed copy (perhaps this
// very process) moves to Stella.exe.old; when that name is taken by a
// launcher still running from it, the installed copy isn't running and can
// simply be deleted.
static void stageUpdate(const wstring &update, unsigned long long version) {
    std::lock_guard<std::mutex> lock(gUpdateLock);
    wstring installed = installedLauncher(), old = installed + L".old";
    bool movedAside = false;
    if (exists(installed)) {
        movedAside = MoveFileExW(installed.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
        if (!movedAside && !DeleteFileW(installed.c_str()))
            fail(format("could not move %s aside (error %lu)", utf8(installed).c_str(), GetLastError()));
    }
    if (!MoveFileExW(update.c_str(), installed.c_str(), MOVEFILE_WRITE_THROUGH)) {
        DWORD error = GetLastError();
        if (movedAside) MoveFileExW(old.c_str(), installed.c_str(), 0);
        fail(format("could not move the update into place (error %lu)", error));
    }
    gStagedVersion = version;
    LOG("update: staged %llu at %s", version, utf8(installed).c_str());
}

static void checkForUpdate(const wstring &base, bool skipSignature) {
    LOG("update: checking %s/VERSION (this is %llu)", utf8(base).c_str(), kLauncherVersion);
    HttpResponse r = http(base + L"/VERSION", L"GET", string(), L"");
    if (r.status != 200) fail(format("VERSION returned HTTP %lu", r.status));
    unsigned long long available = 0, staged;
    if (!parseVersion(r.body, available)) fail("VERSION is not a build number: " + trim(r.body).substr(0, 40));
    {
        std::lock_guard<std::mutex> lock(gUpdateLock);
        staged = gStagedVersion;
    }
    if (available <= kLauncherVersion || available <= staged) {
        LOG("update: up to date (available %llu%s)", available, staged ? format(", staged %llu", staged).c_str() : "");
        return;
    }
    LOG("update: %llu available", available);
    r = http(base + L"/SHA256SUMS", L"GET", string(), L"");
    if (r.status != 200) fail(format("SHA256SUMS returned HTTP %lu", r.status));
    string expected = checksumFor(r.body, "Stella.exe");
    if (expected.empty()) fail("SHA256SUMS has no Stella.exe");

    wstring dir = installDir();
    mkdirs(dir);
    wstring update = installedLauncher() + L".update";
    DeleteFileW(update.c_str());
    try {
        r = http(base + L"/Stella.exe", L"GET", string(), update);
        if (r.status != 200) fail(format("Stella.exe returned HTTP %lu", r.status));
        string actual = sha256File(update);
        if (_stricmp(actual.c_str(), expected.c_str()) != 0)
            fail("Stella.exe's sha256 is " + actual + ", SHA256SUMS says " + expected);
        if (skipSignature) LOG("update: not checking the signature (STELLA_LAUNCHER_UPDATE_SKIP_SIGNATURE)");
        else verifySigner(update);
        // It must run, and be the build VERSION promised.
        CmdResult probe = runCmd({update, L"--version"}, dir, currentEnvironment(), L"", 30);
        string said = trim(probe.out);
        if (probe.timedOut || probe.code != 0 || said != format("%llu", available))
            fail(format("Stella.exe --version printed \"%s\" (exit %lu%s), not %llu", said.substr(0, 40).c_str(), probe.code,
                        probe.timedOut ? ", timed out" : "", available));
        LOG("update: verified %llu (sha256 %s%s, --version %s)", available, short12(actual).c_str(),
            skipSignature ? "" : ", signed by FromYou, LLC", said.c_str());
        stageUpdate(update, available);
    } catch (...) {
        DeleteFileW(update.c_str());
        throw;
    }
}

// Checks run on their own thread and never touch the UI or Electron. Off for
// a local build (version 0), the self-test and a test root, unless
// STELLA_LAUNCHER_UPDATE_URL names where to look.
static void startUpdateChecks() {
    wstring base = wide(trim(utf8(envVar(L"STELLA_LAUNCHER_UPDATE_URL"))));
    bool overridden = !base.empty();
    if (!overridden && (kLauncherVersion == 0 || O.selfTest || P.isolated)) {
        LOG("update: off (version %llu%s%s)", kLauncherVersion, O.selfTest ? ", self-test" : "", P.isolated ? ", test root" : "");
        return;
    }
    if (!overridden) base = kDefaultUpdateURL;
    while (!base.empty() && base.back() == L'/') base.pop_back();
    bool skipSignature = overridden && trim(utf8(envVar(L"STELLA_LAUNCHER_UPDATE_SKIP_SIGNATURE"))) == "1";
    double delay = envSeconds(L"STELLA_LAUNCHER_UPDATE_DELAY_SECONDS", 60);
    std::thread([base, skipSignature, delay]() {
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        Sleep((DWORD)(delay * 1000));
        for (;;) {
            try {
                checkForUpdate(base, skipSignature);
            } catch (const LauncherError &e) {
                LOG("update: failed: %s", e.message.c_str());
            } catch (const std::exception &e) {
                LOG("update: failed: %s", e.what());
            }
            Sleep(kUpdateIntervalMs);
        }
    }).detach();
}

// Electron exited for an app update and a newer launcher is staged: start it
// (--start, so it goes straight to Electron; --after, so it takes the
// single-instance lock only once this process is gone) and let it take over.
// False: relaunch Electron here as before.
static bool handOverToUpdate() {
    std::lock_guard<std::mutex> lock(gUpdateLock);
    if (gStagedVersion <= kLauncherVersion) return false;
    wstring exe = installedLauncher();
    vector<wstring> argv = {exe, L"--start", L"--after", std::to_wstring(GetCurrentProcessId())};
    if (O.backendArg) {
        argv.push_back(L"--backend");
        argv.push_back(O.backend);
    }
    wstring cmdline = commandLine(argv);
    wstring cwd = installDir();
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(exe.c_str(), &cmdline[0], nullptr, nullptr, FALSE, 0, nullptr, cwd.c_str(), &si, &pi)) {
        LOG("update: could not start %s (error %lu); relaunching Stella here", utf8(exe).c_str(), GetLastError());
        return false;
    }
    LOG("update: handing over to %llu (pid %lu)", gStagedVersion, pi.dwProcessId);
    AllowSetForegroundWindow(pi.dwProcessId);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

// --version: the build number on stdout (the updater's probe passes pipes;
// from a console, that console), before any UI, log or lock.
static bool printVersion() {
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    bool asked = false;
    for (int i = 1; argv && i < argc; i++)
        if (!wcscmp(argv[i], L"--version")) asked = true;
    LocalFree(argv);
    if (!asked) return false;
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if ((!out || out == INVALID_HANDLE_VALUE) && AttachConsole(ATTACH_PARENT_PROCESS)) out = GetStdHandle(STD_OUTPUT_HANDLE);
    string text = format("%llu\n", kLauncherVersion);
    DWORD n;
    if (out && out != INVALID_HANDLE_VALUE) WriteFile(out, text.data(), (DWORD)text.size(), &n, nullptr);
    return true;
}

// --after <pid>: the launcher handing over exits right after starting us;
// wait (bounded) so its single-instance lock is released.
static void waitForPreviousLauncher(DWORD pid) {
    HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!process) return;
    if (WaitForSingleObject(process, 60000) == WAIT_TIMEOUT) LOG("update: launcher %lu is still running after 60s", pid);
    else LOG("update: launcher %lu has exited", pid);
    CloseHandle(process);
}

// The copy a previous update moved aside, once nothing runs from it.
static void removeOldLauncher() {
    wstring old = installedLauncher() + L".old";
    if (exists(old) && DeleteFileW(old.c_str())) LOG("update: removed %s", utf8(old).c_str());
}

// --------------------------------------------------------------- signing

enum class Verdict { Signed, Unsigned, BadSignature, Dirty };

static vector<string> changedFiles() {
    vector<string> out;
    for (auto &line : splitLines(gGit->run({"status", "--porcelain=v1", "--untracked-files=all"}, P.app())))
        if (!line.empty()) out.push_back(line);
    return out;
}

// Before every spawn: HEAD's note must verify and the tree must be clean
// (untracked files count, because the renderer globs the source tree).
static Verdict verifyHead(vector<string> &dirty) {
    dirty = changedFiles();
    if (!dirty.empty()) return Verdict::Dirty;
    string head = gGit->run({"rev-parse", "HEAD"}, P.app());
    string tree = gGit->run({"rev-parse", "HEAD^{tree}"}, P.app());
    CmdResult note = gGit->raw({"notes", "--ref", kNotesRef, "show", head}, P.app());
    if (note.code != 0) return Verdict::Unsigned;
    return gSigner->verify(tree, note.out) ? Verdict::Signed : Verdict::BadSignature;
}

// Sign HEAD after checking it is `expected` (when given) and clean.
static string signHead(const string &expected) {
    string head = gGit->run({"rev-parse", "HEAD"}, P.app());
    if (!expected.empty() && expected != head) fail("HEAD is " + short12(head) + ", not " + short12(expected) + ".");
    vector<string> dirty = changedFiles();
    if (!dirty.empty()) fail("The checkout has uncommitted changes: " + trim(dirty[0]) + (dirty.size() > 1 ? ", ..." : "."));
    string tree = gGit->run({"rev-parse", "HEAD^{tree}"}, P.app());
    string note = gSigner->signature(tree);
    gGit->run({"notes", "--ref", kNotesRef, "add", "-f", "-m", note, head}, P.app(), kIdentityEnv);
    LOG("signing: signed %s tree %s", short12(head).c_str(), short12(tree).c_str());
    return head;
}

// --------------------------------------------------------------- prepare

// On install, after a relaunch request and after a rollback. Returns electron.exe.
// Electron keeps its own name: it decides app.isPackaged from the executable's
// name, and launcher runs are source runs (the macOS launcher keeps
// CFBundleExecutable "Electron" for the same reason). Stella's identity comes
// from the AppUserModelID shortcut instead.
static wstring prepare() {
    wstring app = P.app();
    string lockHash = sha256File(app + L"\\bun.lock");
    if (S.bunLockHash != lockHash || !exists(app + L"\\node_modules\\electron\\package.json")) {
        progress("Installing Stella…", 0.40, 0.82);
        LOG("prepare: bun install --frozen-lockfile (lock %s)", short12(lockHash).c_str());
        ULONGLONG started = GetTickCount64();
        // Dependencies only: the postinstall's asset downloads are prepare-install.mjs's job.
        Env env = baseEnvironment();
        env[L"STELLA_SKIP_BROWSER_HYDRATE"] = L"1";
        env[L"STELLA_SKIP_OFFICE_HYDRATE"] = L"1";
        CmdResult r = runCmd({gBunBin, L"install", L"--frozen-lockfile"}, app, env, P.installLog(), 30 * 60);
        if (r.timedOut) fail("bun install timed out after 30 minutes:\n" + lastLines(r.err, 20));
        if (r.code != 0) fail(format("bun install failed (exit %lu):\n", r.code) + lastLines(r.err, 20));
        LOG("prepare: bun install finished in %ds", (int)((GetTickCount64() - started) / 1000));
        S.bunLockHash = lockHash;
        S.save();
    }

    string head = gGit->run({"rev-parse", "HEAD"}, app);
    wstring script = app + L"\\packages\\desktop\\scripts\\prepare-install.mjs";
    if (S.preparedHead != head && exists(script)) {
        // Optional features (computer use, the browser, office previews): a
        // failure or timeout is logged, not fatal, and retried next launch.
        progress("Finishing setup…", 0.82, 0.94);
        LOG("prepare: prepare-install.mjs for %s", short12(head).c_str());
        double timeout = envSeconds(L"STELLA_LAUNCHER_PREPARE_TIMEOUT_SECONDS", 10 * 60);
        try {
            CmdResult r = runCmd({gBunBin, script}, app, baseEnvironment(), P.installLog(), timeout);
            if (!r.timedOut && r.code == 0) {
                S.preparedHead = head;
                S.save();
            } else if (r.timedOut) {
                LOG("prepare: prepare-install.mjs incomplete (timed out after %ds):\n%s", (int)timeout, lastLines(r.err, 10).c_str());
            } else {
                LOG("prepare: prepare-install.mjs incomplete (exit %lu):\n%s", r.code, lastLines(r.err, 10).c_str());
            }
        } catch (const LauncherError &e) {
            LOG("prepare: prepare-install.mjs could not run: %s", e.message.c_str());
        }
    }

    wstring electron = app + L"\\node_modules\\electron\\dist\\electron.exe";
    if (!exists(electron)) fail("Electron is not installed (missing " + utf8(electron) + ").");
    return electron;
}

// ------------------------------------------------------------ supervisor

// Keeps the last lines Electron wrote for the recovery screen and tees
// everything to logs\electron.log.
class OutputCapture {
public:
    explicit OutputCapture(const wstring &logFile) {
        file_ = CreateFileW(logFile.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
    }
    ~OutputCapture() {
        if (file_ != INVALID_HANDLE_VALUE) CloseHandle(file_);
    }
    void append(const char *data, size_t n) {
        DWORD w;
        if (file_ != INVALID_HANDLE_VALUE) WriteFile(file_, data, (DWORD)n, &w, nullptr);
        std::lock_guard<std::mutex> lock(mutex_);
        partial_.append(data, n);
        size_t nl;
        while ((nl = partial_.find('\n')) != string::npos) {
            string line = partial_.substr(0, nl);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            lines_.push_back(line);
            partial_.erase(0, nl + 1);
        }
        while (lines_.size() > kOutputLines) lines_.pop_front();
    }
    vector<string> lastLines() {
        std::lock_guard<std::mutex> lock(mutex_);
        vector<string> all(lines_.begin(), lines_.end());
        if (!partial_.empty()) all.push_back(partial_);
        if (all.size() > kOutputLines) all.erase(all.begin(), all.end() - kOutputLines);
        return all;
    }

private:
    HANDLE file_;
    std::mutex mutex_;
    std::deque<string> lines_;
    string partial_;
};

struct Event {
    enum Kind { Message, Exited, Timer } kind;
    string text;  // Message: the JSON line; Timer: the name
    DWORD code = 0;
};

class EventQueue {
public:
    void post(Event e) {
        std::lock_guard<std::mutex> lock(mutex_);
        items_.push_back(std::move(e));
        cond_.notify_one();
    }
    void after(double seconds, const string &name) {
        std::lock_guard<std::mutex> lock(mutex_);
        timers_.push_back({std::chrono::steady_clock::now() + std::chrono::milliseconds((long long)(seconds * 1000)), name});
        cond_.notify_one();
    }
    Event next() {
        std::unique_lock<std::mutex> lock(mutex_);
        for (;;) {
            auto now = std::chrono::steady_clock::now();
            for (auto it = timers_.begin(); it != timers_.end(); ++it) {
                if (it->first <= now) {
                    Event e{Event::Timer, it->second};
                    timers_.erase(it);
                    return e;
                }
            }
            if (!items_.empty()) {
                Event e = std::move(items_.front());
                items_.pop_front();
                return e;
            }
            if (timers_.empty()) cond_.wait(lock);
            else {
                auto soonest = std::min_element(timers_.begin(), timers_.end())->first;
                cond_.wait_until(lock, soonest);
            }
        }
    }

private:
    std::mutex mutex_;
    std::condition_variable cond_;
    std::deque<Event> items_;
    vector<std::pair<std::chrono::steady_clock::time_point, string>> timers_;
};

static wstring currentUserSid() {
    HANDLE token = nullptr;
    wstring out;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return out;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    vector<char> buf(size);
    if (GetTokenInformation(token, TokenUser, buf.data(), size, &size)) {
        LPWSTR sid = nullptr;
        if (ConvertSidToStringSidW(((TOKEN_USER *)buf.data())->User.Sid, &sid)) {
            out = sid;
            LocalFree(sid);
        }
    }
    CloseHandle(token);
    return out;
}

// One Electron process: a single-instance named pipe (only the current user
// may open it, and only the spawned process may be its client) for the
// launcher channel, stdout/stderr captured.
class ElectronProcess {
public:
    EventQueue events;
    // Shared with the reader thread, which is detached: a grandchild that
    // inherited Electron's stdout may keep the pipe open after Electron exits.
    std::shared_ptr<OutputCapture> output;

    ElectronProcess(const wstring &exe, const wstring &app, const wstring &logFile)
        : output(std::make_shared<OutputCapture>(logFile)) {
        string header = "\r\n===== launch " + isoNow() + " =====\r\n";
        output->append(header.data(), header.size());
        static std::atomic<int> counter{0};
        pipeName_ = wformat(L"\\\\.\\pipe\\stella-launcher-%lu-%llu-%d", GetCurrentProcessId(),
                           (unsigned long long)GetTickCount64(), counter++);

        SECURITY_ATTRIBUTES psa = {sizeof(psa), nullptr, FALSE};
        PSECURITY_DESCRIPTOR sd = nullptr;
        wstring sid = currentUserSid();
        if (!sid.empty() &&
            ConvertStringSecurityDescriptorToSecurityDescriptorW((L"D:P(A;;GA;;;" + sid + L")").c_str(), SDDL_REVISION_1, &sd,
                                                                 nullptr))
            psa.lpSecurityDescriptor = sd;
        pipe_ = CreateNamedPipeW(pipeName_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536,
                                 0, &psa);
        if (sd) LocalFree(sd);
        if (pipe_ == INVALID_HANDLE_VALUE) fail(format("could not create the launcher pipe (error %lu)", GetLastError()));
        writeEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);

        SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
        HANDLE outRead = nullptr, outWrite = nullptr;
        CreatePipe(&outRead, &outWrite, &sa, 0);
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
        HANDLE nul = openNul();
        PROCESS_INFORMATION pi;
        ZeroMemory(&pi, sizeof(pi));
        bool ok = createProcess(exe, commandLine({exe, app}), app, electronEnvironment(pipeName_), nul, outWrite, outWrite, 0,
                                &pi);
        DWORD error = GetLastError();
        CloseHandle(outWrite);
        CloseHandle(nul);
        if (!ok) {
            CloseHandle(outRead);
            CloseHandle(pipe_);
            fail(format("could not start %s (error %lu)", utf8(exe).c_str(), error));
        }
        CloseHandle(pi.hThread);
        process_ = pi.hProcess;
        pid_ = pi.dwProcessId;
        LOG("supervisor: spawned Electron pid %lu", pid_);

        std::thread([capture = output, outRead]() {
            char buf[16384];
            DWORD n = 0;
            while (ReadFile(outRead, buf, sizeof(buf), &n, nullptr) && n > 0) capture->append(buf, n);
            CloseHandle(outRead);
        }).detach();
        threads_.emplace_back([this]() { readChannel(); });
        threads_.emplace_back([this]() {
            WaitForSingleObject(process_, INFINITE);
            DWORD code = 0;
            GetExitCodeProcess(process_, &code);
            {
                std::lock_guard<std::mutex> lock(exitLock_);
                exited_ = true;
            }
            events.post({Event::Exited, string(), code});
        });
    }

    ~ElectronProcess() {
        SetEvent(stopEvent_);
        CancelIoEx(pipe_, nullptr);
        for (auto &t : threads_)
            if (t.joinable()) t.join();
        CloseHandle(pipe_);
        CloseHandle(writeEvent_);
        CloseHandle(stopEvent_);
        CloseHandle(process_);
    }

    void send(const string &json) {
        string line = json + "\n";
        std::lock_guard<std::mutex> lock(writeLock_);
        if (!connected_) return;
        OVERLAPPED ov;
        ZeroMemory(&ov, sizeof(ov));
        ResetEvent(writeEvent_);
        ov.hEvent = writeEvent_;
        DWORD n = 0;
        if (!WriteFile(pipe_, line.data(), (DWORD)line.size(), &n, &ov) && GetLastError() == ERROR_IO_PENDING)
            GetOverlappedResult(pipe_, &ov, &n, TRUE);
    }

    // Ask the windows to close, then force it if Electron is still up 8 s later.
    void terminate() {
        {
            std::lock_guard<std::mutex> lock(exitLock_);
            if (exited_) return;
        }
        EnumWindows(
            [](HWND hwnd, LPARAM param) -> BOOL {
                DWORD pid = 0;
                GetWindowThreadProcessId(hwnd, &pid);
                if (pid == (DWORD)param) PostMessageW(hwnd, WM_CLOSE, 0, 0);
                return TRUE;
            },
            (LPARAM)pid_);
        HANDLE process = nullptr;
        DuplicateHandle(GetCurrentProcess(), process_, GetCurrentProcess(), &process, 0, FALSE, DUPLICATE_SAME_ACCESS);
        std::thread([process]() {
            if (WaitForSingleObject(process, 8000) == WAIT_TIMEOUT) TerminateProcess(process, 1);
            CloseHandle(process);
        }).detach();
    }

    void forceKill() { TerminateProcess(process_, 1); }

private:
    wstring pipeName_;
    HANDLE pipe_ = INVALID_HANDLE_VALUE, process_ = nullptr, writeEvent_ = nullptr, stopEvent_ = nullptr;
    DWORD pid_ = 0;
    std::mutex writeLock_, exitLock_;
    bool connected_ = false, exited_ = false;
    vector<std::thread> threads_;

    static wstring wformat(const wchar_t *fmt, ...) {
        wchar_t buf[512];
        va_list ap;
        va_start(ap, fmt);
        _vsnwprintf(buf, 511, fmt, ap);
        va_end(ap);
        buf[511] = 0;
        return buf;
    }

    // Overlapped I/O that also returns when the process object is torn down.
    bool waitIo(OVERLAPPED *ov, DWORD *n) {
        HANDLE handles[2] = {ov->hEvent, stopEvent_};
        DWORD w = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
        if (w != WAIT_OBJECT_0) {
            CancelIoEx(pipe_, ov);
            GetOverlappedResult(pipe_, ov, n, TRUE);
            return false;
        }
        return GetOverlappedResult(pipe_, ov, n, FALSE) != 0;
    }

    void readChannel() {
        HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        OVERLAPPED ov;
        ZeroMemory(&ov, sizeof(ov));
        ov.hEvent = event;
        DWORD n = 0;
        bool connected = ConnectNamedPipe(pipe_, &ov) != 0;
        if (!connected) {
            DWORD error = GetLastError();
            if (error == ERROR_PIPE_CONNECTED) connected = true;
            else if (error == ERROR_IO_PENDING) connected = waitIo(&ov, &n);
        }
        ULONG client = 0;
        if (connected && GetNamedPipeClientProcessId(pipe_, &client) && client != pid_) {
            LOG("channel: refused a client that isn't Electron (pid %lu)", client);
            connected = false;
        }
        if (!connected) {
            CloseHandle(event);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(writeLock_);
            connected_ = true;
        }
        string pending;
        char buf[8192];
        for (;;) {
            ZeroMemory(&ov, sizeof(ov));
            ResetEvent(event);
            ov.hEvent = event;
            BOOL ok = ReadFile(pipe_, buf, sizeof(buf), &n, &ov);
            if (!ok) {
                if (GetLastError() != ERROR_IO_PENDING || !waitIo(&ov, &n)) break;
            }
            if (n == 0) break;
            pending.append(buf, n);
            size_t nl;
            while ((nl = pending.find('\n')) != string::npos) {
                events.post({Event::Message, pending.substr(0, nl)});
                pending.erase(0, nl + 1);
            }
        }
        {
            std::lock_guard<std::mutex> lock(writeLock_);
            connected_ = false;
        }
        CloseHandle(event);
    }
};

enum class OutcomeKind { Quit, Relaunch, Crashed, Failed };

struct Outcome {
    OutcomeKind kind;
    double sinceReady = 0;
    string detail;
    string reason;
    vector<string> output;
};

static void handleSign(const mj_value *message, ElectronProcess &process) {
    const mj_value *id = mj_get(message, "id");
    string idText = "null";
    if (id && id->type == MJ_NUMBER) {
        idText = id->number == (double)(long long)id->number ? format("%lld", (long long)id->number) : format("%.17g", id->number);
    } else if (id && id->type == MJ_STRING) {
        char *q = mj_quote(id->string);
        idText = q;
        free(q);
    }
    const char *commit = mj_get_string(message, "commit");
    try {
        string head = signHead(commit ? commit : "");
        char *q = mj_quote(head.c_str());
        process.send(format("{\"op\":\"sign-result\",\"id\":%s,\"ok\":true,\"commit\":%s}", idText.c_str(), q));
        free(q);
    } catch (const LauncherError &e) {
        LOG("signing: refused: %s", e.message.c_str());
        char *q = mj_quote(e.message.c_str());
        process.send(format("{\"op\":\"sign-result\",\"id\":%s,\"ok\":false,\"error\":%s}", idText.c_str(), q));
        free(q);
    }
}

// The running Electron's events, so the window's Shut down can reach it.
static std::mutex gSupervisedLock;
static EventQueue *gSupervised = nullptr;

struct SupervisedRegistration {
    explicit SupervisedRegistration(EventQueue *events) {
        std::lock_guard<std::mutex> lock(gSupervisedLock);
        gSupervised = events;
    }
    ~SupervisedRegistration() {
        std::lock_guard<std::mutex> lock(gSupervisedLock);
        gSupervised = nullptr;
    }
};

static void requestShutdown() {
    std::lock_guard<std::mutex> lock(gSupervisedLock);
    if (gSupervised) gSupervised->post({Event::Timer, "shutdown"});
}

static void refreshInstallInfo();

static Outcome supervise(const wstring &electron) {
    string spawnedHead;
    try { spawnedHead = gGit->run({"rev-parse", "HEAD"}, P.app()); } catch (const LauncherError &) {}
    std::unique_ptr<ElectronProcess> process;
    try {
        process.reset(new ElectronProcess(electron, P.app(), P.electronLog()));
    } catch (const LauncherError &e) {
        return {OutcomeKind::Failed, 0, string(), "Stella could not be started: " + e.message, {}};
    }
    SupervisedRegistration registration(&process->events);
    process->events.after(O.readyTimeout, "ready-timeout");

    bool ready = false;
    ULONGLONG readyAt = 0;
    string pendingReason;
    bool pending = false, quitRequested = false, announced = false;
    DWORD announcedCode = 0;
    for (;;) {
        Event event = process->events.next();
        if (event.kind == Event::Message) {
            mj_value *message = mj_parse(event.text.data(), event.text.size());
            const char *op = mj_get_string(message, "op");
            if (!message) {
                LOG("channel: ignored malformed line %s", event.text.substr(0, 200).c_str());
            } else if (op && !strcmp(op, "ready")) {
                if (!ready) {
                    ready = true;
                    readyAt = GetTickCount64();
                    LOG("supervisor: ready");
                    process->events.after(O.stableSeconds, "stable");
                    // Hides the window; in the self-test, after its running
                    // and Settings captures, so the quit timer starts after them.
                    gUi->running();
                    if (O.selfTest) process->events.after(O.hold, "self-test-quit");
                }
            } else if (op && !strcmp(op, "sign")) {
                handleSign(message, *process);
            } else if (op && !strcmp(op, "exiting")) {
                double code = 0;
                mj_get_number(message, "code", &code);
                announced = true;
                announcedCode = (DWORD)code;
                LOG("supervisor: Electron is exiting with %lu", announcedCode);
                process->events.after(10, "exit-grace");
            } else if (op && !strcmp(op, "failed")) {
                const char *reason = mj_get_string(message, "reason");
                LOG("supervisor: Electron reported failure: %s", reason ? reason : "unknown");
                if (!pending) {
                    pending = true;
                    pendingReason = string("Stella reported a problem: ") + (reason ? reason : "unknown");
                    process->terminate();
                }
            } else {
                LOG("supervisor: ignored message %s", event.text.substr(0, 200).c_str());
            }
            mj_free(message);
        } else if (event.kind == Event::Timer) {
            const string &name = event.text;
            if (name == "ready-timeout" && !ready && !pending) {
                LOG("supervisor: no ready within %ds", (int)O.readyTimeout);
                pending = true;
                pendingReason = format("Stella didn't finish starting within %d seconds.", (int)O.readyTimeout);
                process->terminate();
            } else if (name == "stable" && !pending && !spawnedHead.empty()) {
                try {
                    gGit->run({"update-ref", kKnownGoodRef, spawnedHead}, P.app());
                    LOG("supervisor: %ds stable; %s = %s", (int)O.stableSeconds, kKnownGoodRef, short12(spawnedHead).c_str());
                    refreshInstallInfo();
                } catch (const LauncherError &e) {
                    LOG("supervisor: could not mark known-good: %s", e.message.c_str());
                }
            } else if ((name == "self-test-quit" || name == "shutdown") && !quitRequested) {
                LOG("supervisor: %s asks Electron to quit", name == "shutdown" ? "Shut down" : "self-test");
                quitRequested = true;
                process->send("{\"op\":\"quit\"}");
                process->events.after(30, "quit-timeout");
            } else if (name == "quit-timeout" && !announced) {
                LOG("supervisor: Electron did not quit in time; terminating");
                process->terminate();
            } else if (name == "exit-grace") {
                LOG("supervisor: Electron's teardown is still running 10s after it announced its exit; terminating");
                process->forceKill();
            }
        } else {
            Sleep(300);  // let the output reader drain the pipe
            vector<string> output = process->output->lastLines();
            string detail = format("exit %lu", event.code);
            LOG("supervisor: Electron exited (%s)", detail.c_str());
            if (pending) return {OutcomeKind::Failed, 0, detail, pendingReason, output};
            // A hung teardown killed after the announcement counts as the announced exit.
            DWORD code = announced ? announcedCode : event.code;
            if (code == kRelaunchExitCode) return {OutcomeKind::Relaunch, 0, detail, string(), output};
            if (quitRequested && code != 0)
                return {OutcomeKind::Failed, 0, detail, "Stella didn't quit cleanly when asked (" + detail + ").", output};
            if (code == 0) {
                if (!ready && O.selfTest)
                    return {OutcomeKind::Failed, 0, detail, "Stella quit before it finished starting.", output};
                return {OutcomeKind::Quit, 0, detail, string(), output};
            }
            if (!ready)
                return {OutcomeKind::Failed, 0, detail, "Stella stopped before it finished starting (" + detail + ").", output};
            return {OutcomeKind::Crashed, (GetTickCount64() - readyAt) / 1000.0, detail, string(), output};
        }
    }
}

// --------------------------------------------------------------- recovery

static bool hasKnownGood() {
    if (!gGit || !exists(P.app())) return false;
    try {
        return gGit->raw({"rev-parse", "--verify", "--quiet", string(kKnownGoodRef) + "^{commit}"}, P.app()).code == 0;
    } catch (const LauncherError &) {
        return false;
    }
}

static void resetInstallState() {
    S = State();
    S.installedAt = isoNow();
    S.save();
}

// No known-good version yet: move the checkout aside and clone again.
static void reinstall() {
    if (exists(P.app())) {
        wstring aside = P.root + L"\\app.previous-" + std::to_wstring((long long)time(nullptr));
        if (!MoveFileExW(P.app().c_str(), aside.c_str(), 0))
            fail(format("could not move the old checkout aside (error %lu)", GetLastError()));
        LOG("recovery: moved the old checkout to %s", utf8(aside).c_str());
    }
    cloneSource();
    signHead("");
    resetInstallState();
}

// A forward commit back to the known-good tree: nothing is rewritten, so the
// fork still fast-forwards. Uncommitted edits are stashed, not lost.
static void returnToKnownGood() {
    if (!hasKnownGood()) {
        reinstall();
        return;
    }
    wstring app = P.app();
    if (!changedFiles().empty()) {
        gGit->run({"stash", "push", "--include-untracked", "-m", "Stella recovery " + isoNow()}, app, kIdentityEnv);
        LOG("recovery: stashed uncommitted changes");
    }
    string head = gGit->run({"rev-parse", "HEAD"}, app);
    string knownTree = gGit->run({"rev-parse", string(kKnownGoodRef) + "^{tree}"}, app);
    string headTree = gGit->run({"rev-parse", "HEAD^{tree}"}, app);
    if (knownTree != headTree) {
        string commit = gGit->run({"commit-tree", knownTree, "-p", head, "-m", "Return to the last working version"}, app,
                                  kIdentityEnv);
        gGit->run({"merge", "--ff-only", commit}, app);
        LOG("recovery: returned to known-good tree %s as %s", short12(knownTree).c_str(), short12(commit).c_str());
    }
    signHead("");
}

// ---------------------------------------------------------------- launcher

static int gRecoveryCount = 0;

// Settings' Version (short HEAD, "" before install) and whether there is a
// last working version to return to.
static void refreshInstallInfo() {
    string version;
    if (gGit && exists(P.app() + L"\\.git")) {
        try {
            CmdResult r = gGit->raw({"rev-parse", "--short=7", "HEAD"}, P.app());
            if (r.code == 0) version = trim(r.out);
        } catch (const LauncherError &) {
        }
    }
    gUi->installInfo(version, hasKnownGood());
}

static Choice recover(const string &reason, const vector<string> &output) {
    gRecoveryCount++;
    Recovery recovery;
    recovery.reason = reason;
    recovery.output = output;
    bool forcedExit = false;
    if (O.selfTest) {
        if (O.recoveryChoice != Choice::None && gRecoveryCount == 1) {
            recovery.automation = O.recoveryChoice;
            recovery.automationDelay = 2;
        } else {
            recovery.automation = Choice::Quit;
            recovery.automationDelay = 1.5;
            forcedExit = true;
        }
    }
    if (!O.captureDir.empty()) recovery.capturePath = O.captureDir + L"\\recovery-" + std::to_wstring(gRecoveryCount) + L".png";
    refreshInstallInfo();
    recovery.hasKnownGood = hasKnownGood();
    Choice choice = gUi->failed(recovery);
    if (forcedExit) LOG("launcher: self-test failed: %s", reason.c_str());
    return choice;
}

static string refusalMessage(Verdict verdict, const vector<string> &dirty) {
    switch (verdict) {
    case Verdict::Dirty:
        return format("Stella's files were changed outside of Stella's updates, so it won't run them (%zu changed: %s%s).",
                      dirty.size(), dirty.empty() ? "" : trim(dirty[0]).c_str(), dirty.size() > 1 ? ", ..." : "");
    case Verdict::Unsigned:
        return "This version of Stella wasn't installed through Stella's updates (it has no signature), so it won't run.";
    case Verdict::BadSignature:
        return "This version of Stella has an invalid signature, so it won't run.";
    default:
        return string();
    }
}

static void ensureTools() {
    for (auto &dir : {P.root, P.logs(), P.runtimes()}) mkdirs(dir);
    if (!gGit) ensureGit();
    if (!gSigner) gSigner.reset(new TreeSigner());
}

static wstring prepareForLaunch() {
    ensureTools();
    if (!exists(P.app() + L"\\.git")) {
        cloneSource();
        // The initial clone is signed at install.
        signHead("");
        resetInstallState();
    }
    vector<string> dirty;
    Verdict verdict = verifyHead(dirty);
    if (verdict != Verdict::Signed) {
        LOG("verify: refused (%d)", (int)verdict);
        fail(refusalMessage(verdict, dirty));
    }
    LOG("verify: HEAD signed and clean");
    refreshInstallInfo();
    ensureBun();
    return prepare();
}

static int run() {
    LOG("launcher: start version=%llu root=%s selfTest=%d pid=%lu", kLauncherVersion, utf8(P.root).c_str(), O.selfTest ? 1 : 0,
        GetCurrentProcessId());
    adoptGit();
    refreshInstallInfo();
    // Nothing starts until the user presses Start (the self-test presses it),
    // except with --start (a launcher update taking over), which goes
    // straight on with the window hidden, like a relaunch.
    Choice next = O.start ? Choice::Retry : gUi->idle();
    if (next == Choice::Quit || next == Choice::None) return 0;
    vector<ULONGLONG> crashTimes;
    for (;;) {
        bool failed = false;
        string reason;
        vector<string> output;
        try {
            if (next == Choice::Return || next == Choice::Reinstall) {
                gUi->starting(next == Choice::Return ? "Restoring the last working version…" : "Reinstalling Stella…", 0,
                              next == Choice::Return ? 0.3 : 0.1, false);
                ensureTools();
                try {
                    if (next == Choice::Return) returnToKnownGood();
                    else reinstall();
                } catch (const LauncherError &e) {
                    LOG("recovery: %s failed: %s", choiceName(next), e.message.c_str());
                }
            }
            next = Choice::Retry;
            // Relaunches and the crash restart stay hidden; the heavy steps
            // in prepareForLaunch bring the window up.
            gUi->starting("Starting Stella…", 0, 0.05, false);
            wstring electron = prepareForLaunch();
            gUi->starting("Starting Stella…", 0.94, 1, false);
            Outcome outcome = supervise(electron);
            switch (outcome.kind) {
            case OutcomeKind::Quit:
                LOG("launcher: Stella quit; exiting");
                return 0;
            case OutcomeKind::Relaunch:
                LOG("launcher: relaunch requested");
                if (handOverToUpdate()) return 0;
                continue;
            case OutcomeKind::Crashed: {
                ULONGLONG now = GetTickCount64();
                if (outcome.sinceReady < O.stableSeconds) {
                    vector<ULONGLONG> kept;
                    for (ULONGLONG t : crashTimes)
                        if (now - t < (ULONGLONG)(O.stableSeconds * 2000)) kept.push_back(t);
                    kept.push_back(now);
                    crashTimes = kept;
                }
                LOG("launcher: Stella crashed %ds after ready (%s); recent early crashes %zu", (int)outcome.sinceReady,
                    outcome.detail.c_str(), crashTimes.size());
                if (crashTimes.size() >= 2) {
                    crashTimes.clear();
                    failed = true;
                    reason = "Stella crashed twice shortly after starting (" + outcome.detail + ").";
                    output = outcome.output;
                } else {
                    continue;
                }
                break;
            }
            case OutcomeKind::Failed:
                failed = true;
                reason = outcome.reason;
                output = outcome.output;
                break;
            }
        } catch (const LauncherError &e) {
            // First line is the message; any detail (a command's output) goes to the output pane.
            failed = true;
            vector<string> lines = splitLines(e.message);
            reason = lines.empty() ? e.message : lines[0];
            for (size_t i = 1; i < lines.size(); i++) output.push_back(lines[i]);
            if (output.size() > kOutputLines) output.erase(output.begin(), output.end() - kOutputLines);
        }
        if (!failed) continue;
        LOG("launcher: failure: %s", reason.c_str());
        next = recover(reason, output);
        if (next == Choice::Quit || next == Choice::None) return 1;
    }
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    if (printVersion()) return 0;
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_STANDARD_CLASSES | ICC_PROGRESS_CLASS};
    InitCommonControlsEx(&icc);
    SetCurrentProcessExplicitAppUserModelID(kAppUserModelID);
    // Launched from a console (CI, a terminal): log there too.
    if (AttachConsole(ATTACH_PARENT_PROCESS)) gConsole = GetStdHandle(STD_ERROR_HANDLE);

    P = Paths::resolve();
    mkdirs(P.logs());
    gLogFile = CreateFileW(P.launcherLog().c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    parseOptions();
    if (O.after) waitForPreviousLauncher(O.after);
    removeOldLauncher();

    // One launcher per install root; opening Stella again shows its window.
    // A handover (--after) allows the exiting launcher a moment to let go.
    HANDLE lock = INVALID_HANDLE_VALUE;
    for (int attempt = 0;; attempt++) {
        lock = CreateFileW(P.lockFile().c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                           nullptr);
        if (lock != INVALID_HANDLE_VALUE || !O.after || attempt >= 40) break;
        Sleep(250);
    }
    if (lock == INVALID_HANDLE_VALUE) {
        if (showRunningLauncher()) {
            LOG("launcher: another launcher owns %s; showed its window", utf8(P.root).c_str());
            return 0;
        }
        LOG("launcher: another launcher owns %s; exiting", utf8(P.root).c_str());
        return O.selfTest ? 1 : 0;
    }
    S = State::load();
    if (!P.isolated && !O.selfTest) installSelf();
    startUpdateChecks();

    static WebUi web;
    static DialogUi dialogs;
    int code;
    if (web.create()) {
        gUi = &web;
        code = web.run(run);
    } else {
        gUi = &dialogs;
        code = run();
        gProgress.hide();
    }
    LOG("launcher: exit %d", code);
    return code;
}
