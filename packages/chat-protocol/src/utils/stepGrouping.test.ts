/**
 * 折叠规则挪到 chat-protocol（docs/sub-session-design.md §19.9 工作包 4）—— 界面的 StepGroup 与主进程的子会话大纲
 * 共用这一份。规则本身的细目由 chat-ui 原有的 `components/chat/__tests__/stepGrouping.test.ts` 原样钉着（它经 chat-ui
 * 的转出引用跑，挪动之后一字未改）；这里只钉两件挪动本身带来的事：
 *   - chat-ui 的旧路径转出的是**同一份实现**（不是一份拷贝 —— 拷贝会让界面与大纲的折叠悄悄分叉）；
 *   - 新家里的规则与 `clipLine` 的语义（大纲直接从这里引）。
 */
import { describe, expect, it } from 'vitest'
import type { AssistantBlock, AssistantToolBlock } from '../types/chatMessage'
import * as protocolSteps from './stepGrouping'
import * as protocolClip from './clipLine'
import * as uiSteps from '../../../chat-ui/src/components/chat/stepGrouping'
import * as uiClip from '../../../chat-ui/src/utils/clipLine'

const ok = (id: string, name = 'read', result = 'ok'): AssistantToolBlock => ({
  type: 'tool',
  toolCallId: id,
  toolName: name,
  args: {},
  result
})

describe('SG —— 挪动之后只有一份', () => {
  it('WP4-102 chat-ui 原路径转出的就是 chat-protocol 的同一批函数（===）', () => {
    expect(uiSteps.groupConsecutiveSteps).toBe(protocolSteps.groupConsecutiveSteps)
    expect(uiSteps.uniformToolName).toBe(protocolSteps.uniformToolName)
    expect(uiSteps.summarizeSteps).toBe(protocolSteps.summarizeSteps)
    expect(uiSteps.formatStepSequence).toBe(protocolSteps.formatStepSequence)
    expect(uiClip.clipLine).toBe(protocolClip.clipLine)
  })
})

describe('SG —— clipLine', () => {
  const { clipLine } = protocolClip

  it('WP4-103 长度 ≤ max 原样；超过就切到 max-3 补「...」，总长恰为 max', () => {
    expect(clipLine('', 5)).toBe('')
    expect(clipLine('abcde', 5)).toBe('abcde')
    expect(clipLine('abcdef', 5)).toBe('ab...')
    expect(clipLine('abcdef', 5)).toHaveLength(5)
    const long = 'x'.repeat(1000)
    for (const max of [3, 10, 60, 80, 400]) {
      expect(clipLine(long, max)).toHaveLength(max)
      expect(clipLine(long, max).endsWith('...')).toBe(true)
    }
  })
})

describe('SG —— 新家里的规则（大纲直接引用的那一份）', () => {
  const { groupConsecutiveSteps, uniformToolName, summarizeSteps, formatStepSequence } =
    protocolSteps

  /** 分组 → 每组覆盖的下标段（`single` 是一个下标） */
  const spans = (blocks: AssistantBlock[]): string[] => {
    let i = 0
    return groupConsecutiveSteps(blocks).map((g) => {
      const n = g.kind === 'single' ? 1 : g.blocks.length
      const span = n === 1 ? `${g.kind}:${i}` : `${g.kind}:${i}-${i + n - 1}`
      i += n
      return span
    })
  }

  it('思考与已完成的调用相邻成段；未回填 / 出错 / 正文 / 空工具名切开；单个步骤不成段', () => {
    const blocks: AssistantBlock[] = [
      { type: 'thinking', text: 't' },
      ok('a'),
      ok('b', 'grep'),
      { type: 'tool', toolCallId: 'c', toolName: 'bash', args: {} },
      ok('d'),
      { type: 'tool', toolCallId: 'e', toolName: 'bash', args: {}, result: 'x', isError: true },
      ok('f'),
      ok('g'),
      { type: 'text', text: 'mid' },
      ok('h', ''),
      ok('i'),
      ok('j', 'read', '')
    ]
    expect(spans(blocks)).toEqual([
      'stepGroup:0-2',
      'single:3',
      'single:4',
      'single:5',
      'stepGroup:6-7',
      'single:8',
      'single:9',
      'stepGroup:10-11'
    ])
  })

  it('uniformToolName / summarizeSteps / formatStepSequence 的形状与界面用的一致', () => {
    const steps = [ok('a'), ok('b'), ok('c', 'grep')] as Parameters<typeof uniformToolName>[0]
    expect(uniformToolName(steps)).toBeNull()
    expect(uniformToolName([ok('a'), ok('b')])).toBe('read')
    const seq = summarizeSteps(steps, (b) => (b.type === 'tool' ? b.toolName : 'think'))
    expect(seq).toEqual([
      { label: 'read', count: 2 },
      { label: 'grep', count: 1 }
    ])
    expect(formatStepSequence(seq)).toBe('read ×2 · grep')
    expect(formatStepSequence([{ label: 'x'.repeat(100), count: 1 }])).toHaveLength(60)
    expect(formatStepSequence([{ label: 'x'.repeat(100), count: 1 }], 80)).toHaveLength(80)
  })
})
