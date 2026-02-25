import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 仅测试 main 进程 Node.js 代码
    include: ['src/main/**/*.test.ts'],
    environment: 'node'
  }
})
