!macro customHeader
  RequestExecutionLevel admin
!macroend

!macro preInstall
  !echo "=== preInstall: 检查并关闭旧版进程 ==="
  
  nsExec::Exec 'tasklist /FI "IMAGENAME eq mplay.exe" 2>NUL | find /I "mplay.exe"'
  Pop $0
  StrCmp $0 "" no_old_process
  
  !echo "发现旧版mplay.exe进程，尝试关闭..."
  nsExec::Exec 'taskkill /F /IM mplay.exe'
  Pop $0
  !echo "taskkill返回码: $0"
  
  Sleep 1000
  
  nsExec::Exec 'tasklist /FI "IMAGENAME eq mplay.exe" 2>NUL | find /I "mplay.exe"'
  Pop $0
  StrCmp $0 "" no_old_process
  
  !echo "警告: mplay.exe仍在运行，尝试强制终止..."
  nsExec::Exec 'taskkill /F /T /IM mplay.exe'
  Sleep 2000
  
no_old_process:
  !echo "=== preInstall: 进程检查完成 ==="
!macroend

!macro customInstall
  !echo "=== customInstall: 开始自定义安装后处理 ==="

  !echo "[1/3] 删除旧版快捷方式..."
  
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
  
  !echo "[1/3] 旧版快捷方式删除完成"

  !echo "[2/3] 创建新版快捷方式..."
  
  CreateDirectory "$SMPROGRAMS\mplay"
  
  CreateShortCut "$DESKTOP\mplay.lnk" "$INSTDIR\mplay.exe" "" "$INSTDIR\mplay.exe" 0
  CreateShortCut "$SMPROGRAMS\mplay\mplay.lnk" "$INSTDIR\mplay.exe" "" "$INSTDIR\mplay.exe" 0
  CreateShortCut "$SMPROGRAMS\mplay\Uninstall.lnk" "$INSTDIR\Uninstall mplay.exe" "" "$INSTDIR\Uninstall mplay.exe" 0
  
  !echo "[2/3] 新版快捷方式创建完成"

  !echo "[3/3] 通知系统刷新图标..."
  
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"
  
  !echo "[3/3] 系统刷新通知已发送"

  !echo "=== customInstall: 自定义安装后处理完成 ==="
!macroend

!macro customUnInstall
  !echo "=== customUnInstall: 开始自定义卸载处理 ==="

  !echo "[1/2] 删除快捷方式..."
  
  Delete "$DESKTOP\mplay.lnk"
  Delete "$DESKTOP\logvar-player.lnk"
  Delete "$DESKTOP\MPlay.lnk"
  Delete "$DESKTOP\LogVar Player.lnk"
  
  Delete "$SMPROGRAMS\mplay\mplay.lnk"
  Delete "$SMPROGRAMS\mplay\Uninstall.lnk"
  
  RmDir /r "$SMPROGRAMS\mplay"
  
  !echo "[1/2] 快捷方式删除完成"

  !echo "[2/2] 通知系统刷新图标..."
  
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"
  
  !echo "[2/2] 系统刷新通知已发送"

  !echo "=== customUnInstall: 自定义卸载处理完成 ==="
!macroend
