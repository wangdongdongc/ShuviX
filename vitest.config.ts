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
    // 仅测试 main 进程 Node.js 代码
    include: ['src/main/**/*.test.ts'],
    environment: 'node'
  }
})
