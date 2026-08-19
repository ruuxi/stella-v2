!macro killStellaBrowserProcesses
  # The same bundled executable runs both Stella's daemon and Chromium's
  # native-messaging host. Chromium owns the latter and can keep it alive after
  # Stella exits, so app shutdown alone cannot guarantee that these files are
  # unlocked when an update starts replacing $INSTDIR.
  DetailPrint "Stopping Stella Browser background processes..."
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM "stella-browser.exe"' $0
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM "stella-browser-win32-x64.exe"' $0
  Sleep 250
!macroend

!macro customInit
  # Runs before electron-builder invokes the old uninstaller during an update.
  !insertmacro killStellaBrowserProcesses
!macroend

!macro customUnInstall
  # Also protect direct uninstall and the update uninstaller's atomic rename.
  !insertmacro killStellaBrowserProcesses
!macroend
