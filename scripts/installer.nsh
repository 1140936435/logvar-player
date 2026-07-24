!macro customHeader
  RequestExecutionLevel admin
!macroend

!macro preInstall
  nsExec::Exec 'tasklist /FI "IMAGENAME eq 环影.exe" 2>NUL | find /I "环影.exe"'
  Pop $0
  StrCmp $0 "0" process_found
  Goto preInstall_done
  
process_found:
  nsExec::Exec 'taskkill /F /IM 环影.exe'
  Sleep 1000
  
  nsExec::Exec 'tasklist /FI "IMAGENAME eq 环影.exe" 2>NUL | find /I "环影.exe"'
  Pop $0
  StrCmp $0 "0" force_kill
  Goto preInstall_done
  
force_kill:
  nsExec::Exec 'taskkill /F /T /IM 环影.exe'
  Sleep 2000
  
preInstall_done:
!macroend

!macro customInstall
  Delete "$DESKTOP\mplay.lnk"
  Delete "$DESKTOP\logvar-player.lnk"
  Delete "$DESKTOP\MPlay.lnk"
  Delete "$DESKTOP\LogVar Player.lnk"
  Delete "$DESKTOP\环影.lnk"
  
  Delete "$SMPROGRAMS\mplay\mplay.lnk"
  Delete "$SMPROGRAMS\mplay\logvar-player.lnk"
  Delete "$SMPROGRAMS\mplay\MPlay.lnk"
  Delete "$SMPROGRAMS\mplay\LogVar Player.lnk"
  Delete "$SMPROGRAMS\mplay\Uninstall.lnk"
  
  Delete "$SMPROGRAMS\logvar-player\mplay.lnk"
  Delete "$SMPROGRAMS\logvar-player\logvar-player.lnk"
  Delete "$SMPROGRAMS\logvar-player\Uninstall.lnk"
  
  Delete "$SMPROGRAMS\环影\环影.lnk"
  Delete "$SMPROGRAMS\环影\Uninstall.lnk"
  
  RmDir /r "$SMPROGRAMS\mplay"
  RmDir /r "$SMPROGRAMS\logvar-player"
  RmDir /r "$SMPROGRAMS\环影"
  
  CreateDirectory "$SMPROGRAMS\环影"
  
  CreateShortCut "$DESKTOP\环影.lnk" "$INSTDIR\环影.exe" "" "$INSTDIR\环影.exe" 0
  CreateShortCut "$SMPROGRAMS\环影\环影.lnk" "$INSTDIR\环影.exe" "" "$INSTDIR\环影.exe" 0
  CreateShortCut "$SMPROGRAMS\环影\Uninstall.lnk" "$INSTDIR\Uninstall 环影.exe" "" "$INSTDIR\Uninstall 环影.exe" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\mplay.lnk"
  Delete "$DESKTOP\logvar-player.lnk"
  Delete "$DESKTOP\MPlay.lnk"
  Delete "$DESKTOP\LogVar Player.lnk"
  Delete "$DESKTOP\环影.lnk"
  
  Delete "$SMPROGRAMS\mplay\mplay.lnk"
  Delete "$SMPROGRAMS\mplay\Uninstall.lnk"
  
  Delete "$SMPROGRAMS\环影\环影.lnk"
  Delete "$SMPROGRAMS\环影\Uninstall.lnk"
  
  RmDir /r "$SMPROGRAMS\mplay"
  RmDir /r "$SMPROGRAMS\环影"
!macroend
