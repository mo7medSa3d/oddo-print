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
; Process-identity rule: the installer/uninstaller never terminates a process
; by image name. Image-name matching is machine-wide and is not proof that a
; process belongs to this installation. SCM-owned Agent processes are stopped
; through their service lifecycle; any forced background-process termination
; is performed by the Manager runtime only after exact PID + image + creation-
; time ownership verification.

!include "StrFunc.nsh"
${StrStr}

; --- Installer-side ownership-gated stop -------------------------------------
; PREINSTALL runs before the new Agent binary is copied into $INSTDIR, so it
; cannot delegate ownership verification to the new helper yet. Query the SCM
; registration with trusted sc.exe, parse the first executable from
; BINARY_PATH_NAME, and permit a stop only when it is exactly this install's
; root/resources executable. Same-name services elsewhere abort the upgrade.
!macro YASEIR_STOP_OWNED_SERVICE_VERIFY name exe tag
  nsExec::ExecToStack '"$SYSDIR\sc.exe" qc "${name}"'
  Pop $R0
  Pop $R1
  StrCmp $R0 "1060" yaseir_owned_done_${tag}
  ${StrStr} $R2 $R1 "1060"
  StrCmp $R2 "" +2 0
    Goto yaseir_owned_done_${tag}
  StrCmp $R0 "0" +3 0
    DetailPrint "Cannot inspect service ${name}; refusing to mutate an unverified registration."
    Abort "Unable to verify Windows service ${name}. Repair or remove it manually, then rerun the installer."

  ${StrStr} $R2 $R1 "BINARY_PATH_NAME"
  StrCmp $R2 "" yaseir_owned_reject_${tag}
  StrLen $R3 "BINARY_PATH_NAME"
  StrCpy $R2 $R2 "" $R3

  yaseir_owned_trim_${tag}:
    StrCpy $R4 $R2 1
    StrCmp $R4 " " yaseir_owned_strip_${tag}
    StrCmp $R4 ":" yaseir_owned_strip_${tag}
    StrCmp $R4 "$\t" yaseir_owned_strip_${tag}
    StrCmp $R4 "$\"" yaseir_owned_strip_${tag}
    Goto yaseir_owned_compare_${tag}
  yaseir_owned_strip_${tag}:
    StrCpy $R2 $R2 "" 1
    Goto yaseir_owned_trim_${tag}

  yaseir_owned_compare_${tag}:
    StrLen $R3 "$INSTDIR\resources\${exe}"
    StrCpy $R4 $R2 $R3
    StrCmp $R4 "$INSTDIR\resources\${exe}" yaseir_owned_delim_${tag}
    StrLen $R3 "$INSTDIR\${exe}"
    StrCpy $R4 $R2 $R3
    StrCmp $R4 "$INSTDIR\${exe}" yaseir_owned_delim_${tag}
    Goto yaseir_owned_reject_${tag}

  yaseir_owned_delim_${tag}:
    StrCpy $R5 $R2 1 $R3
    StrCmp $R5 "" yaseir_owned_stop_${tag}
    StrCmp $R5 "$\"" yaseir_owned_stop_${tag}
    StrCmp $R5 " " yaseir_owned_stop_${tag}
    StrCmp $R5 "$\t" yaseir_owned_stop_${tag}
    StrCmp $R5 "$\r" yaseir_owned_stop_${tag}
    StrCmp $R5 "$\n" yaseir_owned_stop_${tag}
    Goto yaseir_owned_reject_${tag}

  yaseir_owned_reject_${tag}:
    DetailPrint "Service ${name} does not point to this installation; refusing to stop or replace it."
    Abort "A foreign Windows service named ${name} exists. Resolve the service-name conflict before installing Yaseir."

  yaseir_owned_stop_${tag}:
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
      Goto yaseir_owned_done_${tag}
    ${StrStr} $R2 $R1 "STOPPED"
    StrCmp $R2 "" 0 yaseir_owned_done_${tag}
    Goto yaseir_stop_poll_${tag}
  yaseir_stop_check_${tag}:
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query "${name}"'
    Pop $R0
    Pop $R1
    ${StrStr} $R2 $R1 "1060"
    StrCmp $R2 "" +2 0
      Goto yaseir_owned_done_${tag}
    ${StrStr} $R2 $R1 "STOPPED"
    StrCmp $R2 "" 0 yaseir_owned_done_${tag}
    DetailPrint "Service ${name} did not stop; aborting before replacing binaries."
    SetErrorLevel 1
    Abort "Service ${name} is still running. Stop it manually and rerun the installer."
  yaseir_owned_done_${tag}:
!macroend


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping only Yaseir services proven to belong to this installation..."
  !insertmacro YASEIR_STOP_OWNED_SERVICE_VERIFY "YaseirAgent" "YaseirAgent.exe" "pre_yaseir"
  !insertmacro YASEIR_STOP_OWNED_SERVICE_VERIFY "YasserAgent" "YasserAgent.exe" "pre_yasser"
  !insertmacro YASEIR_STOP_OWNED_SERVICE_VERIFY "OdooPrintAgent" "OdooPrintAgent.exe" "pre_odoo"
  ; Legacy registration deletion is intentionally deferred until POSTINSTALL.
  ; The newly installed Agent performs that mutation through SCM only after
  ; exact installation-path verification. NSIS never deletes a service by name.
!macroend


!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Yaseir Agent Windows Service..."
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
  DetailPrint "Stopping the owned Yaseir Agent and removing local runtime data..."

  ; Do not stop/delete registrations by well-known service name here. The
  ; bundled Agent below verifies the current and legacy SCM BinaryPathName
  ; against this installation before every stop/delete mutation, then purges
  ; only those proven-owned services. Foreign same-name services fail closed.
  ; Likewise, never terminate processes by image name; exact-PID background
  ; ownership fencing remains in the Manager runtime.

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
  ; The Agent owns machine-data removal. Do not add a second elevated
  ; recursive deletion rooted in inherited PROGRAMDATA/LOCALAPPDATA/APPDATA:
  ; these variables can be redirected, and NSIS cannot authenticate junction
  ; or reparse-point ownership after the helper has exited.
  ; A locked residual file is intentionally left for explicit privileged
  ; cleanup from a trusted location, not wiped by a broader fallback.
  DetailPrint "Owned service purge completed. If files were locked, use the secure cleanup runbook."
  DetailPrint "Agent cleanup result: $R1"
  ; Per-user profiles may not belong to the elevated uninstall identity.
  ; Do not remove arbitrary profile directories or HKCU run keys here.
!macroend
