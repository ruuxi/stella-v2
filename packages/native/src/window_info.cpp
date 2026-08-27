#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <objidl.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <cstring>
#include <iostream>
#include <gdiplus.h>
#include <cctype>

#pragma comment(lib, "gdiplus.lib")
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

struct WindowExclusions
{
    std::vector<DWORD> pids;
    std::vector<std::string> titlePrefixes;
};

static std::string getWindowTitle(HWND hwnd);

static std::string lowerAscii(const std::string& input)
{
    std::string out = input;
    for (char& c : out)
    {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    return out;
}

static bool isPidExcluded(DWORD pid, const std::vector<DWORD>& excluded)
{
    for (DWORD value : excluded)
    {
        if (value == pid)
        {
            return true;
        }
    }
    return false;
}

static bool startsWith(const std::string& value, const std::string& prefix)
{
    return value.size() >= prefix.size()
        && value.compare(0, prefix.size(), prefix) == 0;
}

static bool isWindowExcluded(HWND hwnd, const WindowExclusions& excluded)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (isPidExcluded(pid, excluded.pids))
    {
        return true;
    }
    if (!excluded.titlePrefixes.empty())
    {
        const std::string title = lowerAscii(getWindowTitle(hwnd));
        for (const std::string& prefix : excluded.titlePrefixes)
        {
            if (!prefix.empty() && startsWith(title, prefix))
            {
                return true;
            }
        }
    }
    return false;
}

static bool isWindowCloaked(HWND hwnd)
{
    BOOL cloaked = FALSE;
    HRESULT result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    return SUCCEEDED(result) && cloaked;
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
        80,
        &copied
    );
    if (!ok || copied == 0)
    {
        return "";
    }
    title[sizeof(title) - 1] = '\0';
    return std::string(title);
}

static void parseExcludePidsArg(const char* arg, std::vector<DWORD>& excluded)
{
    const char* prefix = "--exclude-pids=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return;
    }

    const char* p = arg + prefixLen;
    while (*p)
    {
        while (*p == ',' || *p == ' ')
        {
            ++p;
        }
        if (!*p)
        {
            break;
        }

        char* end = nullptr;
        unsigned long pid = strtoul(p, &end, 10);
        if (end == p)
        {
            break;
        }
        if (pid > 0)
        {
            excluded.push_back(static_cast<DWORD>(pid));
        }
        p = end;
        while (*p && *p != ',')
        {
            ++p;
        }
    }
}

static void parseExcludeTitlePrefixesArg(const char* arg, std::vector<std::string>& excluded)
{
    const char* prefix = "--exclude-title-prefixes=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return;
    }

    const char* p = arg + prefixLen;
    while (*p)
    {
        while (*p == ',')
        {
            ++p;
        }
        if (!*p)
        {
            break;
        }

        const char* start = p;
        while (*p && *p != ',')
        {
            ++p;
        }
        std::string value(start, p - start);
        while (!value.empty() && value.front() == ' ')
        {
            value.erase(value.begin());
        }
        while (!value.empty() && value.back() == ' ')
        {
            value.pop_back();
        }
        if (!value.empty())
        {
            excluded.push_back(lowerAscii(value));
        }
    }
}

static bool parseSetBoundsArg(const char* arg, RECT& rect)
{
    const char* prefix = "--set-bounds=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return false;
    }

    const char* p = arg + prefixLen;
    long values[4] = {};
    for (int i = 0; i < 4; ++i)
    {
        char* end = nullptr;
        values[i] = strtol(p, &end, 10);
        if (end == p)
        {
            return false;
        }
        p = end;
        if (i < 3)
        {
            if (*p != ',') return false;
            ++p;
        }
    }

    if (values[2] <= 0 || values[3] <= 0)
    {
        return false;
    }

    rect.left = values[0];
    rect.top = values[1];
    rect.right = values[0] + values[2];
    rect.bottom = values[1] + values[3];
    return true;
}

static bool parseRegionArg(const char* arg, int& x, int& y, int& w, int& h)
{
    const char* prefix = "--region=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return false;
    }

    const char* p = arg + prefixLen;
    long values[4] = {};
    for (int i = 0; i < 4; ++i)
    {
        char* end = nullptr;
        values[i] = strtol(p, &end, 10);
        if (end == p)
        {
            return false;
        }
        p = end;
        if (i < 3)
        {
            if (*p != ',') return false;
            ++p;
        }
    }

    if (values[2] <= 0 || values[3] <= 0)
    {
        return false;
    }

    x = static_cast<int>(values[0]);
    y = static_cast<int>(values[1]);
    w = static_cast<int>(values[2]);
    h = static_cast<int>(values[3]);
    return true;
}

static bool parsePidArg(const char* arg, DWORD& outPid)
{
    const char* prefix = "--pid=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return false;
    }
    char* end = nullptr;
    unsigned long pid = strtoul(arg + prefixLen, &end, 10);
    if (end == arg + prefixLen || pid == 0)
    {
        return false;
    }
    outPid = static_cast<DWORD>(pid);
    return true;
}

static HWND findTopLevelWindowAtPoint(POINT pt, const WindowExclusions& excluded)
{
    for (HWND hwnd = GetTopWindow(NULL); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT))
    {
        if (!IsWindowVisible(hwnd))
        {
            continue;
        }
        if (IsIconic(hwnd) || isWindowCloaked(hwnd))
        {
            continue;
        }

        RECT rect = {};
        if (!GetWindowRect(hwnd, &rect))
        {
            continue;
        }
        if (rect.right <= rect.left || rect.bottom <= rect.top)
        {
            continue;
        }
        if (pt.x < rect.left || pt.x >= rect.right || pt.y < rect.top || pt.y >= rect.bottom)
        {
            continue;
        }

        if (isWindowExcluded(hwnd, excluded))
        {
            continue;
        }

        return hwnd;
    }

    return NULL;
}

static std::string windowInfoJsonAtPoint(POINT pt, const WindowExclusions& excluded)
{
    HWND hwnd = findTopLevelWindowAtPoint(pt, excluded);
    if (!hwnd)
    {
        return "null";
    }

    std::string title = getWindowTitle(hwnd);

    RECT rect = {};
    GetWindowRect(hwnd, &rect);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    char processName[MAX_PATH] = {};
    if (pid)
    {
        HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (hProc)
        {
            DWORD size = MAX_PATH;
            QueryFullProcessImageNameA(hProc, 0, processName, &size);
            CloseHandle(hProc);
        }
    }

    const char* exeName = processName;
    for (const char* p = processName; *p; ++p)
    {
        if (*p == '\\' || *p == '/')
            exeName = p + 1;
    }

    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;

    std::string out = "{\"title\":\"";
    out += escapeJson(title.c_str());
    out += "\",\"process\":\"";
    out += escapeJson(exeName);
    out += "\",\"pid\":";
    out += std::to_string(static_cast<unsigned long>(pid));
    out += ",\"bounds\":{\"x\":";
    out += std::to_string(static_cast<long>(rect.left));
    out += ",\"y\":";
    out += std::to_string(static_cast<long>(rect.top));
    out += ",\"width\":";
    out += std::to_string(w);
    out += ",\"height\":";
    out += std::to_string(h);
    out += "}}";
    return out;
}

static int GetPngEncoderClsid(CLSID* clsid)
{
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return -1;

    std::vector<BYTE> buf(size);
    Gdiplus::ImageCodecInfo* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    Gdiplus::GetImageEncoders(num, size, codecs);

    for (UINT i = 0; i < num; ++i)
    {
        if (wcscmp(codecs[i].MimeType, L"image/png") == 0)
        {
            *clsid = codecs[i].Clsid;
            return static_cast<int>(i);
        }
    }
    return -1;
}

static void enableDpiAwareness()
{
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (user32)
    {

        typedef BOOL(WINAPI * SetCtxFn)(HANDLE);
        SetCtxFn setCtx =
            reinterpret_cast<SetCtxFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
        if (setCtx && setCtx(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4))))
        {
            return;
        }
    }
    SetProcessDPIAware();
}

static ULONG_PTR g_gdiplusToken = 0;
static void ensureGdiplus()
{
    if (g_gdiplusToken) return;
    Gdiplus::GdiplusStartupInput input;
    Gdiplus::GdiplusStartup(&g_gdiplusToken, &input, NULL);
}

static int GetJpegEncoderClsid(CLSID* clsid)
{
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return -1;

    std::vector<BYTE> buf(size);
    Gdiplus::ImageCodecInfo* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    Gdiplus::GetImageEncoders(num, size, codecs);

    for (UINT i = 0; i < num; ++i)
    {
        if (wcscmp(codecs[i].MimeType, L"image/jpeg") == 0)
        {
            *clsid = codecs[i].Clsid;
            return static_cast<int>(i);
        }
    }
    return -1;
}

static std::string base64Encode(const BYTE* data, size_t len)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 3 <= len; i += 3)
    {
        unsigned n = (static_cast<unsigned>(data[i]) << 16) |
                     (static_cast<unsigned>(data[i + 1]) << 8) |
                     static_cast<unsigned>(data[i + 2]);
        out += tbl[(n >> 18) & 63];
        out += tbl[(n >> 12) & 63];
        out += tbl[(n >> 6) & 63];
        out += tbl[n & 63];
    }
    const size_t rem = len - i;
    if (rem == 1)
    {
        unsigned n = static_cast<unsigned>(data[i]) << 16;
        out += tbl[(n >> 18) & 63];
        out += tbl[(n >> 12) & 63];
        out += '=';
        out += '=';
    }
    else if (rem == 2)
    {
        unsigned n = (static_cast<unsigned>(data[i]) << 16) |
                     (static_cast<unsigned>(data[i + 1]) << 8);
        out += tbl[(n >> 18) & 63];
        out += tbl[(n >> 12) & 63];
        out += tbl[(n >> 6) & 63];
        out += '=';
    }
    return out;
}

static bool encodeBitmapToJpegBase64(HBITMAP hbmp, std::string& outB64, int& outW, int& outH)
{
    ensureGdiplus();
    Gdiplus::Bitmap bitmap(hbmp, NULL);
    if (bitmap.GetLastStatus() != Gdiplus::Ok) return false;
    outW = static_cast<int>(bitmap.GetWidth());
    outH = static_cast<int>(bitmap.GetHeight());

    CLSID jpegClsid;
    if (GetJpegEncoderClsid(&jpegClsid) < 0) return false;

    IStream* stream = NULL;
    if (CreateStreamOnHGlobal(NULL, TRUE, &stream) != S_OK || !stream) return false;

    ULONG quality = 80;
    Gdiplus::EncoderParameters params;
    params.Count = 1;
    params.Parameter[0].Guid = Gdiplus::EncoderQuality;
    params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
    params.Parameter[0].NumberOfValues = 1;
    params.Parameter[0].Value = &quality;

    bool ok = false;
    if (bitmap.Save(stream, &jpegClsid, &params) == Gdiplus::Ok)
    {
        STATSTG stat = {};
        if (stream->Stat(&stat, STATFLAG_NONAME) == S_OK)
        {
            const SIZE_T dataLen = static_cast<SIZE_T>(stat.cbSize.QuadPart);
            HGLOBAL hg = NULL;
            if (GetHGlobalFromStream(stream, &hg) == S_OK && hg)
            {
                BYTE* ptr = static_cast<BYTE*>(GlobalLock(hg));
                if (ptr)
                {
                    outB64 = base64Encode(ptr, dataLen);
                    GlobalUnlock(hg);
                    ok = !outB64.empty();
                }
            }
        }
    }

    stream->Release();
    return ok;
}

static bool captureRegionBase64(int x, int y, int w, int h, std::string& outB64, int& ow, int& oh)
{
    if (w <= 0 || h <= 0) return false;
    HDC hdcScreen = GetDC(NULL);
    if (!hdcScreen) return false;
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hbmp = CreateCompatibleBitmap(hdcScreen, w, h);
    HGDIOBJ hOld = SelectObject(hdcMem, hbmp);

    BOOL ok = BitBlt(hdcMem, 0, 0, w, h, hdcScreen, x, y, SRCCOPY | CAPTUREBLT);
    bool done = ok && encodeBitmapToJpegBase64(hbmp, outB64, ow, oh);

    SelectObject(hdcMem, hOld);
    DeleteObject(hbmp);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
    return done;
}

static bool isBitmapUniform(HBITMAP hbmp, int w, int h)
{
    if (w <= 0 || h <= 0) return true;
    HDC hdc = GetDC(NULL);
    if (!hdc) return false;

    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    std::vector<DWORD> row(static_cast<size_t>(w));
    DWORD first = 0;
    bool haveFirst = false;
    bool uniform = true;

    const int sampleRows = 8;
    for (int i = 0; i < sampleRows && uniform; ++i)
    {
        const int y = (h - 1) * i / (sampleRows - 1);
        if (GetDIBits(hdc, hbmp, static_cast<UINT>(y), 1, row.data(), &bmi, DIB_RGB_COLORS) != 1)
        {

            uniform = false;
            break;
        }
        for (int x = 0; x < w; ++x)
        {
            const DWORD pixel = row[static_cast<size_t>(x)] & 0x00FFFFFF;
            if (!haveFirst)
            {
                first = pixel;
                haveFirst = true;
                continue;
            }
            if (pixel != first)
            {
                uniform = false;
                break;
            }
        }
    }

    ReleaseDC(NULL, hdc);
    return uniform && haveFirst;
}

static bool captureWindowBase64(HWND hwnd, std::string& outB64, int& ow, int& oh, bool allowScreenFallback)
{
    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect)) return false;
    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) return false;

    HDC hdcScreen = GetDC(NULL);
    if (!hdcScreen) return false;
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hbmp = CreateCompatibleBitmap(hdcScreen, w, h);
    HGDIOBJ hOld = SelectObject(hdcMem, hbmp);

    BOOL ok = PrintWindow(hwnd, hdcMem, 2);
    if (!ok) ok = PrintWindow(hwnd, hdcMem, 0);

    SelectObject(hdcMem, hOld);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);

    bool done = false;
    if (ok && !isBitmapUniform(hbmp, w, h))
    {
        done = encodeBitmapToJpegBase64(hbmp, outB64, ow, oh);
    }
    DeleteObject(hbmp);

    if (!done && allowScreenFallback)
    {
        return captureRegionBase64(rect.left, rect.top, w, h, outB64, ow, oh);
    }
    return done;
}

static HWND resolveHwndAtPoint(POINT pt, const WindowExclusions& excluded)
{
    HWND hwnd = findTopLevelWindowAtPoint(pt, excluded);
    if (hwnd)
    {
        HWND root = GetAncestor(hwnd, GA_ROOT);
        if (root) hwnd = root;
        return hwnd;
    }

    hwnd = WindowFromPoint(pt);
    if (!hwnd) return NULL;
    HWND root = GetAncestor(hwnd, GA_ROOT);
    if (root) hwnd = root;
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || isWindowCloaked(hwnd)) return NULL;
    if (isWindowExcluded(hwnd, excluded)) return NULL;
    return hwnd;
}

static HWND findTopLevelWindowForPid(DWORD pid)
{
    HWND iconicFallback = NULL;
    for (HWND hwnd = GetTopWindow(NULL); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT))
    {
        DWORD windowPid = 0;
        GetWindowThreadProcessId(hwnd, &windowPid);
        if (windowPid != pid)
        {
            continue;
        }
        if (!IsWindowVisible(hwnd) || isWindowCloaked(hwnd))
        {
            continue;
        }
        if (GetAncestor(hwnd, GA_ROOTOWNER) != hwnd)
        {
            continue;
        }
        LONG exStyle = GetWindowLongA(hwnd, GWL_EXSTYLE);
        if (exStyle & WS_EX_TOOLWINDOW)
        {
            continue;
        }
        RECT rect = {};
        if (!GetWindowRect(hwnd, &rect) || rect.right <= rect.left || rect.bottom <= rect.top)
        {
            continue;
        }
        if (IsIconic(hwnd))
        {
            if (!iconicFallback) iconicFallback = hwnd;
            continue;
        }

        return hwnd;
    }
    return iconicFallback;
}

static std::string windowShotJsonForHwnd(HWND hwnd, bool allowScreenFallback)
{
    std::string b64;
    int iw = 0, ih = 0;
    if (!captureWindowBase64(hwnd, b64, iw, ih, allowScreenFallback)) return "{\"error\":\"capture failed\"}";

    std::string title = getWindowTitle(hwnd);
    RECT rect = {};
    GetWindowRect(hwnd, &rect);
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    char processName[MAX_PATH] = {};
    if (pid)
    {
        HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (hProc)
        {
            DWORD size = MAX_PATH;
            QueryFullProcessImageNameA(hProc, 0, processName, &size);
            CloseHandle(hProc);
        }
    }
    const char* exeName = processName;
    for (const char* p = processName; *p; ++p)
    {
        if (*p == '\\' || *p == '/') exeName = p + 1;
    }

    std::string out = "{\"title\":\"";
    out += escapeJson(title.c_str());
    out += "\",\"process\":\"";
    out += escapeJson(exeName);
    out += "\",\"pid\":";
    out += std::to_string(static_cast<unsigned long>(pid));
    out += ",\"bounds\":{\"x\":";
    out += std::to_string(static_cast<long>(rect.left));
    out += ",\"y\":";
    out += std::to_string(static_cast<long>(rect.top));
    out += ",\"width\":";
    out += std::to_string(rect.right - rect.left);
    out += ",\"height\":";
    out += std::to_string(rect.bottom - rect.top);
    out += "},\"image\":\"data:image/jpeg;base64,";
    out += b64;
    out += "\",\"imageWidth\":";
    out += std::to_string(iw);
    out += ",\"imageHeight\":";
    out += std::to_string(ih);
    out += "}";
    return out;
}

static std::string windowShotJsonAtPoint(POINT pt, const WindowExclusions& excluded)
{
    HWND hwnd = resolveHwndAtPoint(pt, excluded);
    if (!hwnd) return "{\"error\":\"no window at point\"}";
    return windowShotJsonForHwnd(hwnd, true);
}

static std::string windowShotJsonForPid(DWORD pid)
{
    HWND hwnd = findTopLevelWindowForPid(pid);
    if (!hwnd) return "{\"error\":\"no window for pid\"}";
    return windowShotJsonForHwnd(hwnd, false);
}

static std::string regionShotJson(int x, int y, int w, int h)
{
    std::string b64;
    int iw = 0, ih = 0;
    if (!captureRegionBase64(x, y, w, h, b64, iw, ih)) return "{\"error\":\"capture failed\"}";

    std::string out = "{\"image\":\"data:image/jpeg;base64,";
    out += b64;
    out += "\",\"imageWidth\":";
    out += std::to_string(iw);
    out += ",\"imageHeight\":";
    out += std::to_string(ih);
    out += "}";
    return out;
}

static bool captureWindowToFile(HWND hwnd, const wchar_t* filePath)
{
    RECT rect = {};
    GetWindowRect(hwnd, &rect);
    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) return false;

    HDC hdcScreen = GetDC(NULL);
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hBitmap = CreateCompatibleBitmap(hdcScreen, w, h);
    HGDIOBJ hOld = SelectObject(hdcMem, hBitmap);

    BOOL ok = PrintWindow(hwnd, hdcMem, 2);
    if (!ok)
    {

        ok = PrintWindow(hwnd, hdcMem, 0);
    }

    bool saved = false;
    if (ok)
    {
        Gdiplus::Bitmap bitmap(hBitmap, NULL);
        CLSID pngClsid;
        if (GetPngEncoderClsid(&pngClsid) >= 0)
        {
            saved = (bitmap.Save(filePath, &pngClsid, NULL) == Gdiplus::Ok);
        }
    }

    SelectObject(hdcMem, hOld);
    DeleteObject(hBitmap);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
    return saved;
}

static std::string serveHandleTokens(const std::vector<std::string>& tokens)
{
    WindowExclusions excluded;
    bool wantShot = false;
    DWORD shotPid = 0;
    long coords[2] = {0, 0};
    int coordCount = 0;

    for (const std::string& token : tokens)
    {
        if (token.empty())
        {
            continue;
        }
        const char* arg = token.c_str();

        {
            int rx = 0, ry = 0, rw = 0, rh = 0;
            if (parseRegionArg(arg, rx, ry, rw, rh))
            {
                return regionShotJson(rx, ry, rw, rh);
            }
        }

        if (strcmp(arg, "--shot") == 0)
        {
            wantShot = true;
            continue;
        }
        if (parsePidArg(arg, shotPid))
        {
            continue;
        }
        if (strncmp(arg, "--exclude-pids=", 15) == 0)
        {
            parseExcludePidsArg(arg, excluded.pids);
            continue;
        }
        if (strncmp(arg, "--exclude-title-prefixes=", 25) == 0)
        {
            parseExcludeTitlePrefixesArg(arg, excluded.titlePrefixes);
            continue;
        }
        if (coordCount < 2)
        {
            char* end = nullptr;
            long value = strtol(arg, &end, 10);
            if (end != arg)
            {
                coords[coordCount++] = value;
            }
        }
    }

    if (wantShot)
    {
        if (shotPid != 0)
        {
            return windowShotJsonForPid(shotPid);
        }
        if (coordCount != 2)
        {
            return "{\"error\":\"bad request\"}";
        }
        POINT pt;
        pt.x = coords[0];
        pt.y = coords[1];
        return windowShotJsonAtPoint(pt, excluded);
    }

    if (coordCount == 2)
    {
        POINT pt;
        pt.x = coords[0];
        pt.y = coords[1];
        return windowInfoJsonAtPoint(pt, excluded);
    }

    return "{\"error\":\"bad request\"}";
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

        const std::string json = serveHandleTokens(tokens);
        printf("%s\t%s\n", id.c_str(), json.c_str());
        fflush(stdout);
    }
    return 0;
}

int main(int argc, char* argv[])
{

    enableDpiAwareness();

    if (argc >= 2 && strcmp(argv[1], "--serve") == 0)
    {
        return runServeLoop();
    }

    for (int i = 1; i < argc; ++i)
    {
        int rx = 0, ry = 0, rw = 0, rh = 0;
        if (parseRegionArg(argv[i], rx, ry, rw, rh))
        {
            printf("%s\n", regionShotJson(rx, ry, rw, rh).c_str());
            return 0;
        }
    }

    if (argc >= 3 && strcmp(argv[1], "--shot") == 0)
    {
        DWORD shotPid = 0;
        WindowExclusions shotExcluded;
        long coords[2] = {0, 0};
        int coordCount = 0;
        for (int i = 2; i < argc; ++i)
        {
            if (parsePidArg(argv[i], shotPid))
            {
                continue;
            }
            parseExcludePidsArg(argv[i], shotExcluded.pids);
            parseExcludeTitlePrefixesArg(argv[i], shotExcluded.titlePrefixes);
            if (coordCount < 2)
            {
                char* end = nullptr;
                long value = strtol(argv[i], &end, 10);
                if (end != argv[i])
                {
                    coords[coordCount++] = value;
                }
            }
        }
        if (shotPid != 0)
        {
            printf("%s\n", windowShotJsonForPid(shotPid).c_str());
            return 0;
        }
        if (coordCount != 2)
        {
            fprintf(stderr, "Usage: window_info --shot <x> <y> | --shot --pid=<pid>\n");
            return 1;
        }
        POINT pt;
        pt.x = coords[0];
        pt.y = coords[1];
        printf("%s\n", windowShotJsonAtPoint(pt, shotExcluded).c_str());
        return 0;
    }

    if (argc < 3)
    {
        fprintf(stderr, "Usage: window_info <x> <y>\n");
        return 1;
    }

    POINT pt;
    pt.x = atol(argv[1]);
    pt.y = atol(argv[2]);

    WindowExclusions excluded;
    const char* screenshotPath = nullptr;
    RECT setBounds = {};
    bool hasSetBounds = false;

    for (int i = 3; i < argc; ++i)
    {
        parseExcludePidsArg(argv[i], excluded.pids);
        parseExcludeTitlePrefixesArg(argv[i], excluded.titlePrefixes);
        if (parseSetBoundsArg(argv[i], setBounds))
        {
            hasSetBounds = true;
        }
        const char* ssPrefix = "--screenshot=";
        size_t ssPrefixLen = strlen(ssPrefix);
        if (strncmp(argv[i], ssPrefix, ssPrefixLen) == 0)
        {
            screenshotPath = argv[i] + ssPrefixLen;
        }
    }

    ULONG_PTR gdiplusToken = 0;
    if (screenshotPath)
    {
        Gdiplus::GdiplusStartupInput gdiplusStartupInput;
        Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusStartupInput, NULL);
    }

    HWND hwnd = findTopLevelWindowAtPoint(pt, excluded);
    if (!hwnd)
    {

        hwnd = WindowFromPoint(pt);
        if (hwnd)
        {
            HWND fallbackRoot = GetAncestor(hwnd, GA_ROOT);
            if (fallbackRoot) hwnd = fallbackRoot;

            if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || isWindowCloaked(hwnd))
            {
                hwnd = NULL;
            }

            if (hwnd)
            {
                if (isWindowExcluded(hwnd, excluded))
                {
                    hwnd = NULL;
                }
            }
        }
    }
    if (!hwnd)
    {
        printf("{\"error\":\"no window at point\"}\n");
        if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
        return 0;
    }

    HWND root = GetAncestor(hwnd, GA_ROOT);
    if (root) hwnd = root;

    std::string title = getWindowTitle(hwnd);

    RECT rect = {};
    GetWindowRect(hwnd, &rect);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    char processName[MAX_PATH] = {};
    if (pid)
    {
        HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (hProc)
        {
            DWORD size = MAX_PATH;
            QueryFullProcessImageNameA(hProc, 0, processName, &size);
            CloseHandle(hProc);
        }
    }

    const char* exeName = processName;
    const char* p = processName;
    for (; *p; ++p)
    {
        if (*p == '\\' || *p == '/')
            exeName = p + 1;
    }

    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;
    bool moved = false;
    RECT outputRect = rect;

    if (hasSetBounds)
    {
        if (IsIconic(hwnd) || IsZoomed(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
        }

        int targetW = static_cast<int>(setBounds.right - setBounds.left);
        int targetH = static_cast<int>(setBounds.bottom - setBounds.top);
        moved = SetWindowPos(
            hwnd,
            NULL,
            setBounds.left,
            setBounds.top,
            targetW,
            targetH,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER
        ) != 0;
        GetWindowRect(hwnd, &outputRect);
        w = outputRect.right - outputRect.left;
        h = outputRect.bottom - outputRect.top;
    }

    printf("{\"title\":\"%s\",\"process\":\"%s\",\"pid\":%lu,\"bounds\":{\"x\":%ld,\"y\":%ld,\"width\":%d,\"height\":%d},\"moved\":%s}\n",
           escapeJson(title.c_str()).c_str(),
           escapeJson(exeName).c_str(),
           pid,
           outputRect.left, outputRect.top, w, h,
           moved ? "true" : "false");

    if (screenshotPath)
    {

        int wideLen = MultiByteToWideChar(CP_UTF8, 0, screenshotPath, -1, NULL, 0);
        std::vector<wchar_t> widePath(wideLen);
        MultiByteToWideChar(CP_UTF8, 0, screenshotPath, -1, widePath.data(), wideLen);

        captureWindowToFile(hwnd, widePath.data());
        Gdiplus::GdiplusShutdown(gdiplusToken);
    }

    return 0;
}
