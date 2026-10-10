; 修复「自动更新后任务栏图标仍是旧图标」的问题。
; 静默更新时 electron-builder 的 keepShortcuts 机制会保留旧快捷方式，安装路径与
; AppUserModelId 又始终不变；Windows 图标缓存按「exe 路径 + 图标索引」缓存位图，
; exe 被覆盖后缓存项不会自动失效，任务栏/开始菜单便继续显示旧版本缓存的图标
; （早期版本缓存的是无图标状态）。全新安装的机器没有历史缓存，所以不受影响。
; 这里在安装（含静默更新）结束后主动让外壳重新解析这些图标。
!macro customInstall
  ; 逐项发送「项目已更新」通知（SHCNE_UPDATEITEM，flags = SHCNF_PATHW | SHCNF_FLUSH）
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$appExe", i 0)'
  ${if} ${FileExists} "$newStartMenuLink"
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$newStartMenuLink", i 0)'
  ${endIf}
  ${if} ${FileExists} "$newDesktopLink"
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$newDesktopLink", i 0)'
  ${endIf}
  ; 用户把应用固定到任务栏时生成的快捷方式（名字通常与开始菜单快捷方式一致）
  ${if} ${FileExists} "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk", i 0)'
  ${endIf}
  ; 关联变更 + 冲刷图标缓存（SHCNE_ASSOCCHANGED + SHCNF_FLUSH）
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0x1000, i 0, i 0)'
  ; 触发系统重建图标缓存；异步执行，不阻塞静默安装
  Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend
