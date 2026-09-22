/**
 * DPO —— 桌面这一层给共享内核注入的那个落盘口（fs 写 `<userData>/tool_results/<会话>/<调用>.txt`），
 * 以及**要不要注入**这个开关（`spill`）。
 *
 * 分界只有一条，但它决定模型看到的是指路还是死路：落盘之后正文里写的是「全文在这个路径，用 read
 * 取」—— 手里没有 read 的 agent 取不回来，于是宿主可以按 agent 关掉落盘，让它至少拿到截断上限
 * 那么多正文。`spill: false` 必须**连目录都不建**：`getToolResultsDir` 一被调用就会 mkdir，
 * 目录不存在本身就是「那个口没被碰过」的证据。
 *
 * 不 mock fs（要验的正是「文件里到底是什么」），只按 tools/__tests__/read.test.ts 的惯例把
 * electron 的 `app.getPath` 指到一个临时 userData；每个用例用各自的会话 id，末尾整体删掉。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

/** 假 userData —— 落盘走真实的 utils/paths.ts（getToolResultsDir） */
const USER_DATA_DIR = join(tmpdir(), `shuvix-dpo-test-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA_DIR, getVersion: () => '9.9.9' }
}))

import {
  truncateMiddle,
  truncateHead,
  truncateTail,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '@shuvix/agent-runtime'
import { processToolOutput, spillFileName } from '../processToolOutput'

const byteLen = (s: string): number => new TextEncoder().encode(s).length
const resultsDir = (sessionId: string): string => join(USER_DATA_DIR, 'tool_results', sessionId)

/** 3000 行、掺中文与 emoji（落盘要逐字，编码不能在路上被改写） */
const EMOJI = String.fromCodePoint(0x1f600)
const BIG = Array.from(
  { length: 3000 },
  (_, i) => `行${String(i).padStart(4, '0')} ${EMOJI} payload-${i}`
).join('\n')
/** 150 行 × 约 100 字节 —— 缺省上限内，只有调用方自带上限时才超 */
const MID = Array.from({ length: 150 }, (_, i) =>
  `m${String(i).padStart(3, '0')}`.padEnd(100, 'w')
).join('\n')

const header = (full: string): string =>
  `[Output truncated: ${full.split('\n').length} lines / ${formatSize(byteLen(full))}]`

/** 表头 / 指路之后的正文（最后一个空行之后的全部） */
const bodyOf = (text: string): string => text.slice(text.indexOf('\n\n') + 2)

afterAll(() => rmSync(USER_DATA_DIR, { recursive: true, force: true }))

describe('DPO 缺省就落盘', () => {
  it('DPO-1 不传 spill → 文件里逐字是全文，正文里写的是那个绝对路径 + 用 Read 取', async () => {
    const sid = 'dpo-1'
    const r = await processToolOutput({
      sessionId: sid,
      toolCallId: 'call_dpo1',
      fullText: BIG,
      strategy: 'middle'
    })

    const file = join(resultsDir(sid), 'call_dpo1.txt')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(BIG)
    expect(r.persisted).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain(`[Full output saved to: ${file}]`)
    expect(r.text).toMatch(/Read tool/i)
  })

  it('DPO-2 spill: true 与不传 spill 同义', async () => {
    const sid = 'dpo-2'
    const r = await processToolOutput({
      sessionId: sid,
      toolCallId: 'call_dpo2',
      fullText: BIG,
      strategy: 'middle',
      spill: true
    })

    const file = join(resultsDir(sid), 'call_dpo2.txt')
    expect(readFileSync(file, 'utf-8')).toBe(BIG)
    expect(r.persisted).toBe(true)
    expect(r.text).toContain(`[Full output saved to: ${file}]`)
  })
})

describe('DPO spill: false —— 只在内存里截断', () => {
  it('DPO-3 超限：不建目录、不指路，正文恰是 truncateMiddle 的结果', async () => {
    const sid = 'dpo-3'
    const r = await processToolOutput({
      sessionId: sid,
      toolCallId: 'call_dpo3',
      fullText: BIG,
      strategy: 'middle',
      spill: false
    })

    // getToolResultsDir 一被调用就会建目录 —— 目录不存在即证明那个口没被碰过
    expect(existsSync(resultsDir(sid))).toBe(false)
    expect(r.truncated).toBe(true)
    expect(r.persisted).toBe(false)
    expect(r.text).toBe(
      `${header(BIG)}\n\n${truncateMiddle(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )
    expect(r.text).not.toContain('Full output saved')
    expect(r.text).not.toMatch(/Read tool/i)
    expect(r.text).not.toContain('IMPORTANT')
  })

  it('DPO-4 未超限：文本原样，同样不建目录', async () => {
    const sid = 'dpo-4'
    const r = await processToolOutput({
      sessionId: sid,
      toolCallId: 'call_dpo4',
      fullText: MID,
      strategy: 'middle',
      spill: false
    })

    expect(r.text).toBe(MID)
    expect(r.truncated).toBe(false)
    expect(r.persisted).toBe(false)
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('DPO-5 spill: true 但未超限 → 也不建目录（没超限根本走不到落盘那一步）', async () => {
    const sid = 'dpo-5'
    const r = await processToolOutput({
      sessionId: sid,
      toolCallId: 'call_dpo5',
      fullText: MID,
      strategy: 'middle',
      spill: true
    })

    expect(r.text).toBe(MID)
    expect(r.truncated).toBe(false)
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('DPO-8 strategy tail / head 照常生效', async () => {
    const tail = await processToolOutput({
      sessionId: 'dpo-8a',
      toolCallId: 'call_dpo8a',
      fullText: BIG,
      strategy: 'tail',
      spill: false
    })
    expect(tail.text).toBe(
      `${header(BIG)}\n\n${truncateTail(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )

    const head = await processToolOutput({
      sessionId: 'dpo-8b',
      toolCallId: 'call_dpo8b',
      fullText: BIG,
      strategy: 'head',
      spill: false
    })
    expect(head.text).toBe(
      `${header(BIG)}\n\n${truncateHead(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )
  })
})

describe('DPO 工具自带的上限', () => {
  it('DPO-6 maxLines / maxBytes 在两种模式下都生效', async () => {
    // 缺省上限下这段根本不算超限
    expect(
      (
        await processToolOutput({
          sessionId: 'dpo-6pre',
          toolCallId: 'call_pre',
          fullText: MID,
          strategy: 'middle',
          spill: false
        })
      ).truncated
    ).toBe(false)

    const memory = await processToolOutput({
      sessionId: 'dpo-6a',
      toolCallId: 'call_dpo6a',
      fullText: MID,
      strategy: 'middle',
      maxLines: 100,
      maxBytes: 4096,
      spill: false
    })
    expect(memory.truncated).toBe(true)
    expect(existsSync(resultsDir('dpo-6a'))).toBe(false)
    expect(byteLen(bodyOf(memory.text))).toBeLessThanOrEqual(4096)

    const spilled = await processToolOutput({
      sessionId: 'dpo-6b',
      toolCallId: 'call_dpo6b',
      fullText: MID,
      strategy: 'middle',
      maxLines: 100,
      maxBytes: 4096,
      spill: true
    })
    expect(spilled.persisted).toBe(true)
    expect(readFileSync(join(resultsDir('dpo-6b'), 'call_dpo6b.txt'), 'utf-8')).toBe(MID)
    // 预览再按 min(200, maxLines) / min(10240, maxBytes) 收一次
    expect(byteLen(bodyOf(spilled.text))).toBeLessThanOrEqual(4096)
  })
})

describe('DPO 落盘失败', () => {
  it('DPO-7 写不进去（会话目录位置上是个普通文件）→ 退回内存截断，不指路', async () => {
    const sid = 'dpo-7'
    mkdirSync(join(USER_DATA_DIR, 'tool_results'), { recursive: true })
    writeFileSync(resultsDir(sid), 'not a directory', 'utf-8')

    const r = await processToolOutput({
      sessionId: sid,
      toolCallId: 'call_dpo7',
      fullText: BIG,
      strategy: 'middle',
      spill: true
    })

    expect(r.persisted).toBe(false)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe(
      `${header(BIG)}\n\n${truncateMiddle(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )
    expect(r.text).not.toContain('Full output saved')
  })
})

describe('SFN spillFileName —— toolCallId 来自模型提供商，不能原样拼进路径', () => {
  it('SFN-1 正常的 id 原样保留', () => {
    expect(spillFileName('call_abc-1')).toBe('call_abc-1.txt')
  })

  it('SFN-2 带 .. 与 / 的 id 拼出来的路径仍在会话目录里', () => {
    const dir = resultsDir('sfn-2')
    const full = resolve(join(dir, spillFileName('../../x')))
    expect(full.startsWith(resolve(dir) + sep)).toBe(true)
    expect(spillFileName('../../x')).not.toContain('/')
    expect(spillFileName('../../x')).not.toContain('..')
  })

  it('SFN-3 分隔符换成下划线', () => {
    expect(spillFileName('a/b')).toBe('a_b.txt')
  })

  it('SFN-4 超长 id 截到 128 个字符', () => {
    const name = spillFileName('z'.repeat(500))
    expect(name).toBe(`${'z'.repeat(128)}.txt`)
  })

  it('SFN-5 空 id 有兜底名', () => {
    expect(spillFileName('')).toBe('tool-call.txt')
  })
})
