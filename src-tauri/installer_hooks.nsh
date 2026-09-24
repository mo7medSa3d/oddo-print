; ==============================================================================
; Yasser Cloud Printing - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Yasser Agent and Manager..."
  nsExec::Exec 'net stop YasserAgent'
  nsExec::Exec 'sc stop YasserAgent'
  ; Never mass-kill by image name: a per-machine installer must not terminate
  ; an unrelated process that happens to share the executable name. The
  ; YasserAgent service is stopped explicitly below; the desktop manager is
  ; allowed to exit through the installer/runtime lifecycle rather than a
  ; broad taskkill.
  ; Legacy service cleanup for smooth upgrade (service identity is explicit):
  nsExec::Exec 'net stop OdooPrintAgent'
  nsExec::Exec 'sc stop OdooPrintAgent'
!macroend


!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Yasser Agent Windows Service..."
  ReadEnvStr $0 "PROGRAMDATA"
  IfErrors 0 +2
    StrCpy $0 "C:\ProgramData"

  IfFileExists "$INSTDIR\resources\YasserAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\YasserAgent.exe" -service install -config "$0\YasserAgent\config.yaml"'
    nsExec::Exec '"$INSTDIR\resources\YasserAgent.exe" -service start'
    Goto +3


  IfFileExists "$INSTDIR\YasserAgent.exe" 0 +3
    nsExec::Exec '"$INSTDIR\YasserAgent.exe" -service install -config "$0\YasserAgent\config.yaml"'
    nsExec::Exec '"$INSTDIR\YasserAgent.exe" -service start'
!macroend


!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping and removing Yasser Agent Windows Service..."
  nsExec::Exec 'net stop YasserAgent'
  nsExec::Exec 'sc stop YasserAgent'
  ; Do not use image-name taskkill here. The service lifecycle commands below
  ; target only the named YasserAgent Windows service.
  IfFileExists "$INSTDIR\resources\YasserAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\YasserAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\resources\YasserAgent.exe" -service uninstall'
    Goto +3

  IfFileExists "$INSTDIR\YasserAgent.exe" 0 +2
    nsExec::Exec '"$INSTDIR\YasserAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\YasserAgent.exe" -service uninstall'
!macroend
