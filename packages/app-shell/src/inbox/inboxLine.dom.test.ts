// @vitest-environment jsdom
/**
 * 父会话行尾的子会话圆点（FamilyPips，jsdom）—— 在跑的两种（S1）：
 *
 *   INL-1 次序：等你回答 → 新回复 → 运行中（agent 在干活的写 running、只剩后台命令的写 resident）；
 *         各自的样子：琥珀实心、蓝色实心、蓝色空心呼吸、绿色空心不动
 *   INL-2 给了 onToggle 是一个按钮（aria-expanded 跟 open，点一下调一次）；不给是一枚带读屏文字的图形
 *
 * InboxLine 只从 inboxItems 引类型，不用替身。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Session, SessionRunKind } from '@shuvix/chat-ui'
import type { InboxFamily, InboxItem } from './inboxItems'
import { FamilyPips } from './InboxLine'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function session(id: string, parentId: string | null = 'R'): Session {
  return {
    id,
    title: id,
    projectId: null,
    parentId,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
}
const item = (id: string, run: SessionRunKind | null, asks = 0): InboxItem => ({
  session: session(id),
  asks,
  run,
  commands: []
})

function family(): InboxFamily {
  return {
    root: session('R', null),
    rootItem: null,
    rootUnread: null,
    waiting: [item('W', null, 1)],
    unread: [{ session: session('U'), unread: { since: 1, failed: false, manual: false } }],
    running: [item('A', 'agent'), item('B', 'resident')]
  }
}

function render(props: { open?: boolean; onToggle?: () => void }): void {
  act(() =>
    root.render(
      createElement(FamilyPips, {
        family: family(),
        open: props.open ?? false,
        label: '4 sub-sessions',
        onToggle: props.onToggle
      })
    )
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('INL-1 pip order and look', () => {
  it('INL-1 waiting, unread, running, resident — each in its own style', () => {
    render({})
    const pips = [...container.querySelectorAll<HTMLElement>('[data-pip]')]
    expect(pips.map((p) => p.getAttribute('data-pip'))).toEqual([
      'waiting',
      'unread',
      'running',
      'resident'
    ])
    const [waiting, unread, running, resident] = pips
    expect(waiting.classList.contains('bg-amber-400')).toBe(true)
    expect(unread.classList.contains('bg-accent')).toBe(true)
    for (const cls of ['border-accent', 'animate-pulse', 'motion-reduce:animate-none']) {
      expect(running.classList.contains(cls), cls).toBe(true)
    }
    expect(resident.classList.contains('border-success')).toBe(true)
    expect(resident.classList.contains('animate-pulse')).toBe(false)
    expect(resident.classList.contains('border-accent')).toBe(false)
  })
})

describe('INL-2 toggle or picture', () => {
  it.each([true, false])('INL-2 with onToggle (open %s): a button that toggles once', (open) => {
    const onToggle = vi.fn()
    render({ open, onToggle })
    const button = container.querySelector<HTMLButtonElement>('button[data-inbox-family-toggle]')
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-expanded')).toBe(String(open))
    act(() => button!.click())
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('INL-2 without onToggle: a labelled picture, no button', () => {
    render({})
    expect(container.querySelector('button')).toBeNull()
    const img = container.querySelector<HTMLElement>('span[role="img"]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('aria-label')).toBe('4 sub-sessions')
  })
})
