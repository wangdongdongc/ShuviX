/**
 * 构建时脚本：生成组件 API 相关的三个预置依赖，供 esbuild-wasm 在运行时离线打包。
 *
 * - `zod.esm.js`：zod 整包（作者在 api.ts 里 `import { z } from 'zod'` 也行）；
 * - `widget-api.esm.js`：`shuvix/widget-api` —— 沙箱运行时（src/main/services/widget/api/sandboxRuntime.ts），
 *   zod 外置：组件 build 时打包器把两处的 `zod` 都解析到同一份 zod.esm.js，`instanceof z.ZodObject` 才成立；
 * - `widget.esm.js`：`shuvix/widget` —— 界面调 API 的客户端（src/renderer/src/widgetClient/widgetClient.ts），
 *   react 外置：组件 build 时解析到组件自己用的那一份 React（同一个实例，hook 才成立）。同一份源码另抄进导出模板
 *   （`export-template/widget/src/shuvix-widget.ts`），导出的独立 Vite 项目经别名解析到它；`shuvix/widget-api` 的源码
 *   同样抄一份（`src/shuvix-widget-api.ts`），只给导出项目里 `api.ts` 的类型检查用。
 *
 * 产物提交进仓库（和 react-all.esm.js 一样）。改了 sandboxRuntime.ts / widgetClient.ts 或升级 zod 之后重跑：
 *   npm run bundle:widget-api -w shuvix
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const outdir = resolve(root, 'resources/bundler/deps')
mkdirSync(outdir, { recursive: true })

const common = {
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  minify: true,
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  legalComments: 'none',
  logLevel: 'info'
}

await build({
  ...common,
  stdin: {
    contents: "export * from 'zod'\nexport { z, default } from 'zod'\n",
    resolveDir: root,
    loader: 'js'
  },
  outfile: resolve(outdir, 'zod.esm.js')
})

await build({
  ...common,
  entryPoints: [resolve(root, 'src/main/services/widget/api/sandboxRuntime.ts')],
  external: ['zod'],
  outfile: resolve(outdir, 'widget-api.esm.js')
})

await build({
  ...common,
  entryPoints: [resolve(root, 'src/renderer/src/widgetClient/widgetClient.ts')],
  external: ['react'],
  outfile: resolve(outdir, 'widget.esm.js')
})

const clientSource = readFileSync(
  resolve(root, 'src/renderer/src/widgetClient/widgetClient.ts'),
  'utf8'
)
writeFileSync(
  resolve(root, 'resources/bundler/export-template/widget/src/shuvix-widget-api.ts'),
  '// Copied from ShuviX (src/main/services/widget/api/sandboxRuntime.ts) when ShuviX was built.\n' +
    '// `shuvix/widget-api` resolves here (see tsconfig.json) so that api.ts type-checks. Nothing in this\n' +
    '// project runs it: inside ShuviX, the operations run in a sandbox next to the widget database.\n' +
    readFileSync(resolve(root, 'src/main/services/widget/api/sandboxRuntime.ts'), 'utf8')
)
writeFileSync(
  resolve(root, 'resources/bundler/export-template/widget/src/shuvix-widget.ts'),
  '// Copied from ShuviX (src/renderer/src/widgetClient/widgetClient.ts) when ShuviX was built.\n' +
    '// `import ... from "shuvix/widget"` resolves here (see vite.config.ts). It calls `api/<operation>` and\n' +
    '// listens on `sse` relative to the page, which only ShuviX serves: see EXPORT_NOTES.md.\n' +
    clientSource
)

console.log('\nDone!')
