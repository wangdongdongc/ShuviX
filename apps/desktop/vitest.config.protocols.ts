import { defineConfig } from 'vitest/config'
import unitConfig from './vitest.config'

/**
 * 协议探针（P4-06）专用的运行配置：`npm run probe:protocols` / `probe:protocols:dry`。
 *
 * - **include 只有 `e2e/live/protocols.probe.ts` 这一个字面路径**（没有通配）：同目录的 `probe.ts` /
 *   `review.probe.ts` / `subsession.probe.ts` 会读真实实例的数据库，这份配置无论怎么传参都跑不到它们
 *   （守卫：`services/models/__tests__/protocolProbe.guard.test.ts`）。所以不复用 `vitest.config.probe.ts`
 *  （它收 `e2e/live/**\/*.probe.ts`）。
 * - 共享包的路径别名照抄单测配置：不这么做时 worktree 里会沿 node_modules 的符号链接跑到主检出的包源码。
 * - `--mode probe-dry` 设 `SHUVIX_PROBE_DRY=1`（跨平台，不靠 shell 设环境变量）。
 * - 永远不被 `npm run test`（单测配置不收 e2e/）或 `npm run test:e2e` 顺带跑到。
 */
export const PROTOCOL_PROBE_INCLUDE = ['e2e/live/protocols.probe.ts']

export default defineConfig(({ mode }) => ({
  resolve: unitConfig.resolve,
  server: unitConfig.server,
  test: {
    include: PROTOCOL_PROBE_INCLUDE,
    environment: 'node',
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
    fileParallelism: false,
    reporters: ['default'],
    ...(mode === 'probe-dry' ? { env: { SHUVIX_PROBE_DRY: '1' } } : {})
  }
}))
