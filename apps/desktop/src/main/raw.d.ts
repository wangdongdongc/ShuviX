// 原文导入声明 —— 主进程的 types 只有 electron-vite/node，没有 vite/client 的 `?raw` 声明。
// 目前只有组件页面的主题令牌用它（services/widget/widgetTheme.ts 读 app-shell 的 themes.css）。
declare module '*.css?raw' {
  const content: string
  export default content
}
