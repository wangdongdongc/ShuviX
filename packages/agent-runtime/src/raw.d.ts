// 原文导入声明 —— 内置 agent 档案以 md 文件维护、构建期由 Vite/rollup 的 `?raw` 内联为字符串。
// 放在包内是因为两端 tsconfig 都 include 了 packages/agent-runtime/src/**/*，
// 而桌面主进程的 types 只有 electron-vite/node（没有 vite/client 的同等声明）。
declare module '*.md?raw' {
  const content: string
  export default content
}
