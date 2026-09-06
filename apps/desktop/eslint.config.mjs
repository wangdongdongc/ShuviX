import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import eslintPluginBoundaries from 'eslint-plugin-boundaries'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', 'resources/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  // .cjs 文件允许 require
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // 测试文件放宽规则
  {
    files: ['**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // 架构分层依赖约束（eslint-plugin-boundaries）
  //
  // 元素类型顺序敏感：先写的 pattern 先匹配，确保特化在前、回退在后。
  // 分层方向（由下至上）：shared / main-types / main-dao / main-util
  //   → main-service → main-tool / main-subagent
  //   → main-frontend-impl / main-ipc → main-entry
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries: eslintPluginBoundaries },
    settings: {
      // TypeScript 路径解析：让 boundaries 能正确定位 .ts/index.ts/路径别名
      'import/resolver': {
        typescript: {
          project: ['tsconfig.node.json', 'tsconfig.web.json'],
          noWarnOnMultipleProjects: true
        }
      },
      'boundaries/include': ['src/**/*'],
      // 默认 mode: 'folder'，pattern 指向目录根，匹配器自动追加 /**/*
      // 先写的、更具体的 pattern 优先匹配；fallback 的 shared 放最后
      'boundaries/elements': [
        { type: 'renderer', pattern: 'src/renderer' },
        { type: 'preload', pattern: 'src/preload' },
        // CLI 进程：通过 ELECTRON_RUN_AS_NODE 在 Electron 内以 node 模式运行；
        // 与主进程通过 Unix socket / named pipe 通信，不直接依赖任何 src/ 模块
        { type: 'cli', pattern: 'src/cli' },
        { type: 'shared-node', pattern: 'src/shared/node' },
        { type: 'shared', pattern: 'src/shared' },
        // main-entry：bootstrap，单文件；可引一切
        { type: 'main-entry', pattern: 'src/main/index.ts', mode: 'file' },
        { type: 'main-dao', pattern: 'src/main/dao' },
        // main-types：cross-process 类型合同层（纯类型）
        // 注：跨进程事件协议 ChatEvent 已抽到 @shuvix/chat-protocol/events（包外，按 external 处理）
        { type: 'main-types', pattern: 'src/main/types' },
        // main-util：基础工具层（utils + 顶层单文件 logger/perf/i18n）
        { type: 'main-util', pattern: 'src/main/utils' },
        {
          type: 'main-util',
          pattern: ['src/main/logger.ts', 'src/main/perf.ts', 'src/main/i18n.ts'],
          mode: 'file'
        },
        // main-frontend-core：frontend/core 的运行时编排（Gateway / Registry / OperationContext）
        { type: 'main-frontend-core', pattern: 'src/main/frontend/core' },
        // frontend 里非 core 的都是具体后端（electron / telegram / web）
        { type: 'main-frontend-impl', pattern: 'src/main/frontend' },
        { type: 'main-subagent', pattern: 'src/main/subagent' },
        { type: 'main-ipc', pattern: 'src/main/ipc' },
        { type: 'main-tool', pattern: 'src/main/tools' },
        // services/__tests__ 不算独立模块，归回 main-service（先于 module 规则匹配）
        { type: 'main-service', pattern: 'src/main/services/__tests__' },
        // main-service-contract：services/ 根目录的少量"工具子系统原语"
        // toolContext（ToolContext/sandbox/TOOL_ABORTED）/ toolRegistry（注册表）
        // 独立模块与 tool 实现层都需要它们，视为服务层内部的"合约原语"
        // 注：BaseTool 已下沉 @shuvix/agent-runtime（包外，按 external 处理），消费方直接引包
        {
          type: 'main-service-contract',
          pattern: ['src/main/services/toolContext.ts', 'src/main/services/toolRegistry.ts'],
          mode: 'file'
        },
        // main-service-module：services/ 下的独立子目录模块（bundler / browser / widget / tts / pglite）
        // 强制"内聚模块"边界：模块内部禁止反向依赖 services/ 根目录的平铺上层 service
        // 必须写在 main-service（fallback）之前，让子目录命中更具体的 module 元素
        { type: 'main-service-module', pattern: 'src/main/services/*' },
        { type: 'main-service', pattern: 'src/main/services' }
      ]
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // 进程隔离：renderer 只能消费共享层与 main-types（类型层）
            {
              from: { type: 'renderer' },
              allow: { to: { type: ['renderer', 'shared', 'main-types'] } }
            },
            // preload：桥层，类型可见但不入主程序运行时
            {
              from: { type: 'preload' },
              allow: { to: { type: ['preload', 'shared', 'main-types'] } }
            },
            // cli：通过 socket 与主进程通信，仅消费 shared 类型
            {
              from: { type: 'cli' },
              allow: { to: { type: ['cli', 'shared'] } }
            },
            // shared：叶子层
            { from: { type: 'shared' }, allow: { to: { type: ['shared'] } } },
            {
              from: { type: 'shared-node' },
              allow: { to: { type: ['shared-node', 'shared'] } }
            },
            // ── 主进程分层（由下至上） ─────────────────────────────
            // DAO：叶子层，可用 util / types / shared
            {
              from: { type: 'main-dao' },
              allow: {
                to: {
                  type: ['main-dao', 'main-util', 'main-types', 'shared', 'shared-node']
                }
              }
            },
            // main-util：基础工具层
            {
              from: { type: 'main-util' },
              allow: {
                to: {
                  type: ['main-util', 'main-types', 'main-dao', 'shared', 'shared-node']
                }
              }
            },
            // main-types：允许 types 之间相互引用、向下查询 dao，并对 types ↔ util 放开
            {
              from: { type: 'main-types' },
              allow: {
                to: {
                  type: ['main-types', 'main-util', 'main-dao', 'shared']
                }
              }
            },
            // main-service-module：services/ 下的独立子目录模块（bundler / browser / widget / tts）
            // 强制内聚：只能依赖下层（dao / util / types / frontend-core / shared / plugin-api）
            // 以及其他独立模块（允许 widget → bundler 这样的平级模块依赖）
            // 禁止反向依赖 services/ 根目录的平铺上层 service
            {
              from: { type: 'main-service-module' },
              allow: {
                to: {
                  type: [
                    'main-service-module',
                    'main-service-contract',
                    'main-frontend-core',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-service-contract：services/ 根目录的工具子系统原语（baseTool / toolContext / toolRegistry）
            // 只依赖下层（dao / util / types / shared）；tool 实现 / 各模块都能引
            {
              from: { type: 'main-service-contract' },
              allow: {
                to: {
                  type: [
                    'main-service-contract',
                    'main-service',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'main-frontend-core',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-service：业务层。禁止访问 tool 实现 / ipc / frontend-impl / entry
            // 允许：dao / util / types / frontend-core（gateway 抽象）/ subagent（子智能体注册表等）/ plugin-api
            // 以及 services/ 下的独立模块（平铺 service 作为编排层，自然消费各模块）
            {
              from: { type: 'main-service' },
              allow: {
                to: {
                  type: [
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-subagent',
                    'main-frontend-core',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-tool：工具实现层，位于 service 之上。可引 service / subagent（allTools 触发 subagent 注册）
            {
              from: { type: 'main-tool' },
              allow: {
                to: {
                  type: [
                    'main-tool',
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-subagent',
                    'main-frontend-core',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-subagent：子智能体层
            {
              from: { type: 'main-subagent' },
              allow: {
                to: {
                  type: [
                    'main-subagent',
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-tool',
                    'main-frontend-core',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-frontend-core：gateway 抽象 + 注册表（Chat*Registry、ChatGateway、OperationContext 等）
            // 承担把 service 产物分发给具体 frontend 的角色，允许它引用 service 层
            {
              from: { type: 'main-frontend-core' },
              allow: {
                to: {
                  type: [
                    'main-frontend-core',
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-subagent',
                    'main-tool',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-frontend-impl：具体前端后端（electron/telegram/web）
            {
              from: { type: 'main-frontend-impl' },
              allow: {
                to: {
                  type: [
                    'main-frontend-impl',
                    'main-frontend-core',
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-ipc：IPC handler 层，编排所有主进程模块
            {
              from: { type: 'main-ipc' },
              allow: {
                to: {
                  type: [
                    'main-ipc',
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-tool',
                    'main-subagent',
                    'main-frontend-core',
                    'main-frontend-impl',
                    'main-dao',
                    'main-util',
                    'main-types',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            },
            // main-entry：bootstrap，可引一切
            {
              from: { type: 'main-entry' },
              allow: {
                to: {
                  type: [
                    'main-entry',
                    'main-ipc',
                    'main-frontend-core',
                    'main-frontend-impl',
                    'main-subagent',
                    'main-tool',
                    'main-service',
                    'main-service-module',
                    'main-service-contract',
                    'main-util',
                    'main-types',
                    'main-dao',
                    'shared',
                    'shared-node'
                  ]
                }
              }
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
