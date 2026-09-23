; electron-builder 自动引入 build/installer.nsh（nsis.include 的缺省值）。
;
; md 文件关联：只把 ShuviX 登记进「打开方式」（OpenWithProgids），不写 .md / .markdown 的默认值 ——
; electron-builder 自带的 fileAssociations 会写默认值，那等于安装时抢走用户的默认 md 应用。
; 打开后是独立的 md 窗口（主进程从 argv / second-instance 的 argv 取路径，见 utils/markdownFiles）。

!define SHUVIX_MD_PROGID "ShuviX.Markdown"

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${SHUVIX_MD_PROGID}" "" "Markdown"
  WriteRegStr SHCTX "Software\Classes\${SHUVIX_MD_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\${SHUVIX_MD_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "${SHUVIX_MD_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "${SHUVIX_MD_PROGID}" ""
  ; SHCNE_ASSOCCHANGED：让资源管理器重读关联（写法照抄 electron-builder 自己的 uninstaller.nsh）
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

; 卸载完 electron-builder 的 uninstaller.nsh 自己会发一次 SHCNE_ASSOCCHANGED，这里不重复
!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "${SHUVIX_MD_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "${SHUVIX_MD_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\${SHUVIX_MD_PROGID}"
!macroend
