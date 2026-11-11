// @vitest-environment jsdom
/**
 * 会话图标（侧栏会话行与收件箱的行共用，2026-11-11 S1）—— jsdom：
 *
 *   SIC-1 sessionIconShape 的优先级：定时运行 > bot > 笔记本 > 悬浮 > 有子会话 > 普通
 *   SIC-2 六种形状各自的 `data-session-icon`；`data-run` 停着时没有，在跑时写 agent / resident
 *   SIC-3 普通会话（一片对话框）：颜色 / 实心 / 呼吸的矩阵 —— agent 蓝色呼吸、resident 绿色不动、停着选中蓝色实心
 *   SIC-4 有子会话（两片）：停着线框，选中 / 在跑换实心版
 *   SIC-5 身份图标（定时运行 / bot / 笔记本 / 悬浮）：从不实心，只换颜色；悬浮停着也是蓝的
 *   SIC-6 label → svg 里的 `<title>`；className 与颜色 class 并存；size → width
 *
 * SessionIcon 只从 chat-ui 引一个类型，不用替身。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  SessionIcon,
  sessionIconShape,
  type SessionIconProps,
  type SessionIconShape
} from './SessionIcon'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SessionIconProps> & { shape: SessionIconShape }): SVGElement {
  act(() => root.render(createElement(SessionIcon, { run: null, ...props })))
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('no svg rendered')
  return svg
}

const has = (svg: SVGElement, cls: string): boolean => svg.classList.contains(cls)

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SIC-1 sessionIconShape priority', () => {
  it.each<[string, Parameters<typeof sessionIconShape>[0], SessionIconShape]>([
    [
      'every flag and subCount 3',
      { isTriggerRun: true, isBot: true, isNotebook: true, isPinned: true, subCount: 3 },
      'trigger'
    ],
    ['bot + notebook + pinned', { isBot: true, isNotebook: true, isPinned: true }, 'bot'],
    ['notebook + pinned', { isNotebook: true, isPinned: true }, 'notebook'],
    ['pinned + subCount 2', { isPinned: true, subCount: 2 }, 'pinned'],
    ['subCount 1', { subCount: 1 }, 'family'],
    ['subCount 0', { subCount: 0 }, 'chat'],
    ['subCount undefined', {}, 'chat'],
    ['subCount -1', { subCount: -1 }, 'chat']
  ])('SIC-1 %s → %s', (_label, flags, expected) => {
    expect(sessionIconShape(flags)).toBe(expected)
  })
})

describe('SIC-2 data attributes', () => {
  const SHAPES: SessionIconShape[] = ['trigger', 'bot', 'notebook', 'pinned', 'family', 'chat']

  it.each(SHAPES)('SIC-2 %s: data-session-icon names the shape; no data-run when idle', (shape) => {
    const svg = render({ shape, run: null })
    expect(svg.getAttribute('data-session-icon')).toBe(shape)
    expect(svg.hasAttribute('data-run')).toBe(false)
  })

  it.each(SHAPES)('SIC-2 %s: data-run follows the run kind', (shape) => {
    expect(render({ shape, run: 'agent' }).getAttribute('data-run')).toBe('agent')
    expect(render({ shape, run: 'resident' }).getAttribute('data-run')).toBe('resident')
  })
})

describe('SIC-3 the chat shape', () => {
  it.each<[string, Partial<SessionIconProps>, string, string, boolean]>([
    ['idle', {}, 'none', 'text-text-tertiary', false],
    ['active', { active: true }, 'currentColor', 'text-accent', false],
    ['agent', { run: 'agent' }, 'currentColor', 'text-accent', true],
    ['resident', { run: 'resident' }, 'currentColor', 'text-success', false],
    ['active + agent', { active: true, run: 'agent' }, 'currentColor', 'text-accent', true],
    ['active + resident', { active: true, run: 'resident' }, 'currentColor', 'text-success', false]
  ])('SIC-3 %s', (_label, props, fill, color, pulses) => {
    const svg = render({ shape: 'chat', ...props })
    expect(has(svg, 'lucide-message-square')).toBe(true)
    expect(svg.getAttribute('fill')).toBe(fill)
    expect(has(svg, color)).toBe(true)
    expect(has(svg, 'animate-pulse')).toBe(pulses)
    expect(has(svg, 'motion-reduce:animate-none')).toBe(pulses)
    if (color === 'text-success') expect(has(svg, 'text-accent')).toBe(false)
    if (color !== 'text-text-tertiary') expect(has(svg, 'text-text-tertiary')).toBe(false)
  })
})

describe('SIC-4 the family shape', () => {
  it('SIC-4 idle: the outline icon, not filled', () => {
    const svg = render({ shape: 'family' })
    expect(has(svg, 'lucide-messages-square')).toBe(true)
    expect(has(svg, 'lucide-messages-square-solid')).toBe(false)
    expect(svg.getAttribute('fill')).not.toBe('currentColor')
    expect(has(svg, 'text-text-tertiary')).toBe(true)
  })

  it.each<[string, Partial<SessionIconProps>, string, boolean]>([
    ['active', { active: true }, 'text-accent', false],
    ['agent', { run: 'agent' }, 'text-accent', true],
    ['resident', { run: 'resident' }, 'text-success', false]
  ])('SIC-4 %s: the solid icon', (_label, props, color, pulses) => {
    const svg = render({ shape: 'family', ...props })
    expect(has(svg, 'lucide-messages-square-solid')).toBe(true)
    expect(has(svg, 'lucide-messages-square')).toBe(false)
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(has(svg, color)).toBe(true)
    expect(has(svg, 'animate-pulse')).toBe(pulses)
    if (color === 'text-success') expect(has(svg, 'text-accent')).toBe(false)
  })
})

describe('SIC-5 identity shapes', () => {
  const IDENTITIES: Array<[SessionIconShape, string]> = [
    ['trigger', 'lucide-timer'],
    ['bot', 'lucide-bot'],
    ['notebook', 'lucide-file-text'],
    ['pinned', 'lucide-picture-in-picture-2']
  ]
  const STATES: Array<[string, Partial<SessionIconProps>]> = [
    ['idle', {}],
    ['active', { active: true }],
    ['agent', { run: 'agent' }],
    ['resident', { run: 'resident' }]
  ]

  describe.each(IDENTITIES)('SIC-5 %s', (shape, iconClass) => {
    it.each(STATES)('%s: identity icon, never filled, colour by state', (state, props) => {
      const svg = render({ shape, ...props })
      expect(has(svg, iconClass)).toBe(true)
      expect(svg.getAttribute('fill')).not.toBe('currentColor')
      if (state === 'agent') {
        expect(has(svg, 'text-accent')).toBe(true)
        expect(has(svg, 'animate-pulse')).toBe(true)
      } else if (state === 'resident') {
        expect(has(svg, 'text-success')).toBe(true)
        expect(has(svg, 'text-accent')).toBe(false)
        expect(has(svg, 'animate-pulse')).toBe(false)
      } else if (state === 'active') {
        expect(has(svg, 'text-accent')).toBe(true)
        expect(has(svg, 'animate-pulse')).toBe(false)
      } else {
        // 停着：灰色 —— 悬浮的除外（它被拎出去了，一直是蓝的）
        const idleColor = shape === 'pinned' ? 'text-accent' : 'text-text-tertiary'
        expect(has(svg, idleColor)).toBe(true)
        expect(has(svg, 'animate-pulse')).toBe(false)
      }
    })
  })
})

describe('SIC-6 label, className and size', () => {
  it('SIC-6 label → a <title> child with that text; no label → no <title>', () => {
    const labelled = render({ shape: 'chat', label: 'X' })
    const title = [...labelled.children].find((el) => el.tagName.toLowerCase() === 'title')
    expect(title?.textContent).toBe('X')

    const bare = render({ shape: 'chat' })
    expect(bare.querySelector('title')).toBeNull()
  })

  it('SIC-6 className is kept beside the colour class', () => {
    const svg = render({ shape: 'chat', className: 'sb-icon', run: 'resident' })
    expect(has(svg, 'sb-icon')).toBe(true)
    expect(has(svg, 'text-success')).toBe(true)
  })

  it('SIC-6 size sets the width', () => {
    expect(render({ shape: 'chat', size: 15 }).getAttribute('width')).toBe('15')
  })
})
