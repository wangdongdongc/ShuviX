// @vitest-environment jsdom
/**
 * 属性卡里的「ShuviX 设置」条（FrontmatterMetaStrip，jsdom）—— md 扩展元数据的界面一侧。
 *
 * 数据全来自 ChatApi `mdMeta`（这里是可控替身，背后一块假磁盘 `disk = {id, fill}`）：get 回这条笔记的视图
 * （磁盘上的 id、能补的键、存的值、文件已写的键、告警），setFill / unsetFill 写库（id 对得上才改 `disk.fill`）。
 * 条本身只读缓冲区里的 frontmatter 原文（props.yaml）判断「缓冲区里有没有 id」，与视图里磁盘上的 id 对上
 * 才把库里的值当成这份文件的。写入经组件外的队列（metaWriteQueue，那边另有用例）。
 *
 * 契约（用户裁决 2026-10-10，CLAUDE.md「md extension metadata」：No id → no button）：
 *   - SP-1 / SP-16 什么都不渲染：宿主没实现 mdMeta / get 回 null / get 失败 / 没有可补的键 / get 还没回来 /
 *     缓冲区 YAML 解析不了（自动分配会悄悄换掉一行合法的 id）；
 *   - SP-2 / SP-3 / SP-5 没有 id（或写坏）→ 控件照样出来、没有「分配」按钮；只读编辑器写不进 id → 整条不出现；
 *   - S-1..5 第一次改设置自动分配 id：Saving…、卡片重建（重挂）后照样接着显示、等待期间的编辑并进同一个任务、
 *     组件全卸了任务也照跑、分配不了亮告警；
 *   - SP-6..11 / S-6..10 / S-12..14 就绪、只读、换新 id、写入与失败、磁盘与缓冲区 id 不一致；
 *   - S-11 标题行按钮（问号之外）：没有 id 时一个都没有，有 id 且可编辑时恰是「换新 id」。
 * 行的槽位类名是 `.cm-shuvix-fmcard-meta-slot` —— `.cm-shuvix-fmcard-slot` 是卡片字段槽位的计数钩子，这里不能占。
 *
 * 条与队列都有模块级状态：队列每条用例 reset，条缓存的「上次问到的视图」清不掉 —— 所以每条用例用独占的会话 id。
 * `@shuvix/chat-ui` 整个替掉（getChatApi 交替身；ModelSelect 渲染成空 —— 模型行只看行在不在）。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { MdMetaNoteView, MdMetaWriteResult } from '@shuvix/chat-protocol/mdMeta'
import type { FrontmatterMetaStripProps } from './FrontmatterMetaStrip'

type GetFn = (p: { sessionId: string }) => Promise<MdMetaNoteView | null>
type SetFillFn = (p: {
  sessionId: string
  objectId: string
  key: string
  value: unknown
}) => Promise<MdMetaWriteResult>
type UnsetFillFn = (p: {
  sessionId: string
  objectId: string
  key: string
}) => Promise<MdMetaWriteResult>
interface MdMetaApi {
  get: ReturnType<typeof vi.fn<GetFn>>
  setFill: ReturnType<typeof vi.fn<SetFillFn>>
  unsetFill: ReturnType<typeof vi.fn<UnsetFillFn>>
}

const host = vi.hoisted(() => ({ api: {} as { mdMeta?: unknown } }))

vi.mock('@shuvix/chat-ui', () => ({
  ModelSelect: () => null,
  useModelCatalogStore: () => [],
  getChatApi: () => host.api
}))

import { FrontmatterMetaStrip } from './FrontmatterMetaStrip'
import { resetMetaWritesForTests } from './metaWriteQueue'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const V = '0199d3a2-0000-7000-8000-000000000000'
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MODEL = 'shuvix-model'
const THINKING = 'shuvix-thinking'
const POLL = 300

/** 缓冲区里的 frontmatter 原文；idLine 省略 = 写着 U，null = 没写 id */
const yamlOf = (idLine: string | null = `shuvix-id: ${U}`, extra: string[] = []): string =>
  ['shuvix: agent v1', ...(idLine === null ? [] : [idLine]), 'name: strip-agent', ...extra].join(
    '\n'
  )
const yamlWithId = (id: string): string => yamlOf(`shuvix-id: ${id}`)

const viewOf = (over: Partial<MdMetaNoteView> = {}): MdMetaNoteView => ({
  kind: 'agent',
  objectId: U,
  idStatus: 'ok',
  fillKeys: [MODEL, THINKING],
  fill: {},
  declared: [],
  warnings: [],
  readOnly: false,
  ...over
})

/** 假磁盘：get 按它回视图；setFill / unsetFill 的 id 对得上才改它的 fill */
let disk: { id: string | null; fill: Record<string, unknown> }
/** 视图的其余字段（告警、文件已写的键、只读…） */
let viewExtra: Partial<MdMetaNoteView>
let container: HTMLDivElement
let root: Root
let mdMeta: MdMetaApi
let setObjectId: ReturnType<typeof vi.fn<(id: string) => boolean>>
/** 这条用例的会话 id（每条独占） */
let S: string
let seq = 0
const nextSession = (): string => `sp-${++seq}`
/** 当前渲染的 props（remount 在它上面改） */
let current: FrontmatterMetaStripProps
let mountKey = 0

const diskView = (): MdMetaNoteView =>
  viewOf({
    objectId: disk.id,
    idStatus: disk.id ? 'ok' : 'none',
    fill: { ...disk.fill },
    ...viewExtra
  })

/** 渲染（或以新 props 重渲染，同一个组件实例）条 */
async function render(over: Partial<FrontmatterMetaStripProps> = {}): Promise<void> {
  current = { ...current, ...over }
  await act(async () => {
    root.render(createElement(FrontmatterMetaStrip, { key: mountKey, ...current }))
  })
  await flush()
}

/** 换一个新实例（卡片 widget 重建 = 条卸载重挂）；不 flush —— 有的用例要看第一帧 */
async function remount(over: Partial<FrontmatterMetaStripProps> = {}): Promise<void> {
  current = { ...current, ...over }
  mountKey++
  await act(async () => {
    root.render(createElement(FrontmatterMetaStrip, { key: mountKey, ...current }))
  })
}

/** 让挂起的 promise（get / setFill / 队列）落定并把 setState 刷进 DOM */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 推进假时间（只假 setTimeout）并落定 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush()
}

const fakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

const q = (sel: string): Element | null => container.querySelector(sel)
const qa = (sel: string): Element[] => [...container.querySelectorAll(sel)]
const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts)
const thinkingSelect = (): HTMLSelectElement => {
  const select = q(`.cm-shuvix-fmcard-meta-row[data-key="${THINKING}"] select`)
  if (!select) throw new Error('thinking select not rendered')
  return select as HTMLSelectElement
}
const rowKeys = (): Array<string | null> =>
  qa('.cm-shuvix-fmcard-meta-row').map((r) => r.getAttribute('data-key'))
const warnings = (): string[] =>
  qa('.cm-shuvix-fmcard-meta-warning').map((w) => w.textContent ?? '')
const saving = (): boolean => q('.cm-shuvix-fmcard-meta-saving') !== null
const regenerateButton = (): HTMLButtonElement | null =>
  q('.cm-shuvix-fmcard-meta-regenerate') as HTMLButtonElement | null
/** 标题行里的按钮（设置行之外、问号之外）：`regenerate` 认类名，其余取文字 */
const headerButtons = (): string[] =>
  qa('.cm-shuvix-fmcard-meta-strip button')
    .filter((b) => !b.closest('.cm-shuvix-fmcard-meta-row') && !b.hasAttribute('data-info-hint'))
    .map((b) =>
      b.classList.contains('cm-shuvix-fmcard-meta-regenerate')
        ? 'regenerate'
        : (b.textContent ?? '').trim()
    )

async function choose(value: string): Promise<void> {
  const select = thinkingSelect()
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}
async function click(sel: string): Promise<void> {
  const el = q(sel) as HTMLElement | null
  if (!el) throw new Error(`${sel} not rendered`)
  await act(async () => {
    el.click()
  })
  await flush()
}

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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
  disk = { id: U, fill: {} }
  viewExtra = {}
  mdMeta = {
    get: vi.fn<GetFn>(async () => diskView()),
    setFill: vi.fn<SetFillFn>(async ({ objectId, key, value }) => {
      if (objectId === disk.id) disk.fill = { ...disk.fill, [key]: value }
      return { success: true }
    }),
    unsetFill: vi.fn<UnsetFillFn>(async ({ objectId, key }) => {
      if (objectId === disk.id) {
        const next = { ...disk.fill }
        delete next[key]
        disk.fill = next
      }
      return { success: true }
    })
  }
  host.api = { mdMeta }
  setObjectId = vi.fn<(id: string) => boolean>(() => true)
  current = {
    sessionId: S,
    markerType: 'agent',
    yaml: yamlOf(),
    readOnly: false,
    setObjectId: (id) => setObjectId(id)
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('FrontmatterMetaStrip —— 不出现的情形', () => {
  it('SP-1a 宿主没实现 mdMeta → 什么都不渲染', async () => {
    host.api = {}
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('SP-1b get 回 null / get 失败 / fillKeys 为空 → 什么都不渲染', async () => {
    mdMeta.get.mockResolvedValue(null)
    await render()
    expect(container.innerHTML).toBe('')

    mdMeta.get.mockRejectedValue(new Error('ipc down'))
    await render({ sessionId: nextSession() })
    expect(container.innerHTML).toBe('')

    mdMeta.get.mockResolvedValue(viewOf({ kind: 'bot', fillKeys: [] }))
    await render({ sessionId: nextSession(), markerType: 'bot' })
    expect(container.innerHTML).toBe('')
  })

  it('SP-1c get 还没回来 → 什么都不渲染', async () => {
    mdMeta.get.mockReturnValue(new Promise(() => {}))
    await render()
    expect(mdMeta.get).toHaveBeenCalledWith({ sessionId: S })
    expect(container.innerHTML).toBe('')
  })

  it('SP-16 缓冲区 YAML 解析不了（哪怕里面有一行合法 id）→ 什么都不渲染，也不分配', async () => {
    await render({ yaml: yamlOf(`shuvix-id: ${U}`, ['broken: [unclosed']) })
    expect(container.innerHTML).toBe('')
    expect(setObjectId).not.toHaveBeenCalled()
  })

  it('SP-16b 缓冲区 frontmatter 解析成标量 / 序列（不是映射）→ 什么都不渲染', async () => {
    await render({ yaml: 'just a plain sentence' })
    expect(container.innerHTML).toBe('')
    await render({ sessionId: nextSession(), yaml: '- a\n- b' })
    expect(container.innerHTML).toBe('')
    expect(setObjectId).not.toHaveBeenCalled()
  })
})

describe('FrontmatterMetaStrip —— 没有 id：控件照样出来，没有分配按钮', () => {
  it('SP-2 缓冲区没写 id → 条 + 两行（模型、档位）；磁盘视图里的值不算这份文件的；不显示 id；没有换新 / 别的按钮；没有 Saving… / 告警', async () => {
    disk.fill = { [THINKING]: 'high' }
    await render({ yaml: yamlOf(null) })
    expect(q('.cm-shuvix-fmcard-meta-strip')).not.toBeNull()
    expect(rowKeys()).toEqual([MODEL, THINKING])
    expect(thinkingSelect().value).toBe('')
    expect(thinkingSelect().disabled).toBe(false)
    expect(q('.cm-shuvix-fmcard-meta-id')).toBeNull()
    expect(regenerateButton()).toBeNull()
    expect(headerButtons()).toEqual([])
    expect(q('[data-info-hint]')).not.toBeNull()
    expect(saving()).toBe(false)
    expect(warnings()).toEqual([])
    expect(setObjectId).not.toHaveBeenCalled()
  })

  it('SP-3 缓冲区写坏的 id（shuvix-id: nope）→ 与没有 id 一样；选一档 → setObjectId 拿到一个 UUIDv7', async () => {
    disk.id = null
    await render({ yaml: yamlOf('shuvix-id: nope') })
    expect(rowKeys()).toEqual([MODEL, THINKING])
    expect(q('.cm-shuvix-fmcard-meta-id')).toBeNull()
    expect(headerButtons()).toEqual([])
    expect(thinkingSelect().value).toBe('')

    // 磁盘「立刻」追上：setObjectId 一调就把它写进假磁盘，任务不留到下一条用例
    setObjectId.mockImplementation((id) => {
      disk.id = id
      return true
    })
    await choose('low')
    expect(setObjectId).toHaveBeenCalledTimes(1)
    const id = setObjectId.mock.calls[0][0]
    expect(id).toMatch(V7)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: id,
      key: THINKING,
      value: 'low'
    })
  })

  it('SP-5 只读编辑器 + 没有 id / 写坏的 id → 什么都不渲染（写不进 id，也就存不了设置）', async () => {
    disk.id = null
    await render({ yaml: yamlOf(null), readOnly: true })
    expect(container.innerHTML).toBe('')
    await render({ sessionId: nextSession(), yaml: yamlOf('shuvix-id: nope'), readOnly: true })
    expect(container.innerHTML).toBe('')
  })

  it('S-1 第一次改设置（没有 id）→ 分配一个 UUIDv7、下拉立刻显示新值、Saving…、还没写库；磁盘追上 → setFill 恰一次、Saving… 消失', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    await choose('low')
    expect(setObjectId).toHaveBeenCalledTimes(1)
    const id = setObjectId.mock.calls[0][0]
    expect(id).toMatch(V7)
    expect(thinkingSelect().value).toBe('low')
    expect(q('.cm-shuvix-fmcard-meta-saving')?.textContent).toBe(
      t('notebook.frontmatter.metaSaving')
    )
    expect(mdMeta.setFill).not.toHaveBeenCalled()

    disk.id = id
    await advance(POLL)
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: id,
      key: THINKING,
      value: 'low'
    })
    expect(saving()).toBe(false)
    expect(warnings()).toEqual([])
  })

  it('S-2 等落盘期间卡片重建（新实例，缓冲区已带分配的 id）→ 第一帧就画出来（不等自己的 get）：low、Saving…、id、换新在但禁用；追上后 setFill 一次、Saving… 消失、low 来自库、换新可用；全程只分配一次', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    await choose('low')
    const id = setObjectId.mock.calls[0][0]

    // 重挂实例自己的 get 先压着：它要是画出来了，只能是靠缓存的上次视图
    const held = deferred<MdMetaNoteView | null>()
    mdMeta.get.mockImplementationOnce(() => held.promise)
    await remount({ yaml: yamlWithId(id) })
    expect(rowKeys()).toEqual([MODEL, THINKING])
    expect(thinkingSelect().value).toBe('low')
    expect(saving()).toBe(true)
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(id)
    expect(regenerateButton()).not.toBeNull()
    expect(regenerateButton()!.disabled).toBe(true)

    await act(async () => {
      held.resolve(diskView())
    })
    await flush()
    disk.id = id
    await advance(POLL)
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: id,
      key: THINKING,
      value: 'low'
    })
    expect(saving()).toBe(false)
    expect(thinkingSelect().value).toBe('low')
    expect(disk.fill).toEqual({ [THINKING]: 'low' })
    expect(regenerateButton()!.disabled).toBe(false)
    expect(setObjectId).toHaveBeenCalledTimes(1)
  })

  it('S-3 重挂之后、落盘之前在新实例上再改 → 并进同一个任务：不再分配；只写一次档位，值是后改的 high', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    await choose('low')
    const id = setObjectId.mock.calls[0][0]
    await remount({ yaml: yamlWithId(id) })
    await flush()

    await choose('high')
    expect(thinkingSelect().value).toBe('high')
    expect(setObjectId).toHaveBeenCalledTimes(1)

    disk.id = id
    await advance(POLL)
    expect(setObjectId).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: id,
      key: THINKING,
      value: 'high'
    })
    expect(thinkingSelect().value).toBe('high')
  })

  it('S-4 组件全卸了任务照跑：选完卸载，磁盘追上 → setFill 照调；之后挂上的条没有 Saving…、显示库里的值', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    await choose('low')
    const id = setObjectId.mock.calls[0][0]

    act(() => root.unmount())
    root = createRoot(container)
    disk.id = id
    await advance(POLL)
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: id,
      key: THINKING,
      value: 'low'
    })

    await remount({ yaml: yamlWithId(id) })
    await flush()
    expect(saving()).toBe(false)
    expect(thinkingSelect().value).toBe('low')
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(id)
  })

  it('S-5 setObjectId 回 false → 恰一条「写不进 id」告警、下拉回到未设置、没有 Saving…、不写不轮询', async () => {
    fakeTimers()
    disk.id = null
    setObjectId.mockReturnValue(false)
    await render({ yaml: yamlOf(null) })
    await choose('low')
    expect(warnings()).toEqual([t('notebook.frontmatter.metaCannotAssign')])
    expect(thinkingSelect().value).toBe('')
    expect(saving()).toBe(false)
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    const gets = mdMeta.get.mock.calls.length
    await advance(3000)
    expect(mdMeta.get.mock.calls.length).toBe(gets)
    expect(mdMeta.setFill).not.toHaveBeenCalled()
  })

  it('S-12 等待期间选回「未设置」→ 下拉立刻是空；任务以 unsetFill 收尾、不调 setFill', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    await choose('low')
    const id = setObjectId.mock.calls[0][0]
    await choose('')
    expect(thinkingSelect().value).toBe('')
    expect(saving()).toBe(true)

    disk.id = id
    await advance(POLL)
    expect(mdMeta.unsetFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.unsetFill).toHaveBeenCalledWith({ sessionId: S, objectId: id, key: THINKING })
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    expect(saving()).toBe(false)
  })

  it('S-13 s1 的在途值不出现在 s2 的条里', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    await choose('low')
    const id = setObjectId.mock.calls[0][0]

    const other = document.createElement('div')
    document.body.appendChild(other)
    const otherRoot = createRoot(other)
    await act(async () => {
      otherRoot.render(
        createElement(FrontmatterMetaStrip, { ...current, sessionId: nextSession() })
      )
    })
    await flush()
    const otherSelect = other.querySelector(
      `.cm-shuvix-fmcard-meta-row[data-key="${THINKING}"] select`
    ) as HTMLSelectElement | null
    expect(otherSelect?.value).toBe('')
    expect(other.querySelector('.cm-shuvix-fmcard-meta-saving')).toBeNull()
    act(() => otherRoot.unmount())

    disk.id = id
    await advance(POLL)
  })
})

describe('FrontmatterMetaStrip —— 就绪', () => {
  it('SP-6 缓冲区 id = 磁盘 id → 显示 id；每个可补键一行（同序）；选中存的值；换新 id：一个不同的 UUIDv7，等待期间按钮禁用 + Saving…，落盘后都恢复', async () => {
    fakeTimers()
    disk.fill = { [THINKING]: 'high' }
    await render()
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(U)
    expect(rowKeys()).toEqual([MODEL, THINKING])
    expect(thinkingSelect().value).toBe('high')
    // 行的槽位类名另起：卡片字段槽位的计数钩子 `.cm-shuvix-fmcard-slot` 这里一个都不能有
    expect(qa('.cm-shuvix-fmcard-meta-slot')).toHaveLength(2)
    expect(qa('.cm-shuvix-fmcard-slot')).toEqual([])
    expect(headerButtons()).toEqual(['regenerate'])

    await click('.cm-shuvix-fmcard-meta-regenerate')
    expect(setObjectId).toHaveBeenCalledTimes(1)
    const fresh = setObjectId.mock.calls[0][0]
    expect(fresh).toMatch(V7)
    expect(fresh).not.toBe(U)
    expect(regenerateButton()!.disabled).toBe(true)
    expect(saving()).toBe(true)

    disk.id = fresh
    await advance(POLL)
    expect(regenerateButton()!.disabled).toBe(false)
    expect(saving()).toBe(false)
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    expect(mdMeta.unsetFill).not.toHaveBeenCalled()
  })

  it('SP-7 / S-9 只读编辑器 + 就绪 → 显示 id，没有换新 / 任何标题行按钮；档位下拉可用；选 high → setFill(U)，从不分配', async () => {
    viewExtra = { readOnly: true }
    await render({ readOnly: true })
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(U)
    expect(regenerateButton()).toBeNull()
    expect(headerButtons()).toEqual([])
    expect(thinkingSelect().disabled).toBe(false)

    await choose('high')
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: U,
      key: THINKING,
      value: 'high'
    })
    expect(setObjectId).not.toHaveBeenCalled()
    expect(thinkingSelect().value).toBe('high')
  })

  it('SP-8 缓冲区有 U、磁盘还没有、没有在途任务 → 立刻出行、显示 U、不显示库里的值、没有 Saving…；条自己不轮询', async () => {
    fakeTimers()
    disk = { id: null, fill: { [THINKING]: 'high' } }
    await render()
    expect(rowKeys()).toEqual([MODEL, THINKING])
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(U)
    expect(thinkingSelect().value).toBe('')
    expect(saving()).toBe(false)
    expect(mdMeta.get).toHaveBeenCalledTimes(1)
    await advance(3000)
    expect(mdMeta.get).toHaveBeenCalledTimes(1)
  })

  it('S-10 缓冲区 V、磁盘 U（存着 high）→ 下拉为空、显示 V；同一视图缓冲区换成 U → high', async () => {
    disk.fill = { [THINKING]: 'high' }
    await render({ yaml: yamlWithId(V) })
    expect(thinkingSelect().value).toBe('')
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(V)

    await render({ yaml: yamlWithId(U) })
    expect(thinkingSelect().value).toBe('high')
    expect(q('.cm-shuvix-fmcard-meta-id')?.textContent).toBe(U)
  })

  it('SP-12 文件已写的键 → 只在那一行下注「以文件为准」', async () => {
    viewExtra = { declared: [THINKING] }
    await render()
    const declared = qa('.cm-shuvix-fmcard-meta-declared')
    expect(declared).toHaveLength(1)
    expect(declared[0].closest('.cm-shuvix-fmcard-meta-row')?.getAttribute('data-key')).toBe(
      THINKING
    )
    expect(declared[0].textContent).toBe(t('notebook.frontmatter.metaDeclared'))
  })

  it('SP-13 视图里的每条告警各一个告警块', async () => {
    viewExtra = { warnings: ['first problem', 'second problem'] }
    await render()
    expect(warnings()).toEqual(['first problem', 'second problem'])
  })

  it('SP-14 行标签取描述符的 i18n 文案（模型 / 思考档位）', async () => {
    await render()
    const label = (key: string): string =>
      (q(`.cm-shuvix-fmcard-meta-row[data-key="${key}"] span`)?.textContent ?? '').trim()
    expect(label(MODEL)).toBe(t('tool.subAgentModel'))
    expect(label(THINKING)).toBe(t('tool.subAgentThinking'))
  })

  it('S-11 标题行按钮（问号之外）按状态：没有 id / 写坏 / 任务期间的旧实例 → 一个都没有；有 id 且可编辑 → 恰是换新', async () => {
    fakeTimers()
    disk.id = null
    await render({ yaml: yamlOf(null) })
    expect(headerButtons()).toEqual([])
    await render({ yaml: yamlOf('shuvix-id: nope') })
    expect(headerButtons()).toEqual([])

    // 任务期间的旧实例：缓冲区（这个实例的 props）还没带上分配的 id
    await choose('low')
    const id = setObjectId.mock.calls[0][0]
    expect(saving()).toBe(true)
    expect(headerButtons()).toEqual([])

    disk.id = id
    await advance(POLL)
    await render({ yaml: yamlWithId(id) })
    expect(headerButtons()).toEqual(['regenerate'])
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
})

describe('FrontmatterMetaStrip —— 写入', () => {
  it('SP-10 缓冲区 U = 磁盘 U：选 low → setFill(U)、不分配、之后重查；选回「未设置」→ unsetFill', async () => {
    await render()
    const getsAtMount = mdMeta.get.mock.calls.length
    await choose('low')
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.setFill).toHaveBeenCalledWith({
      sessionId: S,
      objectId: U,
      key: THINKING,
      value: 'low'
    })
    expect(setObjectId).not.toHaveBeenCalled()
    expect(mdMeta.get.mock.calls.length).toBeGreaterThan(getsAtMount)
    expect(thinkingSelect().value).toBe('low')
    expect(saving()).toBe(false)

    const getsAfterSet = mdMeta.get.mock.calls.length
    await choose('')
    expect(mdMeta.unsetFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.unsetFill).toHaveBeenCalledWith({ sessionId: S, objectId: U, key: THINKING })
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(mdMeta.get.mock.calls.length).toBeGreaterThan(getsAfterSet)
    expect(thinkingSelect().value).toBe('')
  })

  it('SP-11 失败亮告警：只有 reason → 带 reason；带 message → 带 message；promise 拒绝 → 错误信息；下一次成功清掉', async () => {
    await render()
    mdMeta.setFill.mockResolvedValueOnce({ success: false, reason: 'no-object-id' })
    await choose('low')
    expect(warnings()).toEqual([
      t('notebook.frontmatter.metaWriteFailed', { reason: 'no-object-id' })
    ])

    mdMeta.setFill.mockResolvedValueOnce({
      success: false,
      reason: 'invalid-value',
      message: 'bad level'
    })
    await choose('high')
    expect(warnings()).toEqual([t('notebook.frontmatter.metaWriteFailed', { reason: 'bad level' })])

    mdMeta.setFill.mockRejectedValueOnce(new Error('ipc exploded'))
    await choose('xhigh')
    expect(warnings()).toEqual([
      t('notebook.frontmatter.metaWriteFailed', { reason: 'ipc exploded' })
    ])

    await choose('off')
    expect(warnings()).toEqual([])
  })

  it('S-7 视图告警在前、队列的失败在后；被拒的文案取 message，没有 message 取 reason', async () => {
    viewExtra = { warnings: ['view problem'] }
    await render()
    mdMeta.setFill.mockResolvedValueOnce({
      success: false,
      reason: 'invalid-value',
      message: 'bad level'
    })
    await choose('low')
    expect(warnings()).toEqual([
      'view problem',
      t('notebook.frontmatter.metaWriteFailed', { reason: 'bad level' })
    ])

    mdMeta.setFill.mockResolvedValueOnce({ success: false, reason: 'key-not-allowed' })
    await choose('high')
    expect(warnings()).toEqual([
      'view problem',
      t('notebook.frontmatter.metaWriteFailed', { reason: 'key-not-allowed' })
    ])
  })

  it('S-6 经队列的「没落盘」：缓冲区 U、磁盘一直没有 → 20×300ms 后一条 metaNotSaved、Saving… 消失、下拉回到空；不写库、不再查', async () => {
    fakeTimers()
    disk.id = null
    await render()
    await choose('low')
    expect(setObjectId).not.toHaveBeenCalled()
    expect(saving()).toBe(true)
    expect(thinkingSelect().value).toBe('low')

    await advance(POLL * 20)
    expect(warnings()).toEqual([t('notebook.frontmatter.metaNotSaved')])
    expect(saving()).toBe(false)
    expect(thinkingSelect().value).toBe('')
    expect(mdMeta.setFill).not.toHaveBeenCalled()
    const gets = mdMeta.get.mock.calls.length
    await advance(3000)
    expect(mdMeta.get.mock.calls.length).toBe(gets)
  })

  it('S-8 有设置任务在途时换新 id 禁用：缓冲区 U、磁盘落后，选一档 → 禁用、点了也不分配；任务完了恢复', async () => {
    fakeTimers()
    disk.id = null
    await render()
    await choose('low')
    expect(regenerateButton()!.disabled).toBe(true)
    await act(async () => {
      regenerateButton()!.click()
    })
    await flush()
    expect(setObjectId).not.toHaveBeenCalled()

    disk.id = U
    await advance(POLL)
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(regenerateButton()!.disabled).toBe(false)
    expect(saving()).toBe(false)
  })

  it('S-14 写完到重查回来之间（重查被压着）→ 下拉仍显示刚写的 low，不闪回库里旧的 medium，也不是空', async () => {
    disk.fill = { [THINKING]: 'medium' }
    await render()
    expect(thinkingSelect().value).toBe('medium')

    // setFill 一调用就把之后所有 get 压住：此后的 get 只会是条的重查（队列首轮轮询已经过了）；
    // 也不改假磁盘 —— 万一漏了一次重查，读回来的会是旧值 medium
    const held = deferred<MdMetaNoteView | null>()
    mdMeta.setFill.mockImplementationOnce(async () => {
      mdMeta.get.mockImplementation(() => held.promise)
      return { success: true }
    })
    await choose('low')
    expect(mdMeta.setFill).toHaveBeenCalledTimes(1)
    expect(saving()).toBe(false)
    expect(thinkingSelect().value).toBe('low')

    await act(async () => {
      held.resolve(viewOf({ fill: { [THINKING]: 'low' } }))
    })
    await flush()
    expect(thinkingSelect().value).toBe('low')
  })

  it('SP-15 换会话 → 按新会话重查', async () => {
    await render()
    expect(mdMeta.get).toHaveBeenLastCalledWith({ sessionId: S })
    const s2 = nextSession()
    await render({ sessionId: s2 })
    expect(mdMeta.get).toHaveBeenLastCalledWith({ sessionId: s2 })
    expect(mdMeta.get).toHaveBeenCalledTimes(2)
  })
})

describe('FrontmatterMetaStrip —— 文案', () => {
  it('L-1 三语的 notebook.frontmatter 不再有「没有 id / 写坏 / 分配」那几句，有 Saving… / 没落盘 / 写不进 id / 说明', () => {
    for (const [lang, locale] of [
      ['en', en],
      ['ja', ja],
      ['zh', zh]
    ] as const) {
      const keys = locale.notebook.frontmatter as Record<string, unknown>
      for (const gone of ['metaNoId', 'metaMalformed', 'metaAssign']) {
        expect(keys[gone], `${lang}.${gone}`).toBeUndefined()
      }
      for (const kept of ['metaSaving', 'metaNotSaved', 'metaCannotAssign', 'metaHint']) {
        expect(typeof keys[kept], `${lang}.${kept}`).toBe('string')
        expect((keys[kept] as string).length, `${lang}.${kept}`).toBeGreaterThan(0)
      }
    }
  })
})
