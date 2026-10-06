; ==============================================================================
; Yaseir Cloud Printing - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================
;
; Privileged-execution rule: every system utility below is invoked through
; $SYSDIR (NSIS resolves it from the OS system directory, never from an
; inherited SystemRoot/WINDIR/PATH). Bare `net` / `sc` / `taskkill` names
; would inherit executable search and are forbidden here.
;
; Service-stop rule: stops are VERIFIED (sc query must report STOPPED, or the
; service must be absent) before binaries are replaced or removed. A failed
; stop aborts visibly instead of racing a running service.
;
; Process-identity rule: taskkill targets only product-owned image names
; (current plus legacy branded names from earlier packages) and runs only
; AFTER the SCM-owned services were stopped and verified. No wildcard or
; foreign image name may be added here.

!include "StrFunc.nsh"
${StrStr}
${UnStrStr}

; --- Installer-side stop-and-verify -------------------------------------------
!macro YASEIR_STOP_SERVICE_VERIFY name tag
  nsExec::ExecToStack '"$SYSDIR\sc.exe" stop "${name}"'
  Pop $R0
  Pop $R1
  StrCpy $R3 0
  yaseir_stop_poll_${tag}:
    IntCmp $R3 10 yaseir_stop_check_${tag} yaseir_stop_wait_${tag} yaseir_stop_check_${tag}
  yaseir_stop_wait_${tag}:
    Sleep 1000
    IntOp $R3 $R3 + 1
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query "${name}"'
    Pop $R0
    Pop $R1
    ${StrStr} $R2 $R1 "1060"
    StrCmp $R2 "" +2 0
      Goto yaseir_stop_done_${tag}
    ${StrStr} $R2 $R1 "STOPPED"
    StrCmp $R2 "" 0 yaseir_stop_done_${tag}
    Goto yaseir_stop_poll_${tag}
  yaseir_stop_check_${tag}:
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query "${name}"'
    Pop $R0
    Pop $R1
    ${StrStr} $R2 $R1 "1060"
    StrCmp $R2 "" +2 0
      Goto yaseir_stop_done_${tag}
    ${StrStr} $R2 $R1 "STOPPED"
    StrCmp $R2 "" 0 yaseir_stop_done_${tag}
    DetailPrint "Service ${name} did not stop; aborting before replacing binaries."
    SetErrorLevel 1
    Abort "Service ${name} is still running. Stop it manually and rerun the installer."
  yaseir_stop_done_${tag}:
!macroend

; --- Uninstaller-side stop-and-verify (uninstaller StrStr variant) ------------
!macro YASEIR_UN_STOP_SERVICE_VERIFY name tag
  nsExec::Exec '"$SYSDIR\sc.exe" stop "${name}"'
  Pop $R0
  StrCpy $R3 0
  yaseir_unstop_poll_${tag}:
    IntCmp $R3 10 yaseir_unstop_check_${tag} yaseir_unstop_wait_${tag} yaseir_unstop_check_${tag}
  yaseir_unstop_wait_${tag}:
    Sleep 1000
    IntOp $R3 $R3 + 1
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query "${name}"'
    Pop $R0
    Pop $R1
    ${UnStrStr} $R2 $R1 "1060"
    StrCmp $R2 "" +2 0
      Goto yaseir_unstop_done_${tag}
    ${UnStrStr} $R2 $R1 "STOPPED"
    StrCmp $R2 "" 0 yaseir_unstop_done_${tag}
    Goto yaseir_unstop_poll_${tag}
  yaseir_unstop_check_${tag}:
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query "${name}"'
    Pop $R0
    Pop $R1
    ${UnStrStr} $R2 $R1 "1060"
    StrCmp $R2 "" +2 0
      Goto yaseir_unstop_done_${tag}
    ${UnStrStr} $R2 $R1 "STOPPED"
    StrCmp $R2 "" 0 yaseir_unstop_done_${tag}
    DetailPrint "Service ${name} did not stop; refusing to remove files under a running service."
    SetErrorLevel 1
    Abort "Service ${name} is still running. Stop it manually and rerun the uninstaller."
  yaseir_unstop_done_${tag}:
!macroend


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Yaseir Agent and Manager..."
  !insertmacro YASEIR_STOP_SERVICE_VERIFY "YaseirAgent" "pre_yaseir"
  ; Legacy service cleanup for smooth upgrade (service identity is explicit):
  ; pre-migration installs registered YasserAgent and OdooPrintAgent.
  !insertmacro YASEIR_STOP_SERVICE_VERIFY "YasserAgent" "pre_yasser"
  nsExec::Exec '"$SYSDIR\sc.exe" delete YasserAgent'
  Pop $R0
  !insertmacro YASEIR_STOP_SERVICE_VERIFY "OdooPrintAgent" "pre_odoo"
  nsExec::Exec '"$SYSDIR\sc.exe" delete OdooPrintAgent'
  Pop $R0
  ; Never mass-kill by image name during install: a per-machine installer must
  ; not terminate an unrelated process that happens to share an executable
  ; name. The services above were stopped and verified; the desktop manager is
  ; allowed to exit through the installer/runtime lifecycle rather than a
  ; broad taskkill.
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
  DetailPrint "Stopping Yaseir services and removing all local runtime data..."

  ; Stop SCM-owned processes FIRST and prove STOPPED. Killing a service
  ; process before requesting Stop can trigger configured service recovery
  ; and race the uninstaller.
  !insertmacro YASEIR_UN_STOP_SERVICE_VERIFY "YaseirAgent" "un_yaseir"
  !insertmacro YASEIR_UN_STOP_SERVICE_VERIFY "YasserAgent" "un_yasser"
  !insertmacro YASEIR_UN_STOP_SERVICE_VERIFY "OdooPrintAgent" "un_odoo"

  ; Uninstall is destructive product removal. After verified SCM stop,
  ; terminate remaining desktop/background processes holding product files
  ; (manager GUI has no service to stop). Names are product-owned (current
  ; plus legacy branded names from earlier packages); never add a foreign
  ; image name here.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM yaseir-manager.exe'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM yasser-manager.exe'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM odoo-print-manager.exe'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM OdooPrintManager.exe'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "Yaseir Print Manager.exe"'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "Yasser Print Manager.exe"'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM YaseirAgent.exe'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM YasserAgent.exe'
  Pop $R0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM OdooPrintAgent.exe'
  Pop $R0

  nsExec::Exec '"$SYSDIR\sc.exe" delete YasserAgent'
  Pop $R0
  nsExec::Exec '"$SYSDIR\sc.exe" delete OdooPrintAgent'
  Pop $R0

  StrCpy $1 "$INSTDIR\resources\YaseirAgent.exe"
  IfFileExists "$1" agent_uninstall_found 0
  StrCpy $1 "$INSTDIR\YaseirAgent.exe"
  IfFileExists "$1" agent_uninstall_found 0
  SetErrorLevel 1
  Abort "Agent executable is missing; complete cleanup requires repair first."

  agent_uninstall_found:
  nsExec::ExecToStack '"$1" -service purge'
  Pop $R0
  Pop $R1
  StrCmp $R0 "0" agent_removed 0
  DetailPrint "Agent purge failed ($R0): $R1"
  SetErrorLevel 1
  Abort "Yaseir cleanup failed. See installer details."

  agent_removed:
  ; Per-user state is outside ProgramData and may not be visible to the
  ; elevated Agent helper, so remove it explicitly in the uninstaller context.
  RMDir /r "$LOCALAPPDATA\YaseirManager"
  RMDir /r "$LOCALAPPDATA\YasserManager"
  RMDir /r "$LOCALAPPDATA\Yaseir Print Manager"
  RMDir /r "$LOCALAPPDATA\Yasser Print Manager"
  RMDir /r "$LOCALAPPDATA\OdooPrintManager"
  RMDir /r "$LOCALAPPDATA\Odoo Print Manager"
  RMDir /r "$LOCALAPPDATA\com.yasser.manager"
  RMDir /r "$APPDATA\YaseirManager"
  RMDir /r "$APPDATA\YasserManager"
  RMDir /r "$APPDATA\Yaseir Print Manager"
  RMDir /r "$APPDATA\Yasser Print Manager"
  RMDir /r "$APPDATA\OdooPrintManager"
  RMDir /r "$APPDATA\Odoo Print Manager"
  RMDir /r "$APPDATA\com.yasser.manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Yaseir Print Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Yasser Print Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OdooPrintManager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Odoo Print Manager"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.yasser.manager"
!macroend
