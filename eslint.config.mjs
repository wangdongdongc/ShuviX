import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'

const NO_PI_AGENT_CORE = {
  group: ['@earendil-works/pi-agent-core', '@earendil-works/pi-agent-core/*'],
  message:
    'pi-agent-core was removed in the pi 1.0 migration; use @earendil-works/pi-durable / pi-ai or the local types in @shuvix/agent-runtime.'
}
// pi-ai 的 compat 入口保留的是 0.80 时代的全局 API（getModel / stream / complete + 环境变量注入的 key、
// api 注册表）—— 迁移把模型层换成了活的 createModels() 注册表（agent-runtime 的 src/models）。
const NO_PI_AI_COMPAT = {
  group: ['@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/compat/*'],
  message:
    "pi-ai's compat entry is the old global API (getModel / stream / complete, env-injected keys); use the createModels() registry in @shuvix/agent-runtime (src/models)."
}
// pi 1.0 迁移（P1-01）删掉的旧运行时：harness/（HarnessSession / eventHandler / modelsAdapter / stubEnv /
// zeroContent）、运行时登记簿、会话树缓存、旧模型解析与 OpenAI 兼容层（已并入 src/models/catalog.ts）。
// 按模块名拦，不按目录：相对路径从哪一层引进来都一样拦得住。
const NO_DELETED_RUNTIME = {
  group: [
    '@shuvix/agent-runtime/harness',
    '@shuvix/agent-runtime/harness/*',
    '**/harness/index',
    '**/harness/eventHandler',
    '**/harnessSession',
    '**/modelsAdapter',
    '**/stubEnv',
    '**/zeroContent',
    '**/runtimeRegistry',
    '**/sessionTreeRegistry',
    '**/modelResolver',
    '**/agentModelResolver',
    '**/providerCompat'
  ],
  message:
    'This module was deleted in the pi-durable migration. Sessions run on DurableSession / SessionHost (agent-runtime src/durable); models on src/models.'
}
const MIGRATION_BANS = [NO_PI_AGENT_CORE, NO_PI_AI_COMPAT, NO_DELETED_RUNTIME]
const NO_ELECTRON = {
  name: 'electron',
  message: '@shuvix/agent-runtime is host-agnostic; Electron is injected by the desktop host.'
}
const NO_ELECTRON_SUBPATH = {
  group: ['electron/*'],
  message: '@shuvix/agent-runtime is host-agnostic; Electron is injected by the desktop host.'
}
const NO_NODE_SQLITE = {
  name: 'node:sqlite',
  message:
    'Session storage is opened by the host (SessionHostDeps.openStorage); only tests may open SQLite directly.'
}
const NO_DURABLE_NODE_SQLITE = {
  group: ['@earendil-works/pi-durable/storage/sqlite/node'],
  message:
    'Session storage is opened by the host (SessionHostDeps.openStorage); only tests may open SQLite directly.'
}

// 工作区根 ESLint —— 覆盖 packages/*（可复用包）。
// apps/desktop 有自己的 eslint.config.mjs（含进程分层 boundaries 规则），各自独立。
export default defineConfig(
  // packages/atomic-editor 是 git subtree vendored 的上游源码（见其 VENDORING.md）：
  // 不施加本仓库 lint/风格，保持与上游一致以便 subtree pull 干净合并。
  { ignores: ['**/node_modules', '**/dist', '**/out', 'apps/**', 'packages/atomic-editor/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: { version: 'detect' }
    }
  },
  {
    files: ['packages/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  // pi-agent-core 已在 pi 1.0 迁移中移除（会话层改用 pi-durable）。worktree 位于主仓库目录内时，
  // 模块解析会向上找到主仓库 node_modules 里残留的旧版本 —— 误留的 import 照样能编译运行，只能靠这条规则拦住。
  // 同一组还拦 pi-ai 的 compat 入口与迁移删掉的旧运行时模块（P1-13），免得它们被原样请回来。
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: MIGRATION_BANS }]
    }
  },
  // agent-runtime 宿主无关：Electron 与 node:sqlite 只能由宿主注入（会话存储的打开器是 seam）。
  // 同一条规则在后面的配置块里会整体替换前面的选项，所以迁移那一组在这里要再写一遍。
  {
    files: ['packages/agent-runtime/**/*.{ts,tsx}'],
    ignores: ['packages/agent-runtime/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [NO_ELECTRON, NO_NODE_SQLITE],
          patterns: [...MIGRATION_BANS, NO_ELECTRON_SUBPATH, NO_DURABLE_NODE_SQLITE]
        }
      ]
    }
  },
  // 测试可以直接开 SQLite 存储（临时目录里的真文件），Electron 仍然不行
  {
    files: ['packages/agent-runtime/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: [NO_ELECTRON], patterns: [...MIGRATION_BANS, NO_ELECTRON_SUBPATH] }
      ]
    }
  },
  eslintConfigPrettier
)
