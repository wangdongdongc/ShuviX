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
    // 测试 main 进程及 Node.js 共享代码
    include: ['src/main/**/*.test.ts', 'src/shared/node/**/*.test.ts'],
    environment: 'node'
  }
})
