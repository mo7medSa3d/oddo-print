; ==============================================================================
; Yasser Cloud Printing - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Yasser Agent and Manager..."
  nsExec::Exec 'net stop YasserAgent'
  nsExec::Exec 'sc stop YasserAgent'
  nsExec::Exec 'taskkill /F /T /IM YasserAgent.exe'
  nsExec::Exec 'taskkill /F /T /IM yasser-manager.exe'
  ; Legacy cleanup for smooth upgrade:
  nsExec::Exec 'net stop OdooPrintAgent'
  nsExec::Exec 'sc stop OdooPrintAgent'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintAgent.exe'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintManager.exe'
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
  nsExec::Exec 'taskkill /F /T /IM yasser-manager.exe'
  nsExec::Exec 'taskkill /F /T /IM YasserAgent.exe'
  IfFileExists "$INSTDIR\resources\YasserAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\YasserAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\resources\YasserAgent.exe" -service uninstall'
    Goto +3

  IfFileExists "$INSTDIR\YasserAgent.exe" 0 +2
    nsExec::Exec '"$INSTDIR\YasserAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\YasserAgent.exe" -service uninstall'
!macroend
