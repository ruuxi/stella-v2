#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#pragma comment(lib, "dwmapi.lib")

static std::string escapeJson(const char* s)
{
    std::string out;
    for (; *s; ++s)
    {
        switch (*s)
        {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:   out += *s; break;
        }
    }
    return out;
}

static bool isWindowCloaked(HWND hwnd)
{
    BOOL cloaked = FALSE;
    HRESULT result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    return SUCCEEDED(result) && cloaked;
}

static const DWORD TITLE_TIMEOUT_MS = 20;
static const ULONGLONG ENUM_BUDGET_MS = 350;
static const size_t DEFAULT_REQUEST_LIMIT = 3;
static const size_t MIN_RAW_ENTRY_LIMIT = 3;
static const size_t MAX_RAW_ENTRY_LIMIT = 32;

static size_t clampSize(size_t value, size_t minValue, size_t maxValue)
{
    if (value < minValue) return minValue;
    if (value > maxValue) return maxValue;
    return value;
}

static size_t parseRequestedLimit(int argc, char* argv[])
{
    const char prefix[] = "--limit=";
    const size_t prefixLen = sizeof(prefix) - 1;
    for (int i = 1; i < argc; ++i)
    {
        const char* arg = argv[i];
        if (!arg || strncmp(arg, prefix, prefixLen) != 0)
        {
            continue;
        }
        char* end = nullptr;
        unsigned long parsed = strtoul(arg + prefixLen, &end, 10);
        if (end == arg + prefixLen || parsed == 0)
        {
            continue;
        }
        return clampSize(static_cast<size_t>(parsed), 1, MAX_RAW_ENTRY_LIMIT);
    }
    return DEFAULT_REQUEST_LIMIT;
}

static std::string getWindowTitle(HWND hwnd)
{
    char title[512] = {};
    DWORD_PTR copied = 0;
    LRESULT ok = SendMessageTimeoutA(
        hwnd,
        WM_GETTEXT,
        static_cast<WPARAM>(sizeof(title)),
        reinterpret_cast<LPARAM>(title),
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        TITLE_TIMEOUT_MS,
        &copied
    );
    if (!ok || copied == 0)
    {
        return "";
    }
    title[sizeof(title) - 1] = '\0';
    return std::string(title);
}

struct AppEntry
{
    DWORD pid;
    std::string name;
    std::string title;
    std::string exePath;
    bool active;
};

static std::vector<AppEntry> g_entries;
static DWORD g_foregroundPid = 0;
static ULONGLONG g_startedAt = 0;
static size_t g_rawEntryLimit = MIN_RAW_ENTRY_LIMIT;

static bool hasElapsedBudget()
{
    return g_startedAt != 0 && GetTickCount64() - g_startedAt >= ENUM_BUDGET_MS;
}

static BOOL CALLBACK enumWindowsProc(HWND hwnd, LPARAM )
{
    if (g_entries.size() >= g_rawEntryLimit || hasElapsedBudget())
    {
        return FALSE;
    }

    if (!IsWindowVisible(hwnd))
    {
        return TRUE;
    }
    if (isWindowCloaked(hwnd))
    {
        return TRUE;
    }

    if (GetAncestor(hwnd, GA_ROOTOWNER) != hwnd)
    {
        return TRUE;
    }
    LONG exStyle = GetWindowLongA(hwnd, GWL_EXSTYLE);
    if (exStyle & WS_EX_TOOLWINDOW)
    {
        return TRUE;
    }

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0)
    {
        return TRUE;
    }

    for (size_t i = 0; i < g_entries.size(); ++i)
    {
        if (g_entries[i].pid == pid)
        {
            return TRUE;
        }
    }

    char exePath[MAX_PATH] = {};
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc)
    {
        DWORD size = MAX_PATH;
        QueryFullProcessImageNameA(hProc, 0, exePath, &size);
        CloseHandle(hProc);
    }

    const char* base = exePath;
    for (const char* p = exePath; *p; ++p)
    {
        if (*p == '\\' || *p == '/')
        {
            base = p + 1;
        }
    }
    std::string name = base;
    const size_t dot = name.rfind('.');
    if (dot != std::string::npos)
    {
        name = name.substr(0, dot);
    }
    if (name.empty())
    {
        return TRUE;
    }

    std::string title;
    if (!hasElapsedBudget())
    {
        title = getWindowTitle(hwnd);
    }

    AppEntry entry;
    entry.pid = pid;
    entry.name = name;
    entry.title = title;
    entry.exePath = exePath;
    entry.active = (pid == g_foregroundPid && g_foregroundPid != 0);
    g_entries.push_back(entry);
    return g_entries.size() < g_rawEntryLimit && !hasElapsedBudget();
}

static std::string listAppsJson(size_t requestedLimit)
{
    g_entries.clear();
    g_foregroundPid = 0;
    g_rawEntryLimit = clampSize(
        requestedLimit * 3,
        MIN_RAW_ENTRY_LIMIT,
        MAX_RAW_ENTRY_LIMIT
    );
    g_startedAt = GetTickCount64();

    HWND foreground = GetForegroundWindow();
    if (foreground)
    {
        GetWindowThreadProcessId(foreground, &g_foregroundPid);
    }

    EnumWindows(enumWindowsProc, 0);

    std::string out = "[";
    for (size_t i = 0; i < g_entries.size(); ++i)
    {
        if (i)
        {
            out += ",";
        }
        const AppEntry& e = g_entries[i];
        out += "{\"ProcessName\":\"";
        out += escapeJson(e.name.c_str());
        out += "\",\"Id\":";
        out += std::to_string(static_cast<unsigned long>(e.pid));
        out += ",\"MainWindowTitle\":\"";
        out += escapeJson(e.title.c_str());
        out += "\",\"IsActive\":";
        out += (e.active ? "true" : "false");
        out += ",\"ExecutablePath\":\"";
        out += escapeJson(e.exePath.c_str());
        out += "\"}";
    }
    out += "]";
    return out;
}

static size_t parseLimitFromTokens(const std::vector<std::string>& tokens)
{
    const char prefix[] = "--limit=";
    const size_t prefixLen = sizeof(prefix) - 1;
    for (const std::string& token : tokens)
    {
        if (token.compare(0, prefixLen, prefix) != 0)
        {
            continue;
        }
        const char* start = token.c_str() + prefixLen;
        char* end = nullptr;
        unsigned long parsed = strtoul(start, &end, 10);
        if (end == start || parsed == 0)
        {
            continue;
        }
        return clampSize(static_cast<size_t>(parsed), 1, MAX_RAW_ENTRY_LIMIT);
    }
    return DEFAULT_REQUEST_LIMIT;
}

static int runServeLoop()
{
    std::string line;
    while (std::getline(std::cin, line))
    {
        if (!line.empty() && line.back() == '\r')
        {
            line.pop_back();
        }
        if (line.empty())
        {
            continue;
        }

        const size_t tab = line.find('\t');
        if (tab == std::string::npos)
        {
            continue;
        }

        const std::string id = line.substr(0, tab);
        std::vector<std::string> tokens;
        size_t start = tab + 1;
        while (true)
        {
            const size_t next = line.find('\t', start);
            if (next == std::string::npos)
            {
                tokens.push_back(line.substr(start));
                break;
            }
            tokens.push_back(line.substr(start, next - start));
            start = next + 1;
        }

        const std::string json = listAppsJson(parseLimitFromTokens(tokens));
        printf("%s\t%s\n", id.c_str(), json.c_str());
        fflush(stdout);
    }
    return 0;
}

int main(int argc, char* argv[])
{
    if (argc >= 2 && strcmp(argv[1], "--serve") == 0)
    {
        return runServeLoop();
    }

    const std::string out = listAppsJson(parseRequestedLimit(argc, argv));
    printf("%s\n", out.c_str());
    return 0;
}
