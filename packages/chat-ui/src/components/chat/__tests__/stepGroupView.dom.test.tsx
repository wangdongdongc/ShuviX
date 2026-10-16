// @vitest-environment jsdom
/**
 * StepGroupView 按**分组内容** memo（jsdom）。
 *
 * 每落盘一步，`groupConsecutiveSteps` 整个重建分组数组（每个分组都是新对象），但没变的分组里块还是原来那几个
 * 对象。比较器据此判断：种类、key、`markdownClassName` 相同，块逐个是同一个对象 → 不重渲染。钉的是两面：
 *
 *   SG-1 / SG-3 / SG-4 / SG-5  重建的分组里块没换：子组件一次都不重渲染（中间文本 / 工具 / 思考 / 步骤组）
 *   SG-2 / SG-6 / SG-7         块换了（哪怕内容一样）、步骤组里有一块换了、步骤组变长 / 变短：重渲染
 *   SG-8                       同一个 key 从单个工具变成步骤组（以及反过来）：重渲染
 *   SG-9 / SG-10               key 变了、markdownClassName 变了：重渲染
 *   SG-3 / SG-11               分发本身：工具状态（没回填 = running、空串结果 = done、isError = error）、
 *                              默认正文类名、工具块的字段原样交给 ToolCallBlock
 *
 * 子组件全部换成**不 memo** 的计数桩（StepGroup / ThinkingBlock / ToolCallBlock / MarkdownText）：桩被调一次
 * 就是 StepGroupView 往下渲染了一次，props 一并记下。每一步都 `root.render` 一个新的 StepGroupView 元素 ——
 * 跳没跳过全看比较器。不碰 store，也不需要 i18n。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AssistantBlock, AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'

const calls = vi.hoisted(() => ({
  StepGroup: [] as Array<Record<string, unknown>>,
  ThinkingBlock: [] as Array<Record<string, unknown>>,
  ToolCallBlock: [] as Array<Record<string, unknown>>,
  MarkdownText: [] as Array<Record<string, unknown>>
}))

vi.mock('../StepGroup', async () => {
  const { createElement: h } = await import('react')
  return {
    StepGroup: (props: { blocks: unknown[] }) => {
      calls.StepGroup.push(props)
      return h('div', { 'data-stub': 'step-group', 'data-size': props.blocks.length })
    }
  }
})
vi.mock('../ThinkingBlock', async () => {
  const { createElement: h } = await import('react')
  return {
    ThinkingBlock: (props: { content: string }) => {
      calls.ThinkingBlock.push(props)
      return h('div', { 'data-stub': 'thinking' }, props.content)
    }
  }
})
vi.mock('../ToolCallBlock', async () => {
  const { createElement: h } = await import('react')
  return {
    ToolCallBlock: (props: { toolName: string; status: string }) => {
      calls.ToolCallBlock.push(props)
      return h('div', { 'data-stub': 'tool', 'data-status': props.status }, props.toolName)
    }
  }
})
vi.mock('../markdownComponents', async () => {
  const { createElement: h } = await import('react')
  return {
    MarkdownText: (props: { text: string }) => {
      calls.MarkdownText.push(props)
      return h('span', { 'data-stub': 'markdown' }, props.text)
    }
  }
})

import { StepGroupView } from '../StepGroupView'
import type { BlockGroup, StepBlock } from '../stepGrouping'
import { text, thinking, toolBlock } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function renderGroup(group: BlockGroup, markdownClassName?: string): void {
  act(() =>
    root.render(
      createElement(StepGroupView, {
        group,
        ...(markdownClassName === undefined ? {} : { markdownClassName })
      })
    )
  )
}

const single = (key: string, block: AssistantBlock): BlockGroup => ({ kind: 'single', key, block })
const stepGroup = (key: string, blocks: StepBlock[]): BlockGroup => ({
  kind: 'stepGroup',
  key,
  blocks
})
/** 已成功完成的 read（能进步骤组） */
const done = (id: string, result = `R-${id}`): AssistantToolBlock =>
  toolBlock(id, 'read', { path: `${id}.txt` }, { result })

const stub = (kind: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-stub="${kind}"]`)

beforeEach(() => {
  for (const list of Object.values(calls)) list.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('单个块：块没换就不重渲染（SG-1…SG-4）', () => {
  it('SG-1 中间文本：分组对象重建、块是同一个 → MarkdownText 只渲染过一次', () => {
    const T = text('para 1')
    renderGroup(single('text-0', T))
    renderGroup(single('text-0', T))
    renderGroup({ ...single('text-0', T) })
    expect(calls.MarkdownText).toHaveLength(1)
    expect(calls.MarkdownText[0].text).toBe('para 1')
  })

  it('SG-2 中间文本：同一个 key 换成新块 → 重渲染新文本；内容一样的新块也重渲染（比身份不比内容）', () => {
    renderGroup(single('text-0', text('para 1')))
    renderGroup(single('text-0', text('para 2')))
    expect(calls.MarkdownText.map((p) => p.text)).toEqual(['para 1', 'para 2'])
    expect(stub('markdown')!.textContent).toBe('para 2')

    renderGroup(single('text-0', text('para 2')))
    expect(calls.MarkdownText.map((p) => p.text)).toEqual(['para 1', 'para 2', 'para 2'])
  })

  it('SG-3 单个工具：没回填 running；同一个块重建分组不重渲染；回填 ok → done，isError → error，空串结果 → done', () => {
    const running = toolBlock('t1', 'bash', { command: 'ls' })
    renderGroup(single('t1', running))
    expect(calls.ToolCallBlock.map((p) => p.status)).toEqual(['running'])

    renderGroup(single('t1', running))
    expect(calls.ToolCallBlock).toHaveLength(1)

    renderGroup(single('t1', { ...running, result: 'ok' }))
    renderGroup(single('t1', { ...running, result: 'x', isError: true }))
    renderGroup(single('t1', { ...running, result: '' }))
    expect(calls.ToolCallBlock.map((p) => p.status)).toEqual(['running', 'done', 'error', 'done'])
    expect(stub('tool')!.getAttribute('data-status')).toBe('done')
  })

  it('SG-4 思考：同一个块不重渲染；换成新块重渲染新内容', () => {
    const th = thinking('first thought')
    renderGroup(single('thinking-0', th))
    renderGroup(single('thinking-0', th))
    expect(calls.ThinkingBlock).toHaveLength(1)

    renderGroup(single('thinking-0', thinking('second thought')))
    expect(calls.ThinkingBlock.map((p) => p.content)).toEqual(['first thought', 'second thought'])
    expect(stub('thinking')!.textContent).toBe('second thought')
  })
})

describe('步骤组：逐块比身份（SG-5…SG-7）', () => {
  it('SG-5 新的分组对象 + 新的数组、里面还是 R1 / R2 → StepGroup 只渲染过一次', () => {
    const R1 = done('t1')
    const R2 = done('t2')
    renderGroup(stepGroup('t1', [R1, R2]))
    renderGroup(stepGroup('t1', [R1, R2]))
    expect(calls.StepGroup).toHaveLength(1)
  })

  it('SG-6 第二块换成新对象 → 重渲染，拿到的是新数组', () => {
    const R1 = done('t1')
    renderGroup(stepGroup('t1', [R1, done('t2')]))
    const replaced = [R1, done('t2', 'R-t2-again')]
    renderGroup(stepGroup('t1', replaced))
    expect(calls.StepGroup).toHaveLength(2)
    expect(calls.StepGroup[1].blocks).toBe(replaced)
  })

  it('SG-7 同一个 key 追加 R3 → 重渲染、三块；缩回两块 → 再重渲染', () => {
    const R1 = done('t1')
    const R2 = done('t2')
    const R3 = done('t3')
    renderGroup(stepGroup('t1', [R1, R2]))
    renderGroup(stepGroup('t1', [R1, R2, R3]))
    expect(calls.StepGroup).toHaveLength(2)
    expect(stub('step-group')!.getAttribute('data-size')).toBe('3')

    renderGroup(stepGroup('t1', [R1, R2]))
    expect(calls.StepGroup).toHaveLength(3)
    expect(stub('step-group')!.getAttribute('data-size')).toBe('2')
  })
})

describe('种类 / key / 类名变了（SG-8…SG-10）', () => {
  it('SG-8 同一个 key：单个工具 → 步骤组（块是同一个）重渲染、工具行没了；反过来同样重渲染', () => {
    const R1 = done('t1')
    const R2 = done('t2')
    renderGroup(single('t1', R1))
    expect(stub('tool')).not.toBeNull()

    renderGroup(stepGroup('t1', [R1, R2]))
    expect(calls.StepGroup).toHaveLength(1)
    expect(stub('step-group')).not.toBeNull()
    expect(stub('tool')).toBeNull()

    // 反过来：单个块恰是步骤组的第一块，种类不同照样重渲染
    renderGroup(single('t1', R1))
    expect(calls.ToolCallBlock).toHaveLength(2)
    expect(stub('tool')).not.toBeNull()
    expect(stub('step-group')).toBeNull()
  })

  it('SG-9 同一个块、key 从 text-0 变成 text-2 → 重渲染', () => {
    const T = text('moved')
    renderGroup(single('text-0', T))
    renderGroup(single('text-2', T))
    expect(calls.MarkdownText).toHaveLength(2)
  })

  it('SG-10 markdownClassName 变了 → 重渲染，外层 div 的类名跟着变', () => {
    const T = text('styled')
    renderGroup(single('text-0', T))
    renderGroup(single('text-0', T), 'markdown-body text-xs')
    expect(calls.MarkdownText).toHaveLength(2)
    expect(stub('markdown')!.parentElement!.className).toBe('markdown-body text-xs')

    // 类名不变、块不变：不再渲染
    renderGroup(single('text-0', T), 'markdown-body text-xs')
    expect(calls.MarkdownText).toHaveLength(2)
  })
})

describe('分发本身（SG-11）', () => {
  it('SG-11 中间文本默认套 div.markdown-body.text-sm；工具块的字段原样交给 ToolCallBlock', () => {
    renderGroup(single('text-0', text('plain')))
    const wrapper = stub('markdown')!.parentElement!
    expect(wrapper.tagName).toBe('DIV')
    expect(wrapper.className).toBe('markdown-body text-sm')

    const details = {
      type: 'edit',
      diff: '--- a\n+++ b'
    } as unknown as AssistantToolBlock['details']
    const block = toolBlock('t9', 'edit', { path: 'x.ts' }, { result: 'patched', details })
    renderGroup(single('t9', block))
    const props = calls.ToolCallBlock.at(-1)!
    expect(props.toolName).toBe('edit')
    expect(props.toolCallId).toBe('t9')
    expect(props.args).toBe(block.args)
    expect(props.result).toBe('patched')
    expect(props.details).toBe(details)
    expect(props.status).toBe('done')
  })
})
