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
// WinHTTP downloads, BCrypt SHA-256 and ECDSA P-256, DPAPI for the key,
// tar.exe for zips, TaskDialogIndirect for the progress and recovery windows.

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
#include <objbase.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <propkey.h>
#include <propsys.h>
#include <wincrypt.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../common/mini_json.h"

#ifndef PW_RENDERFULLCONTENT
#define PW_RENDERFULLCONTENT 0x00000002
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
    string source;      // a local path or git URL instead of the upstream bootstrap
    string sourceRef;
    wstring backend;
    wstring localBun;   // adopt this Bun instead of downloading
    double hold = 0;    // self-test: stay up this long after ready
    Choice recoveryChoice = Choice::None;
    wstring captureDir; // save BMPs of the launcher's own windows here
    double readyTimeout = envSeconds(L"STELLA_LAUNCHER_READY_TIMEOUT_SECONDS", 90);
    double stableSeconds = envSeconds(L"STELLA_LAUNCHER_STABLE_SECONDS", 60);
};

static Options O;

static const char *kUsage =
    "usage: Stella.exe [--self-test] [--source <path|git url>] [--source-ref <ref>]\n"
    "                  [--backend <url>] [--bun <path>] [--hold <seconds>]\n"
    "                  [--recovery-choice return|retry|quit] [--capture-dir <dir>]\n"
    "\n"
    "Environment: STELLA_LAUNCHER_ROOT (install root, for testing),\n"
    "STELLA_LAUNCHER_KEY_FILE (PKCS#8 PEM instead of the DPAPI key),\n"
    "STELLA_LAUNCHER_BACKEND_URL, STELLA_LAUNCHER_STABLE_SECONDS,\n"
    "STELLA_LAUNCHER_READY_TIMEOUT_SECONDS, STELLA_LAUNCHER_PREPARE_TIMEOUT_SECONDS.\n";

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
        else if (a == L"--backend") O.backend = value();
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

static void saveWindowBitmap(HWND hwnd, const wstring &path) {
    RECT rc;
    if (!GetWindowRect(hwnd, &rc)) return;
    int w = rc.right - rc.left, h = rc.bottom - rc.top;
    if (w <= 0 || h <= 0) return;
    HDC screen = GetDC(nullptr);
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bi;
    ZeroMemory(&bi, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    void *bits = nullptr;
    HBITMAP bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    HGDIOBJ old = SelectObject(mem, bmp);
    PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT);
    GdiFlush();
    BITMAPFILEHEADER fh;
    ZeroMemory(&fh, sizeof(fh));
    DWORD imageSize = (DWORD)w * h * 4;
    fh.bfType = 0x4D42;
    fh.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    fh.bfSize = fh.bfOffBits + imageSize;
    string data((char *)&fh, sizeof(fh));
    data.append((char *)&bi.bmiHeader, sizeof(BITMAPINFOHEADER));
    data.append((char *)bits, imageSize);
    mkdirs(parentDir(path));
    if (writeFileAtomic(path, data)) LOG("ui: captured %s", utf8(path).c_str());
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
}

// The install/prepare progress panel: a marquee TaskDialog on its own thread.
class ProgressWindow {
public:
    void show(const string &status) {
        LOG("progress: %s", status.c_str());
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
    bool running_ = false, closing_ = false, captured_ = false;
    wstring status_;

    static HRESULT CALLBACK callback(HWND hwnd, UINT msg, WPARAM wParam, LPARAM, LONG_PTR ref) {
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
        case TDN_TIMER:
            if (!self->captured_ && !O.captureDir.empty() && wParam > 600) {
                self->captured_ = true;
                saveWindowBitmap(hwnd, O.captureDir + L"\\progress.bmp");
            }
            break;
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
        config.dwFlags = TDF_SHOW_MARQUEE_PROGRESS_BAR | TDF_CALLBACK_TIMER | TDF_POSITION_RELATIVE_TO_WINDOW |
                         TDF_SIZE_TO_CONTENT;
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
    Choice automation = Choice::None;
    double automationDelay = 0;
    wstring capturePath;
    bool hasKnownGood = false;
    bool captured = false, clicked = false;

    enum { kReturn = 101, kReinstall = 102, kRetry = 103, kQuit = 104 };

    static HRESULT CALLBACK callback(HWND hwnd, UINT msg, WPARAM wParam, LPARAM, LONG_PTR ref) {
        auto self = (RecoveryDialog *)ref;
        if (msg == TDN_CREATED) {
            SetForegroundWindow(hwnd);
        } else if (msg == TDN_TIMER) {
            if (!self->captured && !self->capturePath.empty() && wParam > 700) {
                self->captured = true;
                saveWindowBitmap(hwnd, self->capturePath);
            }
            if (!self->clicked && self->automation != Choice::None && wParam > self->automationDelay * 1000) {
                self->clicked = true;
                // "return" means the primary button, "Reinstall" without a known-good version.
                int id = self->automation == Choice::Return ? (self->hasKnownGood ? kReturn : kReinstall)
                         : self->automation == Choice::Retry ? kRetry
                                                             : kQuit;
                LOG("recovery: self-test clicks %s", choiceName(self->automation));
                PostMessageW(hwnd, TDM_CLICK_BUTTON, id, 0);
            }
        }
        return S_OK;
    }

    Choice present(const string &reason, const vector<string> &output) {
        string joined;
        for (size_t i = 0; i < output.size(); i++) joined += (i ? "\n" : "") + output[i];
        wstring content = wide(reason);
        wstring details = wide(output.empty() ? string("(Stella wrote no output.)") : joined);
        TASKDIALOG_BUTTON buttons[] = {
            {hasKnownGood ? kReturn : kReinstall, hasKnownGood ? L"Return to last working version" : L"Reinstall"},
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
        LOG("recovery: shown reason: %s", reason.c_str());
        int pressed = kQuit;
        if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) {
            LOG("recovery: the dialog could not be shown");
            pressed = automation == Choice::Retry ? kRetry : automation == Choice::Return ? kReturn : kQuit;
        }
        Choice choice = pressed == kReturn ? Choice::Return
                        : pressed == kReinstall ? Choice::Reinstall
                        : pressed == kRetry ? Choice::Retry
                                            : Choice::Quit;
        if (choice == Choice::Return && !hasKnownGood) choice = Choice::Reinstall;
        LOG("recovery: chose %s", choiceName(choice));
        return choice;
    }
};

// --------------------------------------------------------------- install

static void ensureGit() {
    wstring root = P.runtimes() + L"\\git-" + wide(kGitVersion);
    GitTool git{root};
    if (exists(git.bin())) {
        gGit.reset(new GitTool(git));
        return;
    }
    const Asset &asset = kGitAssets[nativeArm64() ? 1 : 0];
    gProgress.show(format("Downloading git %s…", kGitVersion));
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
    if (!MoveFileExW(staging.c_str(), root.c_str(), 0)) fail("Could not move git into place.");
    gGit.reset(new GitTool(git));
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
        gProgress.show("Downloading Bun…");
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
    gProgress.show("Downloading Stella…");
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

// First run: copy the launcher to %LOCALAPPDATA%\Programs\Stella\Stella.exe and
// add a Start Menu shortcut with Stella's AppUserModelID, so the taskbar
// groups Electron's windows (which set the same id) under Stella's icon.
static void installSelf() {
    wstring dir = knownFolder(FOLDERID_LocalAppData) + L"\\Programs\\Stella";
    wstring target = dir + L"\\Stella.exe";
    wstring self = modulePath();
    mkdirs(dir);
    if (_wcsicmp(self.c_str(), target.c_str()) != 0) {
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
        gProgress.show("Installing Stella's dependencies…");
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
        gProgress.show("Preparing Stella…");
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

static Outcome supervise(const wstring &electron) {
    string spawnedHead;
    try { spawnedHead = gGit->run({"rev-parse", "HEAD"}, P.app()); } catch (const LauncherError &) {}
    std::unique_ptr<ElectronProcess> process;
    try {
        process.reset(new ElectronProcess(electron, P.app(), P.electronLog()));
    } catch (const LauncherError &e) {
        return {OutcomeKind::Failed, 0, string(), "Stella could not be started: " + e.message, {}};
    }
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
                } catch (const LauncherError &e) {
                    LOG("supervisor: could not mark known-good: %s", e.message.c_str());
                }
            } else if (name == "self-test-quit") {
                LOG("supervisor: self-test asks Electron to quit");
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

static Choice recover(const string &reason, const vector<string> &output) {
    gRecoveryCount++;
    RecoveryDialog dialog;
    bool forcedExit = false;
    if (O.selfTest) {
        if (O.recoveryChoice != Choice::None && gRecoveryCount == 1) {
            dialog.automation = O.recoveryChoice;
            dialog.automationDelay = 2;
        } else {
            dialog.automation = Choice::Quit;
            dialog.automationDelay = 1.5;
            forcedExit = true;
        }
    }
    if (!O.captureDir.empty()) dialog.capturePath = O.captureDir + L"\\recovery-" + std::to_wstring(gRecoveryCount) + L".bmp";
    dialog.hasKnownGood = hasKnownGood();
    Choice choice = dialog.present(reason, output);
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

static wstring prepareForLaunch() {
    for (auto &dir : {P.root, P.logs(), P.runtimes()}) mkdirs(dir);
    if (!gGit) ensureGit();
    if (!gSigner) gSigner.reset(new TreeSigner());
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
    ensureBun();
    return prepare();
}

static int run() {
    LOG("launcher: start root=%s selfTest=%d pid=%lu", utf8(P.root).c_str(), O.selfTest ? 1 : 0, GetCurrentProcessId());
    vector<ULONGLONG> crashTimes;
    for (;;) {
        bool failed = false;
        string reason;
        vector<string> output;
        try {
            wstring electron = prepareForLaunch();
            gProgress.hide();
            Outcome outcome = supervise(electron);
            switch (outcome.kind) {
            case OutcomeKind::Quit:
                LOG("launcher: Stella quit; exiting");
                return 0;
            case OutcomeKind::Relaunch:
                LOG("launcher: relaunch requested");
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
        gProgress.hide();
        LOG("launcher: failure: %s", reason.c_str());
        switch (recover(reason, output)) {
        case Choice::Quit:
        case Choice::None:
            return 1;
        case Choice::Retry:
            continue;
        case Choice::Return:
            try { returnToKnownGood(); } catch (const LauncherError &e) { LOG("recovery: return failed: %s", e.message.c_str()); }
            break;
        case Choice::Reinstall:
            try { reinstall(); } catch (const LauncherError &e) { LOG("recovery: reinstall failed: %s", e.message.c_str()); }
            break;
        }
    }
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
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

    // One launcher per install root.
    HANDLE lock = CreateFileW(P.lockFile().c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (lock == INVALID_HANDLE_VALUE) {
        LOG("launcher: another launcher owns %s; exiting", utf8(P.root).c_str());
        return O.selfTest ? 1 : 0;
    }
    S = State::load();
    if (!P.isolated && !O.selfTest) installSelf();

    int code = run();
    LOG("launcher: exit %d", code);
    gProgress.hide();
    return code;
}
