import { defineConfig } from 'vitest/config'
import unitConfig from './vitest.config'

/**
 * 真模型探针的运行配置 —— 与 e2e 分开是刻意的：探针要花钱、要 API key、结果不确定，
 * 它**永远不该**被 `npm run test` / `npm run test:e2e` 顺带跑到。
 *
 * 共享包的路径别名照抄单测配置：不这么做时 worktree 里会沿 node_modules 的符号链接跑到主检出的包源码。
 * `--mode probe-dry`（`npm run probe:protocols:dry`）给协议探针设 `SHUVIX_PROBE_DRY=1`（跨平台，不靠 shell 设环境变量）。
 */
export default defineConfig(({ mode }) => ({
  resolve: unitConfig.resolve,
  server: unitConfig.server,
  test: {
    include: ['e2e/live/**/*.probe.ts'],
    environment: 'node',
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
    fileParallelism: false,
    reporters: ['default'],
    ...(mode === 'probe-dry' ? { env: { SHUVIX_PROBE_DRY: '1' } } : {})
  }
}))
