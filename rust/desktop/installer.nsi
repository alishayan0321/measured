Unicode true
SetCompressor /SOLID zlib
RequestExecutionLevel user
SetDatablockOptimize on

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!define APPNAME    "Measure Player"
!define SHORTNAME  "Measure Player"
!define APPVER     "2.0.0"
!define PUBLISHER  "MEASURED"
!define ICO        "icon.ico"

Name "${APPNAME} 2.0.0 (x64)"
OutFile "Measure-2.0.0-Player-x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\MEASURED"
InstallDirRegKey HKCU "Software\MEASURED" "InstallDir"
BrandingText "${APPNAME} - Windows x64"

VIProductVersion "2.0.0.0"
VIAddVersionKey "ProductName"     "${APPNAME}"
VIAddVersionKey "ProductVersion"  "${APPVER}"
VIAddVersionKey "FileDescription" "${APPNAME} - local music library (64-bit)"
VIAddVersionKey "FileVersion"     "${APPVER}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "MEASURED"
VIAddVersionKey "Comments"        "Windows 10/11 x64. Portable build, no admin needed."

!define MUI_ICON "${ICO}"
!define MUI_UNICON "${ICO}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APPNAME} (x64)"
!define MUI_WELCOMEPAGE_TEXT "This installs ${APPNAME} for 64-bit Windows.\textwind\r\n\r\nIt includes the full song library, cover art and the YouTube extractor, so it works offline out of the box. It installs for your user only — no administrator rights, no system changes.\r\n\r\nYour saved songs and settings stay in %APPDATA%\com.measured.player, so upgrading keeps everything."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\MEASURED.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APPNAME}"
!define MUI_FINISHPAGE_TEXT "${APPNAME} is installed. It reads the songs that ship in its own folder, and anything you add later from Settings."
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "This installer is built for 64-bit Windows only.${U+000D}${U+000A}${U+000D}${U+000A}Your PC is running 32-bit Windows, so ${APPNAME} cannot run here."
    Quit
  ${EndIf}
FunctionEnd

Section "MEASURED (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  File "MEASURED.exe"
  File "yt-dlp.exe"

  SetOutPath "$INSTDIR\songs"
  File /r "songs\*.*"
  SetOutPath "$INSTDIR"

  WriteUninstaller "$INSTDIR\Uninstall ${SHORTNAME}.exe"
  CreateShortCut "$DESKTOP\${SHORTNAME}.lnk" "$INSTDIR\MEASURED.exe" "" "$INSTDIR\MEASURED.exe" 0
  CreateDirectory "$SMPROGRAMS\${SHORTNAME}"
  CreateShortCut "$SMPROGRAMS\${SHORTNAME}\${SHORTNAME}.lnk" "$INSTDIR\MEASURED.exe" "" "$INSTDIR\MEASURED.exe" 0
  CreateShortCut "$SMPROGRAMS\${SHORTNAME}\Uninstall ${SHORTNAME}.lnk" "$INSTDIR\Uninstall ${SHORTNAME}.exe"

  WriteRegStr HKCU "Software\MEASURED" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "DisplayName" "${APPNAME} 2.0.0 (x64)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "DisplayVersion" "${APPVER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "DisplayIcon" "$INSTDIR\MEASURED.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "UninstallString" '"$INSTDIR\Uninstall ${SHORTNAME}.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "QuietUninstallString" '"$INSTDIR\Uninstall ${SHORTNAME}.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${SHORTNAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTNAME}\${SHORTNAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTNAME}\Uninstall ${SHORTNAME}.lnk"
  RMDir "$SMPROGRAMS\${SHORTNAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MEASURED"
  DeleteRegKey HKCU "Software\MEASURED"
  RMDir /r "$INSTDIR"
SectionEnd
