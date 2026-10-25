// @vitest-environment jsdom
/**
 * 会话工具栏与会话面板里的「产物」（`SessionToolbar` / `SessionPanel` 接上 `useSessionArtifactCount`）。
 * 清单走真的 sessionArtifacts 缓存，宿主的 `artifact.list` 按会话交回给定的行（或一直挂着）。
 *
 *   SP-1 清单是 `[]`、还没取到（undefined）、宿主不支持：工具栏没有 artifacts 按钮
 *   SP-2 有产物：按钮次序 Files、Artifacts、Tasks；Artifacts 不挂数字（Tasks 照旧挂运行中的数）
 *   SP-3 点 Artifacts：面板展开到产物页，Files / Tasks 两页 `visibility:hidden`
 *   SP-4 停在产物页时清单变成 `[]`：回落到 Files、按钮消失；又有了 → 回到产物页；
 *        第一次请求还在途（停在 artifacts）：先显示 Files，取到了才切过去
 *   SP-5 切会话：展开的那一行不带到别的会话（切回来也已收起）；没有产物的会话停在 artifacts 时显示 Files
 *   PR-1…PR-4 引用块上「已有新版」的揭示（useSessionPanelReveal + ArtifactsPanel），见文件末尾那一组
 *
 * sessionArtifacts 的缓存是模块级的：每条用例 `vi.resetModules()` 后把 chat-ui / SessionPanel / 面板 store 重新 import，
 * 宿主桩注入到新的那份 chat-ui 上。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ChatUi = typeof import('@shuvix/chat-ui')
type PanelModule = typeof import('./SessionPanel')
type StoreModule = typeof import('./sessionPanelStore')

let chatUi: ChatUi
let panelMod: PanelModule
let storeMod: StoreModule
let container: HTMLDivElement
let root: Root

// ── 宿主桩 ────────────────────────────────────────────────────────────────

/** 每个会话的清单；`pending` 里的会话一直挂着 */
let responses: Record<string, SessionArtifact[]>
let pending: Set<string>
let listeners: Set<(e: AppEvent) => void>

const list = vi.fn(async (p: { sessionId: string }) => {
  if (pending.has(p.sessionId)) return new Promise<SessionArtifact[]>(() => {})
  return responses[p.sessionId] ?? []
})
const read = vi.fn(async (p: { sessionId: string; name: string }) => ({
  name: p.name,
  title: p.name,
  content: `content of ${p.name}`
}))

function hostApi(withList = true): ChatApi {
  return {
    events: {
      subscribe: (cb: (e: AppEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    artifact: withList ? { list, read } : { read },
    app: {}
  } as unknown as ChatApi
}

const art = (sessionId: string, name: string): SessionArtifact => ({
  sessionId,
  name,
  title: name,
  path: `/a/${sessionId}/${name}`,
  versions: 1,
  updatedAt: 1
})

const runningTask = (sessionId: string): TaskInfo => ({
  taskId: `t-${sessionId}`,
  sessionId,
  title: 'build',
  status: 'running',
  detached: true,
  startedAt: 1,
  endedAt: null,
  kind: 'bash',
  subject: {
    kind: 'bash',
    command: 'make',
    cwd: '/w',
    pid: 1,
    logPath: '/logs/t.log',
    exitCode: null,
    signal: null,
    logCapped: false
  }
})

// ── 渲染与查询 ────────────────────────────────────────────────────────────

const HOST = {
  appearance: { theme: 'light', darkTheme: 'd', lightTheme: 'l', fontSize: 14, focusMode: false },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  },
  interactiveFigures: true
}

/** 宿主常驻组件里那一次 `useSessionPanelReveal()`（PR 用例才挂） */
function Revealer(): null {
  panelMod.useSessionPanelReveal()
  return null
}

function render(sessionId: string, opts: { reveal?: boolean } = {}): void {
  const HostProvider = chatUi.ChatHostProvider as unknown as (props: {
    value: typeof HOST
    children?: ReactNode
  }) => React.JSX.Element
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement(
          'div',
          null,
          opts.reveal ? createElement(Revealer) : null,
          createElement(
            'div',
            { 'data-toolbar': '' },
            createElement(panelMod.SessionToolbar, { sessionId })
          ),
          createElement(panelMod.SessionPanel, {
            sessionId,
            filesContent: createElement('div', { 'data-files-stub': '' }, 'FILES')
          })
        )
      )
    )
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function emit(event: AppEvent): Promise<void> {
  act(() => {
    for (const cb of [...listeners]) cb(event)
  })
  await flush()
}

const toolKeys = (): string[] =>
  [...container.querySelectorAll('[data-toolbar] [data-session-tool]')].map(
    (b) => b.getAttribute('data-session-tool') ?? ''
  )
const toolButton = (tool: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[data-toolbar] [data-session-tool="${tool}"]`)
/** 面板里各工具页的外层（visibility 切在它上面）；面板收起 → null */
const filesPane = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-files-stub]')?.parentElement ?? null
const artifactsPane = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-artifacts-panel]')?.parentElement ?? null
const tasksPane = (): HTMLElement | null => {
  const files = filesPane()
  return (files?.nextElementSibling as HTMLElement | null) ?? null
}
const visible = (el: HTMLElement | null): boolean => !!el && el.style.visibility !== 'hidden'
/** 此刻看得见的是哪一页 */
const shownPane = (): string | null => {
  if (!filesPane()) return null
  const shown = [
    ['files', filesPane()],
    ['tasks', tasksPane()],
    ['artifacts', artifactsPane()]
  ].filter(([, el]) => visible(el as HTMLElement | null))
  return shown.map(([k]) => k as string).join(',')
}
const rowEl = (name: string): HTMLElement | null =>
  artifactsPane()?.querySelector<HTMLElement>(`[data-artifact-row=${JSON.stringify(name)}]`) ?? null

function click(el: Element | null): void {
  if (!el) throw new Error('nothing to click')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(async () => {
  vi.resetModules()
  chatUi = await import('@shuvix/chat-ui')
  panelMod = await import('./SessionPanel')
  storeMod = await import('./sessionPanelStore')
  responses = {}
  pending = new Set()
  listeners = new Set()
  list.mockClear()
  read.mockClear()
  chatUi.setChatApi(hostApi())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('会话工具栏 / 面板里的产物', () => {
  it('SP-1 清单为 []、还没取到、宿主不支持：都没有 artifacts 按钮', async () => {
    // []
    render('empty')
    await flush()
    expect(list).toHaveBeenCalled()
    expect(toolKeys()).toEqual(['files'])

    // 还没取到
    pending.add('waiting')
    render('waiting')
    await flush()
    expect(toolKeys()).toEqual(['files'])

    // 宿主没有 artifact.list（扩展）
    chatUi.setChatApi(hostApi(false))
    responses.ext = [art('ext', 'a.svg')]
    list.mockClear()
    render('ext')
    await flush()
    expect(list).not.toHaveBeenCalled()
    expect(toolKeys()).toEqual(['files'])
  })

  it('SP-2 有产物：次序 Files、Artifacts、Tasks；Artifacts 不挂数字', async () => {
    responses.s1 = [art('s1', 'a.svg'), art('s1', 'b.md')]
    act(() => chatUi.useBgTaskStore.getState().upsert(runningTask('s1')))
    render('s1')
    await flush()
    expect(toolKeys()).toEqual(['files', 'artifacts', 'tasks'])
    expect(toolButton('artifacts')!.querySelector('.tabular-nums')).toBeNull()
    expect(toolButton('artifacts')!.textContent).toBe('')
    expect(toolButton('artifacts')!.title).toBe(en.panel.artifacts)
    // 对照：任务按钮照旧挂运行中的数
    expect(toolButton('tasks')!.querySelector('.tabular-nums')?.textContent).toBe('1')
  })

  it('SP-3 点 Artifacts：面板展开到产物页，另两页 visibility:hidden', async () => {
    responses.s1 = [art('s1', 'a.svg')]
    act(() => chatUi.useBgTaskStore.getState().upsert(runningTask('s1')))
    render('s1')
    await flush()
    expect(filesPane()).toBeNull()

    click(toolButton('artifacts'))
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(filesPane()!.style.visibility).toBe('hidden')
    expect(tasksPane()!.style.visibility).toBe('hidden')
    expect(rowEl('a.svg')).not.toBeNull()
    // 激活态的按钮写出文字
    expect(toolButton('artifacts')!.textContent).toBe(en.panel.artifacts)
  })

  it('SP-4 清单变空 → 回落 Files、按钮消失；又有了 → 回到产物页；第一次请求在途 → 先显示 Files', async () => {
    responses.s1 = [art('s1', 'a.svg')]
    render('s1')
    await flush()
    click(toolButton('artifacts'))
    expect(shownPane()).toBe('artifacts')

    // 产物随子会话一起删了之类：清单变空
    responses.s1 = []
    await emit({ type: 'artifacts.changed', sessionIds: ['s1'] })
    expect(toolKeys()).toEqual(['files'])
    expect(shownPane()).toBe('files')

    responses.s1 = [art('s1', 'c.svg')]
    await emit({ type: 'artifacts.changed', sessionIds: ['s1'] })
    expect(toolKeys()).toEqual(['files', 'artifacts'])
    expect(shownPane()).toBe('artifacts')

    // 另一场会话：面板记着停在 artifacts，但第一次请求还没回来
    pending.add('slow')
    act(() => storeMod.useSessionPanelStore.getState().show('slow', 'artifacts'))
    render('slow')
    await flush()
    expect(shownPane()).toBe('files')
    expect(toolKeys()).toEqual(['files'])
  })

  it('SP-5 切会话：展开的行不带过去（切回来也已收起）；没有产物的会话停在 artifacts 时显示 Files', async () => {
    responses.a = [art('a', 'a.svg')]
    responses.b = [art('b', 'b.svg')]
    const store = storeMod.useSessionPanelStore.getState()
    act(() => {
      store.show('a', 'artifacts')
      store.show('b', 'artifacts')
      store.show('c', 'artifacts')
    })

    render('a')
    await flush()
    expect(shownPane()).toBe('artifacts')
    click(rowEl('a.svg')!.firstElementChild)
    await flush()
    expect(rowEl('a.svg')!.getAttribute('data-artifact-expanded')).toBe('true')
    expect(read).toHaveBeenCalledWith({ sessionId: 'a', name: 'a.svg' })

    render('b')
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(rowEl('b.svg')!.getAttribute('data-artifact-expanded')).toBe('false')

    render('a')
    await flush()
    expect(rowEl('a.svg')!.getAttribute('data-artifact-expanded')).toBe('false')

    // c 没有产物
    render('c')
    await flush()
    expect(toolKeys()).toEqual(['files'])
    expect(shownPane()).toBe('files')
  })
})

// ── 揭示：对话里引用块上的「已有新版」被点了（chatStore.revealArtifact → useSessionPanelReveal + ArtifactsPanel）──
//
//   PR-1 面板收起时揭示：展开到产物页，`<会话>/<名字>` 那一行展开并滚进视野；子会话组里的一行同样
//   PR-2 面板停在 Files（产物页里另一行展开着）时揭示：切到产物页，只展开那一行
//   PR-3 处理过的揭示不再生效：收起再打开，什么都不展开
//   PR-4 揭示一个没有这一行的名字：切到产物页，什么都不展开，不报错
//
// jsdom 不做布局：`getBoundingClientRect` 按元素给定矩形（面板 0–100，目标行 300–330），`scrollTop` 换成可写的
// 属性 —— 滚动量就是 scrollRowIntoView 算出来的那一下。

describe('揭示产物（已有新版 → 面板）', () => {
  const scrollTops = new WeakMap<Element, number>()
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined
  let scrollDescriptor: PropertyDescriptor | undefined

  const rectOf = (top: number, height: number): DOMRect =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 200,
      width: 200,
      height,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  beforeEach(() => {
    scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0
      },
      set(this: HTMLElement, value: number) {
        scrollTops.set(this, value)
      }
    })
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.hasAttribute('data-artifacts-panel')) return rectOf(0, 100)
      // 每一行都在面板下方（要滚才看得见）：第 n 行在 300 + 40n
      const key = this.getAttribute('data-artifact-key')
      if (key) {
        const all = [...document.querySelectorAll('[data-artifact-key]')]
        return rectOf(300 + 40 * all.indexOf(this), 30)
      }
      return rectOf(0, 0)
    })
  })

  afterEach(() => {
    rectSpy?.mockRestore()
    if (scrollDescriptor)
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', scrollDescriptor)
    else delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
  })

  const panelBox = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-artifacts-panel]')
  const expandedKeys = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('[data-artifact-key]')]
      .filter((r) => r.getAttribute('data-artifact-expanded') === 'true')
      .map((r) => r.getAttribute('data-artifact-key') ?? '')
  /** 这一行按上面的假布局应当滚到的位置（面板底 100，行底 330 + 40n） */
  const scrollFor = (key: string): number => {
    const all = [...container.querySelectorAll('[data-artifact-key]')].map((r) =>
      r.getAttribute('data-artifact-key')
    )
    return 330 + 40 * all.indexOf(key) - 100
  }
  const reveal = (sessionId: string, name: string): void => {
    act(() => chatUi.useChatStore.getState().revealArtifact(sessionId, name))
  }
  const childRow = (sessionId: string, name: string): SessionArtifact => ({
    ...art(sessionId, name),
    subSessionTitle: 'Coding'
  })

  it('PR-1 面板收起时揭示：切到产物页、那一行展开并滚进视野；子会话组的一行同样', async () => {
    responses.s1 = [art('s1', 'a.svg'), art('s1', 'b.svg'), childRow('kid', 'k.svg')]
    act(() => chatUi.useChatStore.setState({ activeSessionId: 's1' }))
    render('s1', { reveal: true })
    await flush()
    expect(toolKeys()).toEqual(['files', 'artifacts'])
    expect(filesPane()).toBeNull()

    reveal('s1', 'b.svg')
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(expandedKeys()).toEqual(['s1/b.svg'])
    expect(read).toHaveBeenLastCalledWith({ sessionId: 's1', name: 'b.svg' })
    expect(panelBox()!.scrollTop).toBe(scrollFor('s1/b.svg'))

    // 收起，再揭示子会话组里的那一件（产物所在的会话是子会话）
    act(() => storeMod.useSessionPanelStore.getState().close('s1'))
    expect(filesPane()).toBeNull()
    reveal('kid', 'k.svg')
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(expandedKeys()).toEqual(['kid/k.svg'])
    expect(read).toHaveBeenLastCalledWith({ sessionId: 'kid', name: 'k.svg' })
    expect(panelBox()!.scrollTop).toBe(scrollFor('kid/k.svg'))
  })

  it('PR-2 面板停在 Files、产物页里另一行展开着：切过去，只展开那一行', async () => {
    responses.s1 = [art('s1', 'a.svg'), art('s1', 'b.svg')]
    act(() => chatUi.useChatStore.setState({ activeSessionId: 's1' }))
    render('s1', { reveal: true })
    await flush()
    click(toolButton('artifacts'))
    await flush()
    click(rowEl('a.svg')!.firstElementChild)
    expect(expandedKeys()).toEqual(['s1/a.svg'])
    act(() => storeMod.useSessionPanelStore.getState().show('s1', 'files'))
    expect(shownPane()).toBe('files')

    reveal('s1', 'b.svg')
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(expandedKeys()).toEqual(['s1/b.svg'])
  })

  it('PR-3 处理过的揭示不再生效：收起再打开，什么都不展开', async () => {
    responses.s1 = [art('s1', 'a.svg'), art('s1', 'b.svg')]
    act(() => chatUi.useChatStore.setState({ activeSessionId: 's1' }))
    render('s1', { reveal: true })
    await flush()
    reveal('s1', 'b.svg')
    await flush()
    expect(expandedKeys()).toEqual(['s1/b.svg'])

    act(() => storeMod.useSessionPanelStore.getState().close('s1'))
    expect(filesPane()).toBeNull()
    click(toolButton('artifacts'))
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(expandedKeys()).toEqual([])
    // 同一件再点一次（新的 nonce）：又生效
    reveal('s1', 'b.svg')
    await flush()
    expect(expandedKeys()).toEqual(['s1/b.svg'])
  })

  it('PR-4 揭示一个没有这一行的名字：切到产物页，什么都不展开，不报错', async () => {
    responses.s1 = [art('s1', 'a.svg')]
    act(() => chatUi.useChatStore.setState({ activeSessionId: 's1' }))
    render('s1', { reveal: true })
    await flush()
    const box = (): number => panelBox()?.scrollTop ?? 0
    reveal('s1', 'gone.svg')
    await flush()
    expect(shownPane()).toBe('artifacts')
    expect(expandedKeys()).toEqual([])
    expect(box()).toBe(0)
    expect(rowEl('a.svg')).not.toBeNull()
  })
})
