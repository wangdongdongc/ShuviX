import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'

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
  eslintConfigPrettier
)
