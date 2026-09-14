; ==============================================================================
; Odoo Print Gateway - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Odoo Print Agent and Desktop Manager..."
  nsExec::Exec 'net stop OdooPrintAgent'
  nsExec::Exec 'sc stop OdooPrintAgent'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintAgent.exe'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintManager.exe'
!macroend


!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Odoo Print Agent Windows Service..."
  ReadEnvStr $0 "PROGRAMDATA"
  IfErrors 0 +2
    StrCpy $0 "C:\ProgramData"

  IfFileExists "$INSTDIR\resources\OdooPrintAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service install -config "$0\OdooPrintAgent\config.yaml"'
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service start'
    Goto +3


  IfFileExists "$INSTDIR\OdooPrintAgent.exe" 0 +3
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service install -config "$0\OdooPrintAgent\config.yaml"'
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service start'
!macroend


!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping and removing Odoo Print Agent Windows Service..."
  nsExec::Exec 'net stop OdooPrintAgent'
  nsExec::Exec 'sc stop OdooPrintAgent'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintManager.exe'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintAgent.exe'
  IfFileExists "$INSTDIR\resources\OdooPrintAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service uninstall'
    Goto +3


  IfFileExists "$INSTDIR\OdooPrintAgent.exe" 0 +3
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service uninstall'
!macroend
