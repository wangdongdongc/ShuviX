import { resolve as resolvePath } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 共享包按**路径**解析，与 electron.vite.config.ts 的 main 配置一致。
      // 不这么做时 Node 会沿 node_modules 往上找到工作区符号链接 —— 在 git worktree 里
      // 那条链接指向主检出，于是测试跑的是另一个检出的包源码（本地改动全看不见）。
      '@shuvix/chat-protocol': resolvePath(__dirname, '../../packages/chat-protocol/src'),
      // 内置 agent / 安全策略 md 的**构建期内联**变体（单测与扩展用；主进程读随包目录）。
      // 必须排在下面那条之前：Vite 的字符串别名按顺序做前缀匹配，短的会先吃掉长的
      '@shuvix/agent-runtime/builtinAgents/inlineSources': resolvePath(
        __dirname,
        '../../packages/agent-runtime/src/subagent/builtinAgents/inlineSources.ts'
      ),
      '@shuvix/agent-runtime/security/builtinPolicies/inlineSources': resolvePath(
        __dirname,
        '../../packages/agent-runtime/src/security/builtinPolicies/inlineSources.ts'
      ),
      '@shuvix/agent-runtime': resolvePath(__dirname, '../../packages/agent-runtime/src/index.ts'),
      // Electron 提供 node:original-fs（未被 ASAR 补丁的原始 fs），
      // 在 Vitest 的 Node.js 环境中不存在，映射到标准 node:fs
      'node:original-fs': 'node:fs'
    }
  },
  // packages/** 下的 jsdom 用例：Vite 按 /@fs/ URL 取模，仓库根在 vitest root 之外会被
  // fs 守卫挡掉（node 环境不走这条路径，所以只有 jsdom 会炸）
  server: { fs: { allow: [resolvePath(__dirname, '../..')] } },
  test: {
    // 测试 main 进程及 Node.js 共享代码；外加共享包 chat-protocol / agent-runtime / chat-ui
    // 的单测，以及扩展端 runtime 里与桌面同语义的纯逻辑单测（扩展自身不配 vitest ——
    // 两端对照的表要能一条命令一起跑，分成两套 runner 只会让其中一端悄悄烂掉）
    include: [
      'src/main/**/*.test.ts',
      'src/shared/node/**/*.test.ts',
      '../../packages/chat-protocol/src/**/*.test.ts',
      '../../packages/agent-runtime/src/**/*.test.ts',
      '../../packages/chat-ui/src/**/*.test.ts',
      '../../packages/app-shell/src/**/*.test.ts',
      '../../apps/extension/src/**/*.test.ts'
    ],
    environment: 'node'
  }
})
