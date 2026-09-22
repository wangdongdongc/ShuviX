const path = require('path')

// 内容扫描：扩展自身 src + 复用的 @shuvix/chat-ui 包源码（绝对路径，避免被 purge）。
// app-shell 只用到右键菜单与主题，扫它的 contextmenu 目录就够了
module.exports = {
  content: [
    path.resolve(__dirname, 'src/**/*.{ts,tsx,html}'),
    path.resolve(__dirname, 'sidepanel.html'),
    path.resolve(__dirname, '../../packages/chat-ui/src/**/*.{ts,tsx}'),
    path.resolve(__dirname, '../../packages/app-shell/src/contextmenu/**/*.{ts,tsx}')
  ]
}
