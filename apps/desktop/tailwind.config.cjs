const { resolve } = require('node:path')

/**
 * Tailwind 内容扫描配置（v4 兼容配置，经 main.css 的 `@config` 引入）。
 *
 * 用 CommonJS（.cjs）写：`__dirname` 原生可用、模块类型无歧义，
 * 避免 Node 的 MODULE_TYPELESS_PACKAGE_JSON 重解析警告，且不必给 package.json 加 "type":"module"。
 *
 * 关键：用 `path.resolve(__dirname, …)` 算**绝对路径**，不依赖引用它的 CSS 文件深度——
 * monorepo 里目录怎么挪都不会再因相对层级变了而扫不到 @shuvix/chat-ui 包、purge 掉对话框组件的 class。
 */
module.exports = {
  content: [
    resolve(__dirname, 'src/renderer/src/**/*.{ts,tsx,html}'),
    resolve(__dirname, 'src/webui/**/*.{ts,tsx,html}'),
    resolve(__dirname, '../../packages/chat-ui/src/**/*.{ts,tsx}'),
    resolve(__dirname, '../../packages/app-shell/src/**/*.{ts,tsx}')
  ]
}
