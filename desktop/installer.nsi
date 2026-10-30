; MEASURED desktop installer — hand-written so the build never has to EXECUTE
; the produced installer (electron-builder does, and execution inside the
; workspace is blocked by the sandbox). Run with cwd = player\desktop.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP  "MEASURED"
!define VER  "1.0.0"
!define PUB  "Ali"
!define EXE  "MEASURED.exe"
!define UNINST "Uninstall MEASURED.exe"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED"
!define ICO    "dist\.icon-ico\icon.ico"

Name "${APP} ${VER}"
OutFile "..\release\MEASURED-1.0.0-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\MEASURED"
InstallDirRegKey HKCU "Software\MEASURED" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
BrandingText "MEASURED ${VER} — local only, no network"
CRCCheck on

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName"     "${APP}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "FileVersion"     "${VER}"
VIAddVersionKey "ProductVersion"  "${VER}"
VIAddVersionKey "LegalCopyright"  "${PUB}"
VIAddVersionKey "CompanyName"     "${PUB}"

!define MUI_ABORTWARNING
!define MUI_ICON   "${ICO}"
!define MUI_UNICON "${ICO}"

!define MUI_WELCOMEPAGE_TITLE "${APP} ${VER}"
!define MUI_WELCOMEPAGE_TEXT "A local music player: your songs, your machine, no network.$\r$\n$\r$\nThis installs to your user folder and adds Start menu and desktop shortcuts. The 148 bundled tracks (465 MB) are included."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP}"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "MEASURED (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "dist\win-unpacked\*.*"

  CreateShortCut "$DESKTOP\MEASURED.lnk" "$INSTDIR\${EXE}"
  CreateDirectory "$SMPROGRAMS\MEASURED"
  CreateShortCut "$SMPROGRAMS\MEASURED\MEASURED.lnk" "$INSTDIR\${EXE}"
  CreateShortCut "$SMPROGRAMS\MEASURED\Uninstall MEASURED.lnk" "$INSTDIR\${UNINST}"

  WriteUninstaller "$INSTDIR\${UNINST}"

  WriteRegStr HKCU "${REGKEY}" "DisplayName"     "${APP}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion"  "${VER}"
  WriteRegStr HKCU "${REGKEY}" "Publisher"       "${PUB}"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon"     "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\${UNINST}"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\${UNINST}" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${REGKEY}" "EstimatedSize" "$0"

  WriteRegStr HKCU "Software\MEASURED" "InstallDir" "$INSTDIR"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\MEASURED.lnk"
  Delete "$SMPROGRAMS\MEASURED\MEASURED.lnk"
  Delete "$SMPROGRAMS\MEASURED\Uninstall MEASURED.lnk"
  RMDir  "$SMPROGRAMS\MEASURED"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\MEASURED"
  RMDir /r "$INSTDIR"
SectionEnd
