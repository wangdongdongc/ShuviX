// @vitest-environment jsdom
/**
 * 属性卡里的「ShuviX 设置」条（FrontmatterMetaStrip，jsdom）—— 现在只放内置安全策略与 hook 的**停用开关**
 * （用户裁决 2026-10-10：能补进 frontmatter 的键就在卡片自己的行上改，见 FrontmatterFillField；这条只放
 * 文件里根本没有对应键的设置）。
 *
 * 数据来自 ChatApi `mdMeta`（可控替身，背后一块假存储）：get 回这条笔记的视图（`enabled` 只有能停用的对象才有），
 * setEnabled 写库。`useAppEvent` 换成把处理函数收起来的桩：侧栏行菜单是同一个开关，那边改了这边靠
 * `hook.changed` / `policy.changed` 重查。契约：
 *   - MS-1 什么都不渲染：宿主没实现 mdMeta / get 回 null、失败、还没回来 / 视图没有 enabled / 没有 id；
 *   - MS-2…4 一行开关（role=switch、aria-checked、data-state）、停用时一句说明（hook / 策略各一句），
 *     没有补缺行、id、分配 / 换新按钮；
 *   - MS-5…7 点一下 → setEnabled 恰一次、再重查；乐观更新直到一份**新的**视图到来（不闪）；失败亮告警；
 *   - MS-8 侧栏改了（事件）→ 重查、开关跟着变；MS-9…11 告警、在途再点、换会话。
 *
 * useMdMetaView 按会话缓存视图（模块级、清不掉）—— 每条用例用独占的会话 id。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { MdMetaNoteView, MdMetaWriteResult } from '@shuvix/chat-protocol/mdMeta'
import type { FrontmatterMetaStripProps } from './FrontmatterMetaStrip'

type GetFn = (p: { sessionId: string }) => Promise<MdMetaNoteView | null>
type SetEnabledFn = (p: { objectId: string; enabled: boolean }) => Promise<MdMetaWriteResult>

const host = vi.hoisted(() => ({
  api: {} as { mdMeta?: unknown },
  /** useAppEvent 收到的处理函数（按事件类型，最近一次渲染的那个） */
  events: new Map<string, () => void>()
}))

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => host.api,
  useAppEvent: (type: string, handler: () => void) => {
    host.events.set(type, handler)
  }
}))

import { FrontmatterMetaStrip } from './FrontmatterMetaStrip'
import { resetMetaWritesForTests } from './metaWriteQueue'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const HOOK = 'hook:builtin:auto-title'

/** 假存储：get 按它回视图（每次一个新对象），setEnabled 改它 */
let backend: {
  kind: 'hook' | 'policy' | 'agent'
  objectId: string | null
  enabled?: boolean
  warnings: string[]
}
let mdMeta: {
  get: ReturnType<typeof vi.fn<GetFn>>
  setEnabled: ReturnType<typeof vi.fn<SetEnabledFn>>
}
let container: HTMLDivElement
let root: Root
let S: string
let seq = 0
const nextSession = (): string => `ms-${++seq}`

const viewNow = (): MdMetaNoteView => ({
  kind: backend.kind,
  objectId: backend.objectId,
  idStatus: backend.objectId ? 'ok' : 'none',
  fillKeys: [],
  fill: {},
  declared: [],
  warnings: [...backend.warnings],
  readOnly: true,
  ...(backend.enabled === undefined ? {} : { enabled: backend.enabled })
})

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(over: Partial<FrontmatterMetaStripProps> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(FrontmatterMetaStrip, { sessionId: S, ...over }))
  })
  await flush()
}

const q = (sel: string): Element | null => container.querySelector(sel)
const qa = (sel: string): Element[] => [...container.querySelectorAll(sel)]
const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts)
const toggle = (): HTMLButtonElement => {
  const el = q('.cm-shuvix-fmcard-meta-toggle') as HTMLButtonElement | null
  if (!el) throw new Error('toggle not rendered')
  return el
}
const state = (): string | null => toggle().getAttribute('data-state')
const disabledNote = (): string | null => q('.cm-shuvix-fmcard-meta-disabled')?.textContent ?? null
const warnings = (): string[] =>
  qa('.cm-shuvix-fmcard-meta-warning').map((w) => w.textContent ?? '')

async function clickToggle(settle = true): Promise<void> {
  const el = toggle()
  await act(async () => {
    el.click()
  })
  if (settle) await flush()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetMetaWritesForTests()
  S = nextSession()
  host.events.clear()
  backend = { kind: 'hook', objectId: HOOK, enabled: true, warnings: [] }
  mdMeta = {
    get: vi.fn<GetFn>(async () => viewNow()),
    setEnabled: vi.fn<SetEnabledFn>(async ({ enabled }) => {
      backend.enabled = enabled
      return { success: true }
    })
  }
  host.api = { mdMeta }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('FrontmatterMetaStrip —— 不出现的情形', () => {
  it('MS-1 宿主没实现 mdMeta / get 回 null / get 失败 / get 还没回来 / 视图没有 enabled / 有 enabled 但没有 id → 什么都不渲染', async () => {
    host.api = {}
    await render()
    expect(container.innerHTML).toBe('')

    host.api = { mdMeta }
    mdMeta.get.mockResolvedValueOnce(null)
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')

    mdMeta.get.mockRejectedValueOnce(new Error('ipc down'))
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')

    mdMeta.get.mockReturnValueOnce(new Promise(() => {}))
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')

    // agent 视图 / 用户 hook（UUID）：没有 enabled 字段
    backend = { kind: 'agent', objectId: 'agent:builtin:explore', warnings: [] }
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')
    backend = { kind: 'hook', objectId: '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10', warnings: [] }
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')

    backend = { kind: 'hook', objectId: null, enabled: true, warnings: [] }
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')
  })
})

describe('FrontmatterMetaStrip —— 开关', () => {
  it('MS-2 启用着的内置 hook：标题 + 问号说明 + 恰一行 enabled（标签 metaEnabled）；开关 role=switch、aria-checked=true、data-state=on；没有停用说明', async () => {
    await render()
    const strip = q('.cm-shuvix-fmcard-meta-strip')
    expect(strip).not.toBeNull()
    expect(strip!.textContent).toContain(t('notebook.frontmatter.metaTitle'))
    expect(q('[data-info-hint]')).not.toBeNull()
    const rows = qa('.cm-shuvix-fmcard-meta-row')
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(['enabled'])
    expect(rows[0].textContent).toContain(t('notebook.frontmatter.metaEnabled'))
    expect(toggle().getAttribute('role')).toBe('switch')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(state()).toBe('on')
    expect(disabledNote()).toBeNull()
  })

  it('S-15 问号聚焦 → 出说明气泡，文字是 metaHint', async () => {
    await render()
    const hint = q('[data-info-hint]') as HTMLButtonElement | null
    expect(hint).not.toBeNull()
    await act(async () => {
      hint!.focus()
    })
    expect(document.querySelector('[data-info-tip]')?.textContent).toBe(
      t('notebook.frontmatter.metaHint')
    )
  })

  it('MS-3 停用着 → data-state=off、aria-checked=false，带一句停用说明；hook 与策略各用各的', async () => {
    backend.enabled = false
    await render()
    expect(state()).toBe('off')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(disabledNote()).toBe(t('notebook.frontmatter.metaHookDisabled'))

    backend = {
      kind: 'policy',
      objectId: 'policy:builtin:ask-on-command',
      enabled: false,
      warnings: []
    }
    await render({ sessionId: nextSession() })
    expect(disabledNote()).toBe(t('notebook.frontmatter.metaPolicyDisabled'))
  })

  it('MS-4 只有开关：没有下拉、没有补缺行、不显示 id、没有分配 / 换新；按钮只有开关与问号', async () => {
    await render()
    expect(q('select')).toBeNull()
    expect(q('.cm-shuvix-fmcard-fill')).toBeNull()
    expect(container.textContent).not.toContain(HOOK)
    expect(q('.cm-shuvix-fmcard-meta-regenerate')).toBeNull()
    const buttons = qa('button')
    expect(buttons).toHaveLength(2)
    expect(buttons.filter((b) => b.hasAttribute('data-info-hint'))).toHaveLength(1)
    expect(
      buttons.filter((b) => b.classList.contains('cm-shuvix-fmcard-meta-toggle'))
    ).toHaveLength(1)
  })

  it('SP-13 / MS-9 视图里的每条告警各一个告警块', async () => {
    backend.warnings = ['first problem', 'second problem']
    await render()
    expect(warnings()).toEqual(['first problem', 'second problem'])
  })
})

describe('FrontmatterMetaStrip —— 写入', () => {
  it('MS-5 点一下 → setEnabled 恰一次（视图里的 id、enabled:false），之后再查一次', async () => {
    await render()
    const getsBefore = mdMeta.get.mock.calls.length
    await clickToggle()
    expect(mdMeta.setEnabled).toHaveBeenCalledTimes(1)
    expect(mdMeta.setEnabled).toHaveBeenCalledWith({ objectId: HOOK, enabled: false })
    expect(mdMeta.get.mock.calls.length).toBe(getsBefore + 1)
    expect(state()).toBe('off')
  })

  it('MS-6 乐观更新不闪：setEnabled 挂着 → 立刻 off；写完、重查挂着 → 仍 off；重查回来 false → off；data-state 全程恰是 on, off', async () => {
    await render()
    const states: Array<string | null> = [state()]
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') states.push((r.target as Element).getAttribute('data-state'))
      }
    })
    observer.observe(container, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-state']
    })

    const write = deferred<MdMetaWriteResult>()
    mdMeta.setEnabled.mockImplementationOnce(async ({ enabled }) => {
      const result = await write.promise
      backend.enabled = enabled
      return result
    })
    await clickToggle()
    expect(state()).toBe('off')

    const reget = deferred<MdMetaNoteView | null>()
    mdMeta.get.mockReturnValueOnce(reget.promise)
    write.resolve({ success: true })
    await flush()
    expect(state()).toBe('off')

    reget.resolve(viewNow())
    await flush()
    expect(state()).toBe('off')
    await flush()
    observer.disconnect()
    expect(states).toEqual(['on', 'off'])
  })

  it('MS-7 失败：带 message → 告警里是 message；没有 message → reason；抛错 → 错误信息；重查回 true → 开关回到 on；下一次点击清掉告警', async () => {
    await render()

    mdMeta.setEnabled.mockResolvedValueOnce({
      success: false,
      reason: 'key-not-allowed',
      message: 'not a builtin policy or hook'
    })
    await clickToggle()
    expect(warnings()).toEqual([
      t('notebook.frontmatter.metaWriteFailed', { reason: 'not a builtin policy or hook' })
    ])
    // 库里没变：重查回来的是 true，开关回到 on
    expect(state()).toBe('on')

    mdMeta.setEnabled.mockResolvedValueOnce({ success: false, reason: 'invalid-value' })
    await clickToggle()
    expect(warnings()).toEqual([
      t('notebook.frontmatter.metaWriteFailed', { reason: 'invalid-value' })
    ])

    mdMeta.setEnabled.mockRejectedValueOnce(new Error('ipc down'))
    await clickToggle()
    expect(warnings()).toEqual([t('notebook.frontmatter.metaWriteFailed', { reason: 'ipc down' })])
    expect(state()).toBe('on')

    await clickToggle()
    expect(warnings()).toEqual([])
    expect(state()).toBe('off')
  })

  it('MS-8 侧栏那边改了：hook.changed / policy.changed 的处理函数 → 重查，开关跟着变', async () => {
    await render()
    expect(state()).toBe('on')
    expect(host.events.has('hook.changed')).toBe(true)
    expect(host.events.has('policy.changed')).toBe(true)

    backend.enabled = false
    const gets = mdMeta.get.mock.calls.length
    await act(async () => {
      host.events.get('hook.changed')!()
    })
    await flush()
    expect(mdMeta.get.mock.calls.length).toBe(gets + 1)
    expect(state()).toBe('off')

    backend.enabled = true
    await act(async () => {
      host.events.get('policy.changed')!()
    })
    await flush()
    expect(state()).toBe('on')
  })

  it('MS-10 第一次写入还在路上时再点 → 第二次发的是 enabled:true', async () => {
    await render()
    const write = deferred<MdMetaWriteResult>()
    mdMeta.setEnabled.mockImplementationOnce(() => write.promise)
    await clickToggle()
    expect(state()).toBe('off')
    await clickToggle()
    expect(mdMeta.setEnabled).toHaveBeenCalledTimes(2)
    expect(mdMeta.setEnabled.mock.calls[0][0]).toEqual({ objectId: HOOK, enabled: false })
    expect(mdMeta.setEnabled.mock.calls[1][0]).toEqual({ objectId: HOOK, enabled: true })
    write.resolve({ success: true })
    await flush()
  })

  it('SP-15 / MS-11 换会话 → 按新会话重查', async () => {
    await render()
    expect(mdMeta.get).toHaveBeenLastCalledWith({ sessionId: S })
    const s2 = nextSession()
    await render({ sessionId: s2 })
    expect(mdMeta.get).toHaveBeenLastCalledWith({ sessionId: s2 })
    expect(mdMeta.get).toHaveBeenCalledTimes(2)
  })
})
