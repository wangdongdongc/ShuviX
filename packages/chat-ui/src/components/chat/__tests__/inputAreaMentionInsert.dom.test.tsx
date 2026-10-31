// @vitest-environment jsdom
/**
 * Files 面板右键「在对话中引用」→ 输入框插 @ 引用（InputArea 消费 chatStore.mentionInsertRequest，jsdom）。
 *
 * 契约（chatStore 的 mentionInsertRequest / composerSessionId 注释、useAtMentions.insert）：请求由该会话的
 * InputArea 消费 —— 在 textarea 的光标处（失焦时浏览器仍记着 selectionStart）插入胶囊并登记引用，与在 @ 弹层里
 * 选中同一结果；光标前紧挨着非空白时先补一个空格，胶囊后面跟一个空格；消费后 clear，焦点回到 textarea。
 * 只认本会话的请求。InputArea 挂载时登记 composerSessionId、换会话跟着换、卸载时只撤自己登记的那条。
 *
 * 后端整个是假的（同 inputAreaDraftRestore.dom.test.tsx）：`window.api` 同时充当 HostApi 与 SessionChannelApi，
 * 调用记进 timeline；包入口 `@shuvix/chat-ui` 顶掉。
 *
 *   MI-1  空输入框 → '@a.ts '、光标 6、请求清掉、0ms 后焦点在 textarea、镜像层一枚 `@a.ts` 胶囊
 *   MI-2  光标在各处（失焦设 selectionStart）：中间、末尾、开头、换行后、CJK 之后、词中间 —— 补空格的规则
 *   MI-3  别的会话的请求：输入框不动，请求留在 store；之后本会话的请求照插
 *   MI-4  插入后发送：内容里恰一个 `{{shuvixInlineToken:a0}}`、没有明文 `@a.ts`；Token 与 @ 弹层选中的一样
 *   MI-5  同一文件插两次 → 一个 Token、两处标记
 *   MI-6  带空格的文件名 → 胶囊 `@my notes.md`、Token displayText 'my notes.md'
 *   MI-7  两个不同文件 → 两枚胶囊、两个 Token
 *   MI-8  store 的 nonce：1、2（未清）→ clear 为 null → 再请求从 1 起
 *   MI-9  [白盒] @ 弹层开着时插入 → 弹层收起
 *   MI-10 挂载登记 composerSessionId、换会话跟着换、卸载撤销；[白盒] 别人登记的那条卸载时不撤
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

interface Call {
  name: string
  args: unknown[]
}

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: api,
    getSessionChannelApi: api,
    useChatHost: () => ({
      models: {
        activeProvider: 'prov-1',
        activeModel: 'model-m',
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import { useChatStore, type Session } from '../../../stores/chatStore'
import { InputArea, type InputAreaProps } from '../InputArea'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S1 = 'S1'
const S2 = 'S2'

const A_TS = { kind: 'file' as const, rel: 'docs/a.ts', base: 'a.ts' }
const B_TS = { kind: 'file' as const, rel: 'src/b.ts', base: 'b.ts' }
const MY_NOTES = { kind: 'file' as const, rel: 'notes/my notes.md', base: 'my notes.md' }

const atToken = (rel: string, name: string): InlineToken => ({
  type: 'at',
  id: rel,
  displayText: name,
  payload: `[workspace file: ${rel}]`,
  name
})

let timeline: Call[] = []

function record<A extends unknown[], R>(name: string, impl: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    timeline.push({ name, args })
    return impl(...args)
  }
}

const row = (id: string): Session =>
  ({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [] },
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  }) as Session

function buildApi(): Record<string, unknown> {
  return {
    session: { list: record('session.list', async () => [row(S1), row(S2)]) },
    agent: {
      prompt: record('agent.prompt', async () => ({ success: true })),
      abort: record('agent.abort', async () => ({ success: true }))
    },
    tools: { list: record('tools.list', async () => []) },
    // @ 弹层（MI-9）要有文件候选
    files: {
      scan: record('files.scan', async () => ({
        root: '/w/proj',
        paths: ['docs/a.ts', 'README.md'],
        truncated: false
      }))
    },
    mentions: { listKnowledgeEntries: record('mentions.listKnowledgeEntries', async () => []) },
    events: { subscribe: record('events.subscribe', () => () => {}) },
    app: { openSettings: record('app.openSettings', () => {}) }
  }
}

const callsOf = (name: string): unknown[][] =>
  timeline.filter((c) => c.name === name).map((c) => c.args)

let container: HTMLDivElement
let root: Root
let mounted = false

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true }))
  })
  mounted = true
  await flush()
}

function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}

const textarea = (): HTMLTextAreaElement => {
  const el = container.querySelector('textarea')
  if (!el) throw new Error('textarea not rendered')
  return el
}

/** 镜像层里的胶囊（同 e2e 的 composerChips：textarea 容器里 aria-hidden 的覆层 → span[role=button]） */
const chips = (): string[] => {
  const mirror = textarea().parentElement?.querySelector('[aria-hidden="true"]')
  return [...(mirror?.querySelectorAll('span[role="button"]') ?? [])].map((s) =>
    (s.textContent ?? '').trim()
  )
}

const popoverOpen = (): boolean => container.querySelector('[data-at-index]') !== null

/** 像用户那样打字（React 的 onChange） */
async function type(value: string): Promise<void> {
  const el = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.selectionStart = el.selectionEnd = value.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

/** 草稿 + 失焦的光标（浏览器在 textarea 失焦后仍记着 selectionStart） */
async function draftWithCaret(text: string, caret: number): Promise<void> {
  await act(async () => {
    store().setInputText(text)
  })
  await flush()
  const el = textarea()
  el.blur()
  el.selectionStart = el.selectionEnd = caret
  expect(document.activeElement).not.toBe(el)
}

async function requestInsert(sessionId: string, ref = A_TS): Promise<void> {
  await act(async () => {
    store().requestMentionInsert(sessionId, ref, ref.base)
  })
  await flush()
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
  await flush()
}

type Sent = { sessionId: string; text: string; inlineTokens?: Record<string, InlineToken> }

const lastPrompt = (): Sent => {
  const prompts = callsOf('agent.prompt') as Array<[Sent]>
  expect(prompts).toHaveLength(1)
  return prompts[0]![0]
}

const markers = (text: string, uid: string): number =>
  text.split(`{{shuvixInlineToken:${uid}}}`).length - 1

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  timeline = []
  ;(window as unknown as { api: unknown }).api = buildApi()
  useChatStore.setState({
    sessions: [row(S1), row(S2)],
    sessionAgentCreated: {},
    sessionClosing: {},
    sessionStreams: {},
    sessionPendingPrompt: {},
    slashCommands: [],
    draftRestoreRequest: null,
    mentionInsertRequest: null,
    composerSessionId: null,
    inputText: '',
    pendingImages: []
  })
  store().setActiveSessionId(S1)
  store().setInputText('')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  unmount()
  container.remove()
  document.body.innerHTML = ''
})

describe('Files panel “Mention in chat” → the composer', () => {
  it('MI-1 an empty composer gets "@a.ts " with the caret after it, the request is cleared, focus returns, one chip', async () => {
    await mount()
    await requestInsert(S1)
    expect(textarea().value).toBe('@a.ts ')
    expect(store().inputText).toBe('@a.ts ')
    expect(textarea().selectionStart).toBe(6)
    expect(textarea().selectionEnd).toBe(6)
    expect(store().mentionInsertRequest).toBeNull()
    await flush()
    expect(document.activeElement).toBe(textarea())
    expect(chips()).toEqual(['@a.ts'])
  })

  it.each<[string, string, number, string, number]>([
    ['between words after a space', 'look at please', 8, 'look at @a.ts please', 14],
    ['at the end, after a word', 'see', 3, 'see @a.ts ', 10],
    ['at the start', 'hello', 0, '@a.ts hello', 6],
    ['right after a newline', 'line\n', 5, 'line\n@a.ts ', 11],
    ['right after CJK text', '看下', 2, '看下 @a.ts ', 9],
    ['inside a word', 'foobar', 3, 'foo @a.ts bar', 10]
  ])('MI-2 %s: %j @%i → %j, caret %i', async (_, text, caret, expected, expectedCaret) => {
    await mount()
    await draftWithCaret(text, caret)
    await requestInsert(S1)
    expect(textarea().value).toBe(expected)
    expect(textarea().selectionStart).toBe(expectedCaret)
    expect(chips()).toEqual(['@a.ts'])
  })

  it('MI-3 a request for another session leaves this composer alone and stays in the store; a later one for this session inserts', async () => {
    await mount()
    await draftWithCaret('keep me', 7)
    await requestInsert(S2)
    expect(textarea().value).toBe('keep me')
    expect(chips()).toEqual([])
    expect(store().mentionInsertRequest).toMatchObject({ sessionId: S2 })

    await requestInsert(S1)
    expect(textarea().value).toBe('keep me @a.ts ')
    expect(store().mentionInsertRequest).toBeNull()
  })

  it('MI-4 sending after an insert carries exactly one marker and the same token the @ popover would build', async () => {
    await mount()
    await requestInsert(S1)
    await pressEnter()
    const sent = lastPrompt()
    expect(sent.sessionId).toBe(S1)
    expect(markers(sent.text, 'a0')).toBe(1)
    expect(sent.text).not.toContain('@a.ts')
    expect(sent.inlineTokens).toEqual({ a0: atToken('docs/a.ts', 'a.ts') })
  })

  it('MI-5 the same file inserted twice → one token, two markers', async () => {
    await mount()
    await requestInsert(S1)
    await requestInsert(S1)
    expect(textarea().value).toBe('@a.ts @a.ts ')
    expect(chips()).toEqual(['@a.ts', '@a.ts'])
    await pressEnter()
    const sent = lastPrompt()
    expect(Object.keys(sent.inlineTokens ?? {})).toEqual(['a0'])
    expect(markers(sent.text, 'a0')).toBe(2)
  })

  it('MI-6 a file name with a space → chip "@my notes.md", token displayText "my notes.md"', async () => {
    await mount()
    await requestInsert(S1, MY_NOTES)
    expect(textarea().value).toBe('@my notes.md ')
    expect(chips()).toEqual(['@my notes.md'])
    await pressEnter()
    const sent = lastPrompt()
    expect(sent.inlineTokens).toEqual({ a0: atToken('notes/my notes.md', 'my notes.md') })
    expect(markers(sent.text, 'a0')).toBe(1)
  })

  it('MI-7 two different files → two chips and two tokens', async () => {
    await mount()
    await requestInsert(S1, A_TS)
    await requestInsert(S1, B_TS)
    expect(textarea().value).toBe('@a.ts @b.ts ')
    expect(chips()).toEqual(['@a.ts', '@b.ts'])
    await pressEnter()
    const sent = lastPrompt()
    const tokens = Object.values(sent.inlineTokens ?? {})
    expect(tokens).toHaveLength(2)
    expect(tokens).toEqual(
      expect.arrayContaining([atToken('docs/a.ts', 'a.ts'), atToken('src/b.ts', 'b.ts')])
    )
    for (const uid of Object.keys(sent.inlineTokens ?? {})) expect(markers(sent.text, uid)).toBe(1)
  })

  it('MI-8 store nonces: 1, then 2 while uncleared; clear → null; the next request starts at 1 again', () => {
    // 不挂 InputArea：没人消费
    store().requestMentionInsert(S1, A_TS, 'a.ts')
    expect(store().mentionInsertRequest).toEqual({
      sessionId: S1,
      ref: A_TS,
      displayText: 'a.ts',
      nonce: 1
    })
    store().requestMentionInsert(S1, B_TS, 'b.ts')
    expect(store().mentionInsertRequest?.nonce).toBe(2)
    expect(store().mentionInsertRequest?.ref).toEqual(B_TS)
    store().clearMentionInsert()
    expect(store().mentionInsertRequest).toBeNull()
    store().requestMentionInsert(S2, A_TS, 'a.ts')
    expect(store().mentionInsertRequest).toMatchObject({ sessionId: S2, nonce: 1 })
  })

  it('MI-9 [white-box] an insert closes an open @ popover', async () => {
    await mount()
    await type('see @')
    await flush()
    expect(popoverOpen()).toBe(true)
    await requestInsert(S1)
    expect(popoverOpen()).toBe(false)
    expect(chips()).toEqual(['@a.ts'])
  })
})

describe('MI-10 composerSessionId registration', () => {
  it('mount registers the active session, a session switch follows it, unmount clears it', async () => {
    expect(store().composerSessionId).toBeNull()
    await mount()
    expect(store().composerSessionId).toBe(S1)
    await act(async () => {
      store().setActiveSessionId(S2)
    })
    await flush()
    expect(store().composerSessionId).toBe(S2)
    unmount()
    expect(store().composerSessionId).toBeNull()
  })

  it('[white-box] unmount does not clear a registration that is not its own', async () => {
    await mount()
    expect(store().composerSessionId).toBe(S1)
    act(() => store().setComposerSessionId('S9'))
    unmount()
    expect(store().composerSessionId).toBe('S9')
  })
})
