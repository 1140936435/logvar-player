!macro customHeader
  RequestExecutionLevel admin
!macroend

!macro preInstall
  nsExec::Exec 'tasklist /FI "IMAGENAME eq mplay.exe" 2>NUL | find /I "mplay.exe"'
  Pop $0
  StrCmp $0 "0" process_found
  Goto preInstall_done
  
process_found:
  nsExec::Exec 'taskkill /F /IM mplay.exe'
  Sleep 1000
  
  nsExec::Exec 'tasklist /FI "IMAGENAME eq mplay.exe" 2>NUL | find /I "mplay.exe"'
  Pop $0
  StrCmp $0 "0" force_kill
  Goto preInstall_done
  
force_kill:
  nsExec::Exec 'taskkill /F /T /IM mplay.exe'
  Sleep 2000
  
preInstall_done:
!macroend

!macro customInstall
  Delete "$DESKTOP\mplay.lnk"
  Delete "$DESKTOP\logvar-player.lnk"
  Delete "$DESKTOP\MPlay.lnk"
  Delete "$DESKTOP\LogVar Player.lnk"
  
  Delete "$SMPROGRAMS\mplay\mplay.lnk"
  Delete "$SMPROGRAMS\mplay\logvar-player.lnk"
  Delete "$SMPROGRAMS\mplay\MPlay.lnk"
  Delete "$SMPROGRAMS\mplay\LogVar Player.lnk"
  Delete "$SMPROGRAMS\mplay\Uninstall.lnk"
  
  Delete "$SMPROGRAMS\logvar-player\mplay.lnk"
  Delete "$SMPROGRAMS\logvar-player\logvar-player.lnk"
  Delete "$SMPROGRAMS\logvar-player\Uninstall.lnk"
  
  RmDir /r "$SMPROGRAMS\mplay"
  RmDir /r "$SMPROGRAMS\logvar-player"
  
  CreateDirectory "$SMPROGRAMS\mplay"
  
  CreateShortCut "$DESKTOP\mplay.lnk" "$INSTDIR\mplay.exe" "" "$INSTDIR\mplay.exe" 0
  CreateShortCut "$SMPROGRAMS\mplay\mplay.lnk" "$INSTDIR\mplay.exe" "" "$INSTDIR\mplay.exe" 0
  CreateShortCut "$SMPROGRAMS\mplay\Uninstall.lnk" "$INSTDIR\Uninstall mplay.exe" "" "$INSTDIR\Uninstall mplay.exe" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\mplay.lnk"
  Delete "$DESKTOP\logvar-player.lnk"
  Delete "$DESKTOP\MPlay.lnk"
  Delete "$DESKTOP\LogVar Player.lnk"
  
  Delete "$SMPROGRAMS\mplay\mplay.lnk"
  Delete "$SMPROGRAMS\mplay\Uninstall.lnk"
  
  RmDir /r "$SMPROGRAMS\mplay"
!macroend
