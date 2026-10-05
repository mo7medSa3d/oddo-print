; ==============================================================================
; Yaseir Cloud Printing - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Yaseir Agent and Manager..."
  nsExec::Exec 'net stop YaseirAgent'
  Pop $R0
  nsExec::Exec 'sc stop YaseirAgent'
  Pop $R0
  ; Never mass-kill by image name: a per-machine installer must not terminate
  ; an unrelated process that happens to share the executable name. The
  ; YaseirAgent service is stopped explicitly below; the desktop manager is
  ; allowed to exit through the installer/runtime lifecycle rather than a
  ; broad taskkill.
  ; Legacy service cleanup for smooth upgrade (service identity is explicit):
  ; pre-migration installs registered YasserAgent and OdooPrintAgent.
  nsExec::Exec 'net stop YasserAgent'
  Pop $R0
  nsExec::Exec 'sc stop YasserAgent'
  Pop $R0
  nsExec::Exec 'sc delete YasserAgent'
  Pop $R0
  nsExec::Exec 'net stop OdooPrintAgent'
  Pop $R0
  nsExec::Exec 'sc stop OdooPrintAgent'
  Pop $R0
  nsExec::Exec 'sc delete OdooPrintAgent'
  Pop $R0
!macroend


!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Yaseir Agent Windows Service..."
  ReadEnvStr $0 "PROGRAMDATA"
  StrCmp $0 "" 0 +2
    StrCpy $0 "C:\ProgramData"

  StrCpy $1 "$INSTDIR\resources\YaseirAgent.exe"
  IfFileExists "$1" agent_resource_found 0
  StrCpy $1 "$INSTDIR\YaseirAgent.exe"
  IfFileExists "$1" agent_resource_found 0
  SetErrorLevel 1
  Abort "Agent executable is missing. Reinstall the complete signed package."

  agent_resource_found:
  ; Do not pin a fresh canonical config path here.  The Agent's
  ; DefaultConfigPath() deliberately prefers an existing canonical config,
  ; then legacy YasserAgent/OdooPrintAgent configs, preserving pairing and
  ; registry/queue continuity across branded upgrades.
  nsExec::ExecToStack '"$1" -service install'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" agent_installed 0
  DetailPrint "Agent service install failed ($R0): $R1"
  SetErrorLevel 1
  Abort "Agent service installation failed. See installer details."

  agent_installed:
  nsExec::ExecToStack '"$1" -service start'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" agent_started 0
  DetailPrint "Agent service start failed ($R0): $R1"
  SetErrorLevel 1
  Abort "Agent service startup failed. See installer details."
  agent_started:
!macroend


!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping and removing Yaseir Agent Windows Service..."
  nsExec::Exec 'net stop YaseirAgent'
  Pop $R0
  StrCpy $1 "$INSTDIR\resources\YaseirAgent.exe"
  IfFileExists "$1" agent_uninstall_found 0
  StrCpy $1 "$INSTDIR\YaseirAgent.exe"
  IfFileExists "$1" agent_uninstall_found 0
  SetErrorLevel 1
  Abort "Agent executable is missing; service removal requires repair first."
  agent_uninstall_found:
  nsExec::ExecToStack '"$1" -service uninstall'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" agent_removed 0
  DetailPrint "Agent service removal failed ($R0): $R1"
  SetErrorLevel 1
  Abort "Agent service removal failed. See installer details."
  agent_removed:
!macroend
