import { defineConfig } from 'vitest/config'

/**
 * 真模型探针的运行配置 —— 与 e2e 分开是刻意的：探针要花钱、要 API key、结果不确定，
 * 它**永远不该**被 `npm run test` / `npm run test:e2e` 顺带跑到。
 */
export default defineConfig({
  test: {
    include: ['e2e/live/**/*.probe.ts'],
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
    fileParallelism: false,
    reporters: ['default']
  }
})
