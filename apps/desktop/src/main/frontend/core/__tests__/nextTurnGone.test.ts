/**
 * P3-11-11 静态闸：「下一轮」（nextTurn）那一档从头到尾去掉了（Q-P3-09）—— `apps/*\/src` 与 `packages/*\/src`
 * 下（含单测与语言包 JSON）一处 `nextTurn` 都没有，除了下面这张白名单：
 *
 *  - `legacy/harnessV3/**`：冻结的旧投影（只是注释）；
 *  - 断言它**不在**的那几处（`@ts-expect-error`、拒绝路径、键不存在）—— 每一条都必须真的还提到它，
 *    白名单不许烂成摆设。
 *
 * e2e 的 `fakeProvider.nextTurn()` 不在扫描范围里（`e2e/`，与这一档无关的同名方法）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..')
const ROOTS = [
  'apps/desktop/src',
  'apps/extension/src',
  'packages/chat-protocol/src',
  'packages/chat-ui/src',
  'packages/app-shell/src',
  'packages/agent-runtime/src'
]
const PATTERN = /next_?turn/i
const FROZEN_PREFIX = 'packages/agent-runtime/src/legacy/harnessV3/'
/** 断言「不在」的文件（相对仓库根） */
const ASSERTS_ABSENCE = [
  'apps/desktop/src/main/frontend/core/__tests__/nextTurnGone.test.ts',
  'apps/desktop/src/main/frontend/chrome/__tests__/channel.test.ts',
  'apps/desktop/src/main/services/__tests__/agentSessionFacade.test.ts',
  'apps/desktop/src/main/services/__tests__/sessionRuntimeWiring.test.ts',
  'packages/chat-protocol/src/chatApiQueue.test.ts',
  // CB-22：Chrome 侧边栏的白名单里没有它（P3-09-01）
  'packages/chat-protocol/src/chromeBridge.test.ts',
  'packages/chat-protocol/src/i18n/locales.test.ts',
  'packages/chat-protocol/src/types/agentMonitor.test.ts',
  'packages/chat-protocol/src/types/sessionView.test.ts'
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx|json)$/.test(name) ? [full] : []
  })
}

describe('P3-11-11 静态：没有 nextTurn', () => {
  const files = ROOTS.flatMap((root) => walk(join(REPO, root)))
  const mentions = new Map<string, string[]>()
  for (const file of files) {
    const rel = relative(REPO, file).split('\\').join('/')
    const hits = readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => (PATTERN.test(line) ? [`${rel}:${index + 1}: ${line.trim()}`] : []))
    if (hits.length > 0) mentions.set(rel, hits)
  }

  it('扫过的文件不是空集；白名单之外一处都没有', () => {
    expect(files.length).toBeGreaterThan(200)
    const offenders = [...mentions]
      .filter(([rel]) => !rel.startsWith(FROZEN_PREFIX) && !ASSERTS_ABSENCE.includes(rel))
      .flatMap(([, hits]) => hits)
    expect(offenders).toEqual([])
  })

  it('白名单里的每一条都还用得上', () => {
    expect(ASSERTS_ABSENCE.filter((rel) => !mentions.has(rel))).toEqual([])
  })
})
