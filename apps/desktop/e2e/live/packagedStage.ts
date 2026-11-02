/**
 * 给真模型探针摆一个打包后形状的 Resources 目录（electron-builder.yml 的 extraResources 那份清单），配合
 * bootstrap.cjs 的 `SHUVIX_E2E_STAGED_RESOURCES` 使用。
 *
 * 为什么要：手册、技能的绝对路径写在提示词里，模型会顺着路径往上走。开发态下它们在源码仓库里，往上走到的是整份
 * 源码（还在真实主目录下）；用户那里往上走到的是 `ShuviX.app/Contents/Resources` 和一个 `app.asar`。
 * 探针要看的正是模型碰到后者时怎么做。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')

export interface PackagedStage {
  /** 交给 `SHUVIX_E2E_STAGED_RESOURCES` 的目录 */
  resources: string
  cleanup(): void
}

/** `contentFrom`：手册与内置 agent 档案从另一份仓库目录摆（对照旧版文案用；缺省是本 checkout） */
export function stagePackagedResources(contentFrom: string = REPO_ROOT): PackagedStage {
  const root = mkdtempSync('/private/tmp/shuvix-probe-stage-')
  const resources = join(root, 'ShuviX.app', 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })

  const copies: Array<[from: string, to: string]> = [
    [join(contentFrom, 'apps/desktop/resources/knowledge'), 'knowledge'],
    [join(DESKTOP_ROOT, 'resources/skills'), 'skills'],
    [join(DESKTOP_ROOT, 'resources/cli'), 'cli'],
    [join(DESKTOP_ROOT, 'resources/sandbox-libs'), 'sandbox-libs'],
    [join(DESKTOP_ROOT, 'resources/litellm-models.json'), 'litellm-models.json'],
    [join(contentFrom, 'packages/agent-runtime/src/subagent/builtinAgents/md'), 'builtin-agents'],
    [join(REPO_ROOT, 'packages/agent-runtime/src/security/builtinPolicies/md'), 'builtin-policies'],
    [join(REPO_ROOT, 'packages/agent-runtime/src/hook/builtinHooks/md'), 'builtin-hooks'],
    [join(REPO_ROOT, 'node_modules/esbuild-wasm/esbuild.wasm'), 'esbuild/esbuild.wasm'],
    [
      join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'),
      'tree-sitter/web-tree-sitter.wasm'
    ],
    [
      join(REPO_ROOT, 'node_modules/tree-sitter-bash/tree-sitter-bash.wasm'),
      'tree-sitter/tree-sitter-bash.wasm'
    ],
    // 打包后 worker 与 cli.js 都从这里加载
    [join(DESKTOP_ROOT, 'out/main'), 'app.asar.unpacked/out/main']
  ]
  for (const [from, to] of copies) {
    if (existsSync(from)) cpSync(from, join(resources, to), { recursive: true })
  }
  // 29 MB、模型不读：链过去就够了
  symlinkSync(join(DESKTOP_ROOT, 'resources/bundler'), join(resources, 'bundler'))
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(resources, 'app.asar.unpacked', 'node_modules'))
  // 真的 asar：模型 `strings app.asar` / `asar extract` 时拿到的是产品代码，和用户那里一样
  execFileSync(join(REPO_ROOT, 'node_modules/.bin/asar'), [
    'pack',
    join(DESKTOP_ROOT, 'out'),
    join(resources, 'app.asar')
  ])

  return {
    resources,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}
