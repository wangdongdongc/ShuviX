import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Electron 提供 node:original-fs（未被 ASAR 补丁的原始 fs），
      // 在 Vitest 的 Node.js 环境中不存在，映射到标准 node:fs
      'node:original-fs': 'node:fs'
    }
  },
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
      '../../apps/extension/src/**/*.test.ts'
    ],
    environment: 'node'
  }
})
