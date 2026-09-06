/**
 * `stepGrouping` —— 过程区的四段纯逻辑，各自钉住：
 *
 *  - **相邻步骤合并**（`groupConsecutiveSteps`）：思考与「已成功落定」的工具调用（不限同名）
 *    并成一行；运行中 / 出错 / 中间文本都把一段切开；键与顺序是渲染层 key 的依据；
 *  - **同工具判定**（`uniformToolName`）：一段全是同一个工具时合并行保持从前的形态；
 *  - **归纳**（`summarizeSteps`）：按标签聚合计数，首次出现顺序排列；
 *  - **一行文本**（`formatStepSequence`）：`×` 与 ` · ` 两个字符钉死，超长按字符截断。
 *
 * 标签由调用方给（工具显示名 / i18n 文案），这里用静态字符串，不牵扯 store 与 i18n。
 */
import { describe, it, expect, vi } from 'vitest'
import type { AssistantBlock, AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'
import {
  formatStepSequence,
  groupConsecutiveSteps,
  summarizeSteps,
  uniformToolName,
  type BlockGroup,
  type StepBlock,
  type StepSequenceItem
} from '../stepGrouping'

/**
 * 工具块：不传 result 即「仍在执行」（契约：未回填 = running）；
 * `result` 有值即已落定，`isError` 标出错。
 */
function tool(
  id: string,
  name: string,
  opts: { result?: string; isError?: boolean } = {}
): AssistantToolBlock {
  return {
    type: 'tool',
    toolCallId: id,
    toolName: name,
    ...(opts.result !== undefined ? { result: opts.result } : {}),
    ...(opts.isError ? { isError: true } : {})
  }
}

function thinking(text: string): Extract<AssistantBlock, { type: 'thinking' }> {
  return { type: 'thinking', text }
}

function text(text: string): AssistantBlock {
  return { type: 'text', text }
}

/** 分组结果摊平回块序列（顺序不丢的判据） */
const flatten = (groups: BlockGroup[]): AssistantBlock[] =>
  groups.flatMap((g) => (g.kind === 'stepGroup' ? g.blocks : [g.block]))

describe('groupConsecutiveSteps —— 相邻步骤合并', () => {
  it('G-1 两次相邻同名成功调用 → 一个 stepGroup：key 取首个 toolCallId，blocks 保序', () => {
    // 回归：合并行的 key 若取末个 id，第二次调用落定那一瞬 key 会变，行被重挂载
    const a = tool('a', 'read', { result: 'A' })
    const b = tool('b', 'read', { result: 'B' })
    expect(groupConsecutiveSteps([a, b])).toEqual([{ kind: 'stepGroup', key: 'a', blocks: [a, b] }])
  })

  it('G-2 键：段首是思考时取 `thinking-${原始下标}`；落定的单个工具取 toolCallId；文本取 `text-${原始下标}`', () => {
    // 回归：非工具块若按分组后的序号编键，前面的合并会让后面所有块的 key 平移
    const blocks = [thinking('t'), tool('a', 'read', { result: 'A' }), text('x')]
    const groups = groupConsecutiveSteps(blocks)
    expect(groups.map((g) => g.kind)).toEqual(['stepGroup', 'single'])
    expect(groups.map((g) => g.key)).toEqual(['thinking-0', 'text-2'])
    expect(
      groupConsecutiveSteps([text('x'), tool('a', 'read', { result: 'A' })]).map((g) => g.key)
    ).toEqual(['text-0', 'a'])
  })

  it('G-3 未落定（result undefined）的调用切开一段，且自己永不参与合并', () => {
    // 回归：运行中的行被并进计数徽章，就再也看不见「正在跑」了
    const groups = groupConsecutiveSteps([
      tool('a', 'read', { result: 'A' }),
      tool('b', 'read'),
      tool('c', 'read', { result: 'C' })
    ])
    expect(groups.map((g) => g.kind)).toEqual(['single', 'single', 'single'])
    expect(groups.map((g) => g.key)).toEqual(['a', 'b', 'c'])
  })

  it('G-4 出错的调用切开一段、永不合并；异名调用**会**合并（同名不再是条件）', () => {
    // 出错行独立呈现（一次失败不该被数字盖住）
    const withError = groupConsecutiveSteps([
      tool('a', 'read', { result: 'A' }),
      tool('b', 'read', { result: 'ENOENT', isError: true }),
      tool('c', 'read', { result: 'C' })
    ])
    expect(withError.map((g) => g.kind)).toEqual(['single', 'single', 'single'])

    // 这是从「相邻同名合并」推广出来的地方：read / grep / read 并成一段
    const mixedNames = groupConsecutiveSteps([
      tool('a', 'read', { result: 'A' }),
      tool('b', 'grep', { result: 'B' }),
      tool('c', 'read', { result: 'C' })
    ])
    expect(mixedNames).toHaveLength(1)
    expect(mixedNames[0]).toMatchObject({ kind: 'stepGroup', key: 'a' })
    expect(flatten(mixedNames).map((b) => (b.type === 'tool' ? b.toolCallId : b.type))).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('G-5 思考并进段里；中间文本切开一段：文本前后各自成组', () => {
    // 用户的要求本身：文本是模型对人说的话，不是步骤；它前面的思考 + 调用与后面的调用各折一行
    const blocks: AssistantBlock[] = [
      thinking('t'),
      tool('a', 'read', { result: 'A' }),
      tool('b', 'write', { result: 'B' }),
      text('mid'),
      tool('c', 'read', { result: 'C' }),
      tool('d', 'edit', { result: 'D' })
    ]
    const groups = groupConsecutiveSteps(blocks)
    expect(groups.map((g) => g.kind)).toEqual(['stepGroup', 'single', 'stepGroup'])
    expect(groups.map((g) => g.key)).toEqual(['thinking-0', 'text-3', 'c'])
    expect(groups[0].kind === 'stepGroup' && groups[0].blocks.length).toBe(3)
    expect(groups[2].kind === 'stepGroup' && groups[2].blocks.length).toBe(2)
    expect(flatten(groups)).toEqual(blocks)
  })

  it('G-6 单个落定步骤不成组（一行并成一行只多一枚徽章）；空输入回空', () => {
    expect(groupConsecutiveSteps([])).toEqual([])
    expect(groupConsecutiveSteps([thinking('t')]).map((g) => g.kind)).toEqual(['single'])
    expect(groupConsecutiveSteps([tool('a', 'read', { result: 'A' })]).map((g) => g.kind)).toEqual([
      'single'
    ])
    // 被文本隔开的两个单步各自还是单步
    expect(
      groupConsecutiveSteps([thinking('t'), text('x'), tool('a', 'read', { result: 'A' })]).map(
        (g) => g.kind
      )
    ).toEqual(['single', 'single', 'single'])
  })

  it('G-7 result 为空串算已落定、可合并（契约：只有 undefined 才是运行中，不按真值判）', () => {
    // 回归：只交回图片的工具投影出的 result 是空串，按真值判会让它永远「运行中」且永不合并
    const groups = groupConsecutiveSteps([
      tool('a', 'read', { result: '' }),
      tool('b', 'read', { result: 'B' })
    ])
    expect(groups.map((g) => g.kind)).toEqual(['stepGroup'])
  })
})

describe('uniformToolName —— 一段是否全是同一个工具', () => {
  it('U-1 全是同一个工具 → 该工具名（合并行保持从前的图标 + 工具名形态）', () => {
    expect(
      uniformToolName([tool('a', 'read', { result: 'A' }), tool('b', 'read', { result: 'B' })])
    ).toBe('read')
  })

  it('U-2 混着不同工具 → null', () => {
    expect(
      uniformToolName([tool('a', 'read', { result: 'A' }), tool('b', 'grep', { result: 'B' })])
    ).toBeNull()
  })

  it('U-3 混着思考 → null（哪怕工具都同名）', () => {
    const blocks: StepBlock[] = [
      thinking('t'),
      tool('a', 'read', { result: 'A' }),
      tool('b', 'read', { result: 'B' })
    ]
    expect(uniformToolName(blocks)).toBeNull()
  })

  it('U-4 空段 → null', () => {
    expect(uniformToolName([])).toBeNull()
  })
})

describe('summarizeSteps —— 每种步骤各几次', () => {
  const labelOf = (b: StepBlock): string => (b.type === 'tool' ? b.toolName : b.type)

  it('S-1 空输入 → []', () => {
    expect(summarizeSteps([], labelOf)).toEqual([])
  })

  it('S-2 各不相同的标签按出现顺序排列；labelOf 对每块按序恰调一次；不改写输入', () => {
    const blocks: StepBlock[] = [
      thinking('t'),
      tool('a', 'read', { result: 'A' }),
      tool('b', 'grep', { result: 'B' })
    ]
    const snapshot = JSON.parse(JSON.stringify(blocks)) as StepBlock[]
    const spy = vi.fn(labelOf)

    expect(summarizeSteps(blocks, spy)).toEqual([
      { label: 'thinking', count: 1 },
      { label: 'read', count: 1 },
      { label: 'grep', count: 1 }
    ])
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy.mock.calls.map((c) => c[0])).toEqual(blocks)
    expect(blocks).toEqual(snapshot)
  })

  it('S-3 同标签不论是否相邻都归到一项，位置取首次出现处', () => {
    // 回归：按相邻去重的话，「思考 → 调用 → 思考 → 调用」交替的过程会吐出一串重复标签
    expect(
      summarizeSteps(
        [
          tool('a', 'read', { result: 'A' }),
          tool('b', 'read', { result: 'B' }),
          tool('c', 'read', { result: 'C' }),
          tool('d', 'grep', { result: 'D' }),
          tool('e', 'read', { result: 'E' })
        ],
        labelOf
      )
    ).toEqual([
      { label: 'read', count: 4 },
      { label: 'grep', count: 1 }
    ])
    // 交替的思考与调用：两项而不是五项
    expect(
      summarizeSteps(
        [
          thinking('t1'),
          tool('a', 'bash', { result: 'A' }),
          thinking('t2'),
          tool('b', 'bash', { result: 'B' }),
          thinking('t3')
        ],
        labelOf
      )
    ).toEqual([
      { label: 'thinking', count: 3 },
      { label: 'bash', count: 2 }
    ])
  })

  it('S-4 归并按标签字符串判：两个异名工具映到同一标签就归到一项；两个思考也归到一项', () => {
    // 归纳只认标签 —— 显示名相同的两个工具在摘要里就是同一种步骤
    expect(
      summarizeSteps(
        [tool('a', 'read', { result: 'A' }), tool('b', 'ls', { result: 'B' })],
        () => '文件'
      )
    ).toEqual([{ label: '文件', count: 2 }])
    expect(summarizeSteps([thinking('t1'), thinking('t2')], labelOf)).toEqual([
      { label: 'thinking', count: 2 }
    ])
  })
})

describe('formatStepSequence —— 步骤摘要 → 一行文本', () => {
  const step = (label: string, count = 1): StepSequenceItem => ({ label, count })

  it('F-1 空序列 → 空串', () => {
    expect(formatStepSequence([])).toBe('')
  })

  it('F-2 计数大于 1 才带 ×N，项间用「 · 」连接：思考 · 阅读 ×3 · 搜索内容', () => {
    // 钉死两个字符：`×`（U+00D7，不是字母 x）与 ` · `（空格 U+00B7 空格）
    expect(formatStepSequence([step('思考'), step('阅读', 3), step('搜索内容')])).toBe(
      '思考 · 阅读 ×3 · 搜索内容'
    )
    expect(formatStepSequence([step('阅读', 3)])).toContain('×')
    expect(formatStepSequence([step('a'), step('b')])).toBe('a · b')
  })

  it('F-3 缺省上限 60 的边界：恰 60 字符原样；61 字符切到 57 + 「...」', () => {
    const sixty = 'x'.repeat(60)
    expect(formatStepSequence([step(sixty)])).toBe(sixty)

    const sixtyOne = 'y'.repeat(61)
    const clipped = formatStepSequence([step(sixtyOne)])
    expect(clipped).toBe('y'.repeat(57) + '...')
    expect(clipped).toHaveLength(60)
  })

  it('F-4 上限作用在拼接后的整串上，且 maxLen 参数生效', () => {
    // 'aaaa · bbbb' 共 11 字符，maxLen=10 → 切到 7 字符 'aaaa · ' 再补 '...'
    expect(formatStepSequence([step('aaaa'), step('bbbb')], 10)).toBe('aaaa · ...')
    // 单项没超、整串才超 —— 截的是整串
    expect(formatStepSequence([step('aaaa'), step('bbbb')], 11)).toBe('aaaa · bbbb')
  })
})
