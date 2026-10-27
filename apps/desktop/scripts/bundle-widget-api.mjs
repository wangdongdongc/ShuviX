/**
 * 构建时脚本：生成组件 API（`api.ts`）的两个预置依赖，供 esbuild-wasm 在运行时离线打包。
 *
 * - `zod.esm.js`：zod 整包（作者在 api.ts 里 `import { z } from 'zod'` 也行）；
 * - `widget-api.esm.js`：`shuvix/widget-api` —— 沙箱运行时（src/main/services/widget/api/sandboxRuntime.ts），
 *   zod 外置：组件 build 时打包器把两处的 `zod` 都解析到同一份 zod.esm.js，`instanceof z.ZodObject` 才成立。
 *
 * 产物提交进仓库（和 react-all.esm.js 一样）。改了 sandboxRuntime.ts 或升级 zod 之后重跑：
 *   npm run bundle:widget-api -w shuvix
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

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

console.log('\nDone!')
