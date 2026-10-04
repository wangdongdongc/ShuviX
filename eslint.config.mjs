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
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [NO_PI_AGENT_CORE] }]
    }
  },
  // agent-runtime 宿主无关：Electron 与 node:sqlite 只能由宿主注入（会话存储的打开器是 seam）。
  // 同一条规则在后面的配置块里会整体替换前面的选项，所以 pi-agent-core 那条在这里要再写一遍。
  {
    files: ['packages/agent-runtime/**/*.{ts,tsx}'],
    ignores: ['packages/agent-runtime/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [NO_ELECTRON, NO_NODE_SQLITE],
          patterns: [NO_PI_AGENT_CORE, NO_ELECTRON_SUBPATH, NO_DURABLE_NODE_SQLITE]
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
        { paths: [NO_ELECTRON], patterns: [NO_PI_AGENT_CORE, NO_ELECTRON_SUBPATH] }
      ]
    }
  },
  eslintConfigPrettier
)
