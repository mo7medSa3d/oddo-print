; ==============================================================================
; Yaseir Cloud Printing - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Yaseir Agent and Manager..."
  nsExec::Exec 'net stop YaseirAgent'
  nsExec::Exec 'sc stop YaseirAgent'
  ; Never mass-kill by image name: a per-machine installer must not terminate
  ; an unrelated process that happens to share the executable name. The
  ; YaseirAgent service is stopped explicitly below; the desktop manager is
  ; allowed to exit through the installer/runtime lifecycle rather than a
  ; broad taskkill.
  ; Legacy service cleanup for smooth upgrade (service identity is explicit):
  ; pre-migration installs registered YasserAgent and OdooPrintAgent.
  nsExec::Exec 'net stop YasserAgent'
  nsExec::Exec 'sc stop YasserAgent'
  nsExec::Exec 'net stop OdooPrintAgent'
  nsExec::Exec 'sc stop OdooPrintAgent'
!macroend


!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Yaseir Agent Windows Service..."
  ReadEnvStr $0 "PROGRAMDATA"
  IfErrors 0 +2
    StrCpy $0 "C:\ProgramData"

  IfFileExists "$INSTDIR\resources\YaseirAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\YaseirAgent.exe" -service install -config "$0\YaseirAgent\config.yaml"'
    nsExec::Exec '"$INSTDIR\resources\YaseirAgent.exe" -service start'
    Goto +3


  IfFileExists "$INSTDIR\YaseirAgent.exe" 0 +3
    nsExec::Exec '"$INSTDIR\YaseirAgent.exe" -service install -config "$0\YaseirAgent\config.yaml"'
    nsExec::Exec '"$INSTDIR\YaseirAgent.exe" -service start'
!macroend


!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping and removing Yaseir Agent Windows Service..."
  nsExec::Exec 'net stop YaseirAgent'
  nsExec::Exec 'sc stop YaseirAgent'
  ; Do not use image-name taskkill here. The service lifecycle commands below
  ; target only the named YaseirAgent Windows service.
  IfFileExists "$INSTDIR\resources\YaseirAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\YaseirAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\resources\YaseirAgent.exe" -service uninstall'
    Goto +3

  IfFileExists "$INSTDIR\YaseirAgent.exe" 0 +2
    nsExec::Exec '"$INSTDIR\YaseirAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\YaseirAgent.exe" -service uninstall'
!macroend
