#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

using namespace Gdiplus;

static const Color kBg(255, 255, 255, 255);
static const Color kText(255, 0x1d, 0x1d, 0x1f);
static const Color kTextDim(255, 0x86, 0x86, 0x8b);
static const Color kTrack(255, 0xf5, 0xf5, 0xf7);
static const Color kFillA(255, 0x54, 0xa8, 0xe0);
static const Color kFillB(255, 0x63, 0x66, 0xf1);

static const int kWindowW = 420;
static const int kWindowH = 520;
static const int kLogoSize = 112;
static const int kLogoGap = 18;
static const float kNamePx = 44.0f;
static const int kNameGap = 40;
static const float kStatusPx = 13.0f;
static const int kStatusGap = 20;
static const int kBarW = 280;
static const int kBarH = 4;
static const double kSweepPeriodMs = 1400.0;
static const double kSweepWidth = 0.4;

static const UINT kAnimTimerId = 1;
static const UINT kFadeTimerId = 2;
static const UINT WM_APP_FINISHED = WM_APP + 1;

static const DWORD kDefaultTimeoutMs = 10 * 60 * 1000;
static const DWORD kLingerAfterRelaunchMs = 1500;

struct SplashState {
  HWND hwnd = nullptr;
  Image *logo = nullptr;
  PrivateFontCollection *fonts = nullptr;
  FontFamily *nameFamily = nullptr;
  bool nameFamilyIsPrivate = false;
  ULONGLONG startTick = 0;
  int dpi = 96;
  BYTE alpha = 0;
  bool fadingIn = true;
  bool fadingOut = false;
};

struct WatchConfig {
  DWORD parentPid = 0;
  wchar_t watchExe[MAX_PATH] = L"";
  wchar_t watchDir[MAX_PATH] = L"";
  DWORD timeoutMs = kDefaultTimeoutMs;
  HWND hwnd = nullptr;
};

static SplashState g_state;

static int ScaleFor(int logical, int dpi) {
  return MulDiv(logical, dpi, 96);
}

static int WindowDpi(HWND hwnd) {
  typedef UINT(WINAPI * GetDpiForWindowFn)(HWND);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    GetDpiForWindowFn fn =
        (GetDpiForWindowFn)GetProcAddress(user32, "GetDpiForWindow");
    if (fn) {
      UINT dpi = fn(hwnd);
      if (dpi >= 96) return (int)dpi;
    }
  }
  HDC hdc = GetDC(nullptr);
  int dpi = hdc ? GetDeviceCaps(hdc, LOGPIXELSY) : 96;
  if (hdc) ReleaseDC(nullptr, hdc);
  return dpi >= 96 ? dpi : 96;
}

static void EnablePerMonitorDpi() {
  typedef BOOL(WINAPI * SetCtxFn)(HANDLE);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    SetCtxFn fn =
        (SetCtxFn)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
    if (fn) {

      if (fn((HANDLE)-4)) return;
    }
  }
  SetProcessDPIAware();
}

static void RoundWindowCorners(HWND hwnd) {

  const DWORD attr = 33;
  const int pref = 2;
  DwmSetWindowAttribute(hwnd, attr, &pref, sizeof(pref));
}

static bool PathBaseNameEquals(const wchar_t *fullPath, const wchar_t *name) {
  const wchar_t *slash = wcsrchr(fullPath, L'\\');
  const wchar_t *base = slash ? slash + 1 : fullPath;
  return _wcsicmp(base, name) == 0;
}

static bool PathDirEquals(const wchar_t *fullPath, const wchar_t *dir) {
  if (!dir[0]) return true;
  const wchar_t *slash = wcsrchr(fullPath, L'\\');
  if (!slash) return false;
  size_t dirLen = (size_t)(slash - fullPath);
  size_t wantLen = wcslen(dir);

  while (wantLen > 0 && dir[wantLen - 1] == L'\\') wantLen--;
  if (dirLen != wantLen) return false;
  return _wcsnicmp(fullPath, dir, dirLen) == 0;
}

static int CountWatchedProcesses(const WatchConfig &cfg) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  const DWORD selfPid = GetCurrentProcessId();
  int count = 0;
  PROCESSENTRY32W entry;
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == selfPid) continue;
      if (_wcsicmp(entry.szExeFile, cfg.watchExe) != 0) continue;
      if (!cfg.watchDir[0]) {
        count++;
        continue;
      }
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   entry.th32ProcessID);
      if (!process) {

        count++;
        continue;
      }
      wchar_t imagePath[MAX_PATH];
      DWORD size = MAX_PATH;
      if (QueryFullProcessImageNameW(process, 0, imagePath, &size)) {
        if (PathBaseNameEquals(imagePath, cfg.watchExe) &&
            PathDirEquals(imagePath, cfg.watchDir)) {
          count++;
        }
      } else {
        count++;
      }
      CloseHandle(process);
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return count;
}

static DWORD WINAPI WatchThread(LPVOID param) {
  WatchConfig *cfg = (WatchConfig *)param;
  const ULONGLONG deadline = GetTickCount64() + cfg->timeoutMs;
  const ULONGLONG selfStart = GetTickCount64();

  if (cfg->parentPid != 0) {
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, cfg->parentPid);
    if (parent) {
      while (GetTickCount64() < deadline) {
        if (WaitForSingleObject(parent, 500) == WAIT_OBJECT_0) break;
      }
      CloseHandle(parent);
    }
  }

  while (GetTickCount64() < deadline && CountWatchedProcesses(*cfg) > 0) {
    Sleep(300);
  }

  bool relaunched = false;
  while (GetTickCount64() < deadline) {
    if (CountWatchedProcesses(*cfg) > 0) {
      relaunched = true;
      break;
    }
    Sleep(400);
  }

  if (relaunched) {

    ULONGLONG lingerUntil = GetTickCount64() + kLingerAfterRelaunchMs;
    while (GetTickCount64() < lingerUntil && GetTickCount64() < deadline) {
      Sleep(100);
    }
  }
  (void)selfStart;

  PostMessageW(cfg->hwnd, WM_APP_FINISHED, 0, 0);
  return 0;
}

static double EaseInOut(double t) {
  return 0.5 - 0.5 * cos(t * 3.14159265358979323846);
}

static void PaintSplash(HDC hdc, int width, int height) {
  Bitmap backBuffer(width, height, PixelFormat32bppPARGB);
  Graphics g(&backBuffer);
  g.SetSmoothingMode(SmoothingModeAntiAlias);
  g.SetTextRenderingHint(TextRenderingHintAntiAlias);
  g.SetInterpolationMode(InterpolationModeHighQualityBicubic);
  g.SetPixelOffsetMode(PixelOffsetModeHighQuality);

  SolidBrush bg(kBg);
  g.FillRectangle(&bg, 0, 0, width, height);

  const int dpi = g_state.dpi;
  const int logoSize = ScaleFor(kLogoSize, dpi);
  const int logoGap = ScaleFor(kLogoGap, dpi);
  const int nameGap = ScaleFor(kNameGap, dpi);
  const int statusGap = ScaleFor(kStatusGap, dpi);
  const int barW = ScaleFor(kBarW, dpi);
  const int barH = ScaleFor(kBarH, dpi);
  const float namePx = kNamePx * dpi / 96.0f;
  const float statusPx = kStatusPx * dpi / 96.0f;

  Font *nameFont = nullptr;
  if (g_state.nameFamily && g_state.nameFamily->IsAvailable()) {
    nameFont = new Font(g_state.nameFamily, namePx, FontStyleItalic, UnitPixel);
  }
  if (!nameFont || !nameFont->IsAvailable()) {
    delete nameFont;
    nameFont = new Font(L"Georgia", namePx, FontStyleItalic, UnitPixel);
  }
  Font statusFont(L"Segoe UI", statusPx, FontStyleRegular, UnitPixel);

  StringFormat centered;
  centered.SetAlignment(StringAlignmentCenter);
  centered.SetLineAlignment(StringAlignmentNear);

  RectF layoutBounds(0.0f, 0.0f, (REAL)width, (REAL)height);
  RectF nameBounds, statusBounds;
  g.MeasureString(L"Stella", -1, nameFont, layoutBounds, &centered,
                  &nameBounds);
  g.MeasureString(L"Updating\u2026", -1, &statusFont, layoutBounds, &centered,
                  &statusBounds);

  const int nameH = (int)ceilf(nameBounds.Height);
  const int statusH = (int)ceilf(statusBounds.Height);
  const int blockH =
      logoSize + logoGap + nameH + nameGap + statusH + statusGap + barH;

  int y = (height - blockH) * 46 / 100;
  if (y < 0) y = 0;

  if (g_state.logo && g_state.logo->GetLastStatus() == Ok) {
    g.DrawImage(g_state.logo, (width - logoSize) / 2, y, logoSize, logoSize);
  }
  y += logoSize + logoGap;

  SolidBrush textBrush(kText);
  RectF nameRect(0.0f, (REAL)y, (REAL)width, (REAL)(nameH + 8));
  g.DrawString(L"Stella", -1, nameFont, nameRect, &centered, &textBrush);
  y += nameH + nameGap;

  SolidBrush dimBrush(kTextDim);
  RectF statusRect(0.0f, (REAL)y, (REAL)width, (REAL)(statusH + 8));
  g.DrawString(L"Updating\u2026", -1, &statusFont, statusRect, &centered,
               &dimBrush);
  y += statusH + statusGap;

  const int barX = (width - barW) / 2;
  const REAL radius = barH / 2.0f;
  GraphicsPath track;
  track.AddArc((REAL)barX, (REAL)y, radius * 2, radius * 2, 90.0f, 180.0f);
  track.AddArc((REAL)(barX + barW) - radius * 2, (REAL)y, radius * 2,
               radius * 2, 270.0f, 180.0f);
  track.CloseFigure();
  SolidBrush trackBrush(kTrack);
  g.FillPath(&trackBrush, &track);

  const double elapsed = (double)(GetTickCount64() - g_state.startTick);
  const double phase =
      fmod(elapsed, kSweepPeriodMs) / kSweepPeriodMs;
  const double eased = EaseInOut(phase);
  const int fillW = (int)(barW * kSweepWidth);

  const double travel = (double)fillW * 4.5;
  const int fillX = barX + (int)(-fillW + eased * travel);

  LinearGradientBrush fill(Point(fillX, 0), Point(fillX + fillW, 0), kFillA,
                           kFillB);
  Region clip(&track);
  g.SetClip(&clip);
  g.FillRectangle(&fill, fillX, y, fillW, barH);
  g.ResetClip();

  delete nameFont;

  Graphics screen(hdc);
  screen.DrawImage(&backBuffer, 0, 0);
}

static LRESULT CALLBACK SplashWndProc(HWND hwnd, UINT msg, WPARAM wParam,
                                      LPARAM lParam) {
  switch (msg) {
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC hdc = BeginPaint(hwnd, &ps);
      RECT rc;
      GetClientRect(hwnd, &rc);
      PaintSplash(hdc, rc.right - rc.left, rc.bottom - rc.top);
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_TIMER:
      if (wParam == kAnimTimerId) {

        if (g_state.fadingIn) {
          int next = g_state.alpha + 32;
          if (next >= 255) {
            next = 255;
            g_state.fadingIn = false;
          }
          g_state.alpha = (BYTE)next;
          SetLayeredWindowAttributes(hwnd, 0, g_state.alpha, LWA_ALPHA);
        }
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      if (wParam == kFadeTimerId) {
        int next = g_state.alpha - 32;
        if (next <= 0) {
          KillTimer(hwnd, kFadeTimerId);
          DestroyWindow(hwnd);
          return 0;
        }
        g_state.alpha = (BYTE)next;
        SetLayeredWindowAttributes(hwnd, 0, g_state.alpha, LWA_ALPHA);
        return 0;
      }
      return 0;
    case WM_APP_FINISHED:
      if (!g_state.fadingOut) {
        g_state.fadingOut = true;
        KillTimer(hwnd, kAnimTimerId);
        SetTimer(hwnd, kFadeTimerId, 16, nullptr);
      }
      return 0;
    case WM_NCHITTEST: {

      LRESULT hit = DefWindowProcW(hwnd, msg, wParam, lParam);
      return hit == HTCLIENT ? HTCAPTION : hit;
    }
    case WM_KEYDOWN:
      if (wParam == VK_ESCAPE) DestroyWindow(hwnd);
      return 0;
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

struct SplashArgs {
  DWORD parentPid = 0;
  DWORD timeoutMs = kDefaultTimeoutMs;
  wchar_t watchExe[MAX_PATH] = L"Stella.exe";
  wchar_t watchDir[MAX_PATH] = L"";
  wchar_t logoPath[MAX_PATH] = L"";
  wchar_t fontPath[MAX_PATH] = L"";
};

static void CopyArg(wchar_t *dest, size_t destCount, const wchar_t *src) {
  wcsncpy(dest, src, destCount - 1);
  dest[destCount - 1] = L'\0';
}

static SplashArgs ParseArgs() {
  SplashArgs args;
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return args;
  for (int i = 1; i + 1 < argc; i++) {
    if (wcscmp(argv[i], L"--parent-pid") == 0) {
      args.parentPid = (DWORD)_wtoi(argv[++i]);
    } else if (wcscmp(argv[i], L"--timeout-ms") == 0) {
      int value = _wtoi(argv[++i]);
      if (value > 0) args.timeoutMs = (DWORD)value;
    } else if (wcscmp(argv[i], L"--watch-exe") == 0) {
      CopyArg(args.watchExe, MAX_PATH, argv[++i]);
    } else if (wcscmp(argv[i], L"--watch-dir") == 0) {
      CopyArg(args.watchDir, MAX_PATH, argv[++i]);
    } else if (wcscmp(argv[i], L"--logo") == 0) {
      CopyArg(args.logoPath, MAX_PATH, argv[++i]);
    } else if (wcscmp(argv[i], L"--font") == 0) {
      CopyArg(args.fontPath, MAX_PATH, argv[++i]);
    }
  }
  LocalFree(argv);
  return args;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE, LPSTR, int) {
  EnablePerMonitorDpi();

  GdiplusStartupInput gdiplusInput;
  ULONG_PTR gdiplusToken = 0;
  if (GdiplusStartup(&gdiplusToken, &gdiplusInput, nullptr) != Ok) return 1;

  SplashArgs args = ParseArgs();

  if (args.logoPath[0]) {
    g_state.logo = new Image(args.logoPath);
    if (g_state.logo->GetLastStatus() != Ok) {
      delete g_state.logo;
      g_state.logo = nullptr;
    }
  }
  if (args.fontPath[0]) {
    g_state.fonts = new PrivateFontCollection();
    if (g_state.fonts->AddFontFile(args.fontPath) == Ok &&
        g_state.fonts->GetFamilyCount() > 0) {
      INT found = 0;
      FontFamily *families = new FontFamily[g_state.fonts->GetFamilyCount()];
      if (g_state.fonts->GetFamilies((INT)g_state.fonts->GetFamilyCount(),
                                     families, &found) == Ok &&
          found > 0) {
        g_state.nameFamily = families[0].Clone();
        g_state.nameFamilyIsPrivate = true;
      }
      delete[] families;
    }
  }

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = SplashWndProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, (LPCWSTR)IDC_ARROW);
  wc.lpszClassName = L"StellaUpdateSplash";
  if (!RegisterClassExW(&wc)) return 1;

  HDC probe = GetDC(nullptr);
  int dpi = probe ? GetDeviceCaps(probe, LOGPIXELSY) : 96;
  if (probe) ReleaseDC(nullptr, probe);
  if (dpi < 96) dpi = 96;

  RECT work = {0, 0, 1280, 800};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  const int winW = ScaleFor(kWindowW, dpi);
  const int winH = ScaleFor(kWindowH, dpi);
  const int x = work.left + ((work.right - work.left) - winW) / 2;
  const int y = work.top + ((work.bottom - work.top) - winH) / 2;

  HWND hwnd = CreateWindowExW(
      WS_EX_LAYERED | WS_EX_APPWINDOW, wc.lpszClassName, L"Stella", WS_POPUP,
      x, y, winW, winH, nullptr, nullptr, instance, nullptr);
  if (!hwnd) return 1;

  g_state.hwnd = hwnd;
  g_state.dpi = WindowDpi(hwnd);
  g_state.startTick = GetTickCount64();
  g_state.alpha = 0;
  SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA);
  RoundWindowCorners(hwnd);

  if (g_state.logo) {

    Bitmap *bitmap = static_cast<Bitmap *>(g_state.logo);
    HICON icon = nullptr;
    if (bitmap->GetHICON(&icon) == Ok && icon) {
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)icon);
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)icon);
    }
  }

  ShowWindow(hwnd, SW_SHOWNORMAL);
  SetForegroundWindow(hwnd);
  SetTimer(hwnd, kAnimTimerId, 16, nullptr);

  WatchConfig watch;
  watch.parentPid = args.parentPid;
  watch.timeoutMs = args.timeoutMs;
  watch.hwnd = hwnd;
  CopyArg(watch.watchExe, MAX_PATH, args.watchExe);
  CopyArg(watch.watchDir, MAX_PATH, args.watchDir);
  HANDLE watcher = CreateThread(nullptr, 0, WatchThread, &watch, 0, nullptr);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (watcher) {

    TerminateThread(watcher, 0);
    CloseHandle(watcher);
  }
  delete g_state.nameFamily;
  delete g_state.fonts;
  delete g_state.logo;
  GdiplusShutdown(gdiplusToken);
  return 0;
}
