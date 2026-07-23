!macro customInstall
  !echo "=== 自定义安装脚本开始 ==="

  !echo "[1/5] 删除旧版快捷方式..."
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
  !echo "[1/5] 旧版快捷方式删除完成"

  !echo "[2/5] 创建新版快捷方式..."
  CreateDirectory "$SMPROGRAMS\mplay"
  
  CreateShortCut "$DESKTOP\mplay.lnk" "$INSTDIR\mplay.exe" "" "$INSTDIR\mplay.exe" 0
  CreateShortCut "$SMPROGRAMS\mplay\mplay.lnk" "$INSTDIR\mplay.exe" "" "$INSTDIR\mplay.exe" 0
  CreateShortCut "$SMPROGRAMS\mplay\Uninstall.lnk" "$INSTDIR\Uninstall mplay.exe" "" "$INSTDIR\Uninstall mplay.exe" 0
  !echo "[2/5] 新版快捷方式创建完成"

  !echo "[3/5] 尝试刷新图标缓存（安全模式）..."
  ExecWait 'taskkill /f /im explorer.exe' $0
  !echo "taskkill 返回码: $0"
  
  Sleep 2000
  
  ExecWait '"$SYSDIR\ie4uinit.exe" -ClearIconCache' $0
  !echo "ie4uinit 返回码: $0"
  
  Sleep 3000
  
  ExecWait '"$SYSDIR\explorer.exe"' $0
  !echo "explorer 重启返回码: $0"
  
  Sleep 2000
  !echo "[3/5] 图标缓存刷新完成"

  !echo "[4/5] 发送系统刷新消息..."
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"
  !echo "[4/5] 系统消息发送完成"

  !echo "[5/5] 安装完成提示..."
  MessageBox MB_OK|MB_ICONINFORMATION "mplay v1.2 安装完成！$\n$\n如需刷新桌面图标显示，建议手动重启电脑。"
  !echo "[5/5] 安装完成提示已显示"

  !echo "=== 自定义安装脚本完成 ==="
!macroend

!macro customUnInstall
  !echo "=== 自定义卸载脚本开始 ==="

  !echo "[1/3] 删除快捷方式..."
  Delete "$DESKTOP\mplay.lnk"
  Delete "$DESKTOP\logvar-player.lnk"
  Delete "$DESKTOP\MPlay.lnk"
  Delete "$DESKTOP\LogVar Player.lnk"
  
  Delete "$SMPROGRAMS\mplay\mplay.lnk"
  Delete "$SMPROGRAMS\mplay\Uninstall.lnk"
  
  RmDir /r "$SMPROGRAMS\mplay"
  !echo "[1/3] 快捷方式删除完成"

  !echo "[2/3] 尝试刷新图标缓存（安全模式）..."
  ExecWait 'taskkill /f /im explorer.exe' $0
  Sleep 2000
  ExecWait '"$SYSDIR\ie4uinit.exe" -ClearIconCache' $0
  Sleep 3000
  ExecWait '"$SYSDIR\explorer.exe"' $0
  Sleep 2000
  !echo "[2/3] 图标缓存刷新完成"

  !echo "[3/3] 发送系统刷新消息..."
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"
  !echo "[3/3] 系统消息发送完成"

  !echo "=== 自定义卸载脚本完成 ==="
!macroend
