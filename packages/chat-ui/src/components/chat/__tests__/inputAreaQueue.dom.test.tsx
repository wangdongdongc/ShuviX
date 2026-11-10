// @vitest-environment jsdom
/**
 * P3-11 · 两档输入框与队列面板（jsdom，设计稿 P3-11-12..19）：
 *
 *   12 运行中：恰好两个档位按钮 [立即 Now, 追加 Append] + 停止；没有第三个、没有「下一轮」的图标；
 *      空闲 / 被中断：一个发送按钮
 *   13 运行中回车 = 立即：`agent.steer({sessionId, text, inlineTokens})` 一次，粘贴芯片与空闲发送一样是 token（不就地
 *      展开成纯文本）；输入清空、待发图片留着；
 *      有待答的询问时也是 steer 一次（回答询问在卡片那一行）；只有空白什么都不发
 *   14 追加按钮：`agent.followUp` 一次；没字时两个档位都禁用
 *   14b 追加按钮带粘贴芯片：followUp 的载荷是标记态原文 + paste token（同 13）
 *   15 档位竞态：点下去时视图已是 idle / interrupted → 两档都改走 `agent.prompt`；关停中什么都不调
 *   15b 同上带粘贴芯片：`agent.prompt` 收标记态原文 + paste token；乐观占位也是标记态（带 p0，没有长文）
 *   16 队列面板：空队列、legacy / none 视图 → 不渲染；三条 → 细条 `Queue 3`、`Now 2`、`Append 1`；展开的
 *      次序是立即在前、档内按收件箱次序（PIN-11）；只有图片的那条显示 `(images only)` 与 `2 image(s)`
 *   17 key 稳定（按 submissionId）：一条离开队列，其余行的 DOM 节点还是原来那个
 *   18 撤回：`agent.withdrawQueued({sessionId, submissionId})` 一次；在途时按钮禁用、连点只发一次；不乐观
 *      移除（等视图）；没有 HostApi（Chrome 侧边栏）也有撤回按钮
 *   19 撤回结果（PIN-10）：`already_placed` → `[data-queue-notice]` 一句、约 3 秒后消失；`settled` /
 *      `not_found` 不出声；拒绝 → 提示里带错误文案；每种情况按钮都恢复可用
 *
 * 发送失败（`ERR` = input.sendFailed 包着 input.connectionLost）。两档当场就回，断线窗口很窄，所以 `lost` 也当场算失败：
 *   QS-1  回车 steer，notSent：放回（文字 + 粘贴芯片）、ERR、图片不翻倍、运行状态不变
 *   QS-1b 输入框里有命令芯片：随这一条带走（cmd token）；没发出去时字与芯片都放回
 *   QS-1c 同上但发出去了：输入框与命令芯片都清空；再打一句回车 → 第二条 steer 是纯文字、不带 token。
 *         变体：输入框里是没成芯片的 `/cmd x`（回填的草稿）→ 回车照样带一枚 cmd token
 *   QS-2  followUp 按钮，同上
 *   QS-3  handler_error：报原文、放回
 *   QS-4  steer，lost：当场放回并报 ERR，不等
 *   QS-6  拒绝之前打了字 → 不盖掉；拒绝之前切到 B → B 不动，回 A 时 A 的字回来
 *   QS-7  点下去时在关停：不调用，字留着
 * 点下去时已经 idle（退回普通 prompt，走占位）：
 *   QS-8  notSent：放回、ERR
 *   QS-9  lost，视图带来这条消息：受理之前有占位，没有提示、不放回
 *   QS-10 lost，视图一直没带来：连回之后满 GRACE，放回并报 ERR
 *   QS-11 受理之后 handler_error：报原因，不放回
 *
 * 后端是假的 `window.api`（同 inputAreaWelcomeSend.dom.test.tsx 的做法）；状态只经 `applySessionView` 写。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { QueuedInputView } from '@shuvix/chat-protocol/types/sessionView'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

const mocks = vi.hoisted(() => ({
  models: { activeProvider: 'prov-1', activeModel: 'model-m' },
  /** false = 渠道端（Chrome 侧边栏）：没有 HostApi */
  host: true
}))

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: () => (mocks.host ? api() : null),
    getSessionChannelApi: api,
    useChatHost: () => ({
      models: {
        activeProvider: mocks.models.activeProvider,
        activeModel: mocks.models.activeModel,
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import {
  applySessionView,
  releaseSessionView,
  selectActivePendingInput,
  selectIsStreaming,
  selectPendingPrompt,
  useChatStore
} from '../../../stores/chatStore'
import { PROMPT_OUTCOME_GRACE_MS as GRACE } from '../../../stores/promptOutcome'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { QueuePanel, QUEUE_NOTICE_MS } from '../QueuePanel'
import { V, resetStore, store, user } from '../../../__tests__/support/views'
import {
  advance,
  composerShot,
  fakeLink,
  handlerError,
  longPaste,
  lost,
  notSent,
  useFakeClock,
  type FakeLink
} from '../../../__tests__/support/sendFailure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const P = 'prov-1'
const M = 'model-m'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type WithdrawReply = { result: string }

interface FakeAgent {
  init: () => Promise<unknown>
  prompt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  followUp: ReturnType<typeof vi.fn>
  withdrawQueued: ReturnType<typeof vi.fn<(p: unknown) => Promise<WithdrawReply>>>
  abort: ReturnType<typeof vi.fn>
  respondToInput: ReturnType<typeof vi.fn>
}

let agent: FakeAgent
let link: FakeLink

function buildApi(): Record<string, unknown> {
  link = fakeLink()
  agent = {
    init: async () => ({
      success: true,
      created: true,
      provider: P,
      model: M,
      capabilities: {},
      modelMetadata: {},
      workingDirectory: '/w',
      enabledTools: []
    }),
    prompt: vi.fn(async () => ({ success: true })),
    steer: vi.fn(async () => ({ success: true })),
    followUp: vi.fn(async () => ({ success: true })),
    withdrawQueued: vi.fn(async () => ({ result: 'aborted' })),
    abort: vi.fn(async () => ({ success: true })),
    respondToInput: vi.fn(async () => ({ success: true }))
  }
  return {
    sync: link,
    session: { list: async () => [] },
    agent,
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: null, paths: [] }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: { openSettings: () => {} }
  }
}

const PROVIDER: ProviderInfo = {
  id: P,
  name: 'openai',
  displayName: 'Prov One',
  apiKey: '',
  baseUrl: '',
  apiProtocol: 'openai-completions' as ProviderInfo['apiProtocol'],
  metadata: '',
  isBuiltin: 0,
  isEnabled: 1,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0
}
const MODEL: AvailableModel = {
  id: 'row-m',
  providerId: P,
  modelId: M,
  isEnabled: 1,
  sortOrder: 0,
  capabilities: '{}',
  providerName: 'openai'
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  if (vi.isFakeTimers()) {
    await advance(0)
    return
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountInput(props: InputAreaProps = {}): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true, ...props }))
  })
  await flush()
}

async function mountPanel(): Promise<void> {
  await act(async () => {
    root.render(createElement(QueuePanel))
  })
}

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!

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

async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

/** 粘贴一段长文（够折叠成芯片） */
async function pasteLong(text: string): Promise<void> {
  const el = textarea()
  el.selectionStart = el.selectionEnd = el.value.length
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: () => text, items: [], files: [] }
  })
  await act(async () => {
    el.dispatchEvent(event)
  })
  await flush()
}

const tierButtons = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-queue-tier]')
]
const tier = (name: 'steer' | 'followUp'): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-queue-tier="${name}"]`)!

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

function busy(extra: Parameters<typeof V>[1] = {}): void {
  act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, ...extra })))
}

const q = (
  submissionId: number,
  mode: QueuedInputView['mode'],
  text: string,
  imageCount = 0
): QueuedInputView => ({
  submissionId,
  mode,
  text,
  imageCount
})

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  mocks.host = true
  ;(window as unknown as { api: unknown }).api = buildApi()
  useModelCatalogStore.setState({ loaded: true, providers: [PROVIDER], availableModels: [MODEL] })
  // 模块级的会话草稿不随 store 复位：切过会话的用例会留下别的会话的草稿
  for (const sid of ['s2', 's1']) {
    store().setActiveSessionId(sid)
    store().setInputText('')
    store().clearPendingImages()
  }
  resetStore('s1')
  useChatStore.setState({
    sessions: [
      {
        id: 's1',
        title: 's1',
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: 0,
        updatedAt: 0,
        lastActiveAt: 0
      }
    ],
    slashCommands: []
  })
  applySessionView('s1', V('s1', { run: { state: 'idle' } }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('P3-11-12..15 两档输入框', () => {
  it('P3-11-12 运行中：恰好 [Now, Append] + 停止，没有第三档；空闲 / 被中断：一个发送按钮', async () => {
    await mountInput()
    busy()
    await flush()
    expect(tierButtons().map((b) => [b.dataset.queueTier, b.textContent])).toEqual([
      ['steer', 'Now'],
      ['followUp', 'Append']
    ])
    expect(tierButtons()[0]!.parentElement!.children).toHaveLength(2)
    expect(container.querySelector(`button[title="${en.input.stopGen}"]`)).not.toBeNull()
    expect(container.querySelector('.lucide-corner-right-down')).toBeNull()
    expect(container.querySelector(`button[title="${en.input.send}"]`)).toBeNull()

    for (const state of ['idle', 'interrupted'] as const) {
      act(() => applySessionView('s1', V('s1', { run: { state } })))
      await flush()
      expect(tierButtons(), state).toEqual([])
      expect(container.querySelectorAll(`button[title="${en.input.send}"]`), state).toHaveLength(1)
      expect(container.querySelector(`button[title="${en.input.stopGen}"]`), state).toBeNull()
    }
  })

  it('P3-11-13 运行中回车 = steer 一次（粘贴芯片是 token）；输入清空，待发图片留着', async () => {
    await mountInput()
    busy()
    const image = { data: 'aGk=', mimeType: 'image/png', preview: 'data:image/png;base64,aGk=' }
    useChatStore.setState({ pendingImages: [image] })
    await flush()
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    await type('see ')
    await pasteLong(long)
    expect(textarea().value).not.toContain('line 11')
    await pressEnter()
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.steer.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: 'see {{shuvixInlineToken:p0}}',
      inlineTokens: { p0: expect.objectContaining({ type: 'paste', payload: long }) },
      secrets: []
    })
    expect(agent.followUp).not.toHaveBeenCalled()
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(store().inputText).toBe('')
    expect(store().pendingImages).toEqual([image])
  })

  it('P3-11-13 有待答的询问：回车还是 steer 一次，不答卡片；只有空白：什么都不发', async () => {
    await mountInput()
    const ask: InputRequest = {
      id: 'r1',
      kind: 'ask',
      toolName: 'bash',
      command: 'ls',
      createdAt: 0
    }
    busy({ asks: [ask] })
    await flush()
    await type('do it differently')
    await pressEnter()
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.steer.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: 'do it differently',
      secrets: []
    })
    expect(agent.respondToInput).not.toHaveBeenCalled()
    expect(selectActivePendingInput(store())?.id).toBe('r1')

    agent.steer.mockClear()
    busy()
    await flush()
    await type('   ')
    await pressEnter()
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followUp).not.toHaveBeenCalled()
    expect(agent.prompt).not.toHaveBeenCalled()
  })

  it('P3-11-14 追加按钮 → followUp 一次；没字时两档都禁用', async () => {
    await mountInput()
    busy()
    await flush()
    expect(tierButtons().map((b) => b.disabled)).toEqual([true, true])
    await type('later please')
    expect(tierButtons().map((b) => b.disabled)).toEqual([false, false])
    await click(tier('followUp'))
    expect(agent.followUp).toHaveBeenCalledTimes(1)
    expect(agent.followUp.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: 'later please',
      secrets: []
    })
    expect(agent.steer).not.toHaveBeenCalled()
    expect(store().inputText).toBe('')
  })

  it('P3-11-14b 追加按钮带粘贴芯片 → followUp 的载荷是标记态原文 + paste token', async () => {
    await mountInput()
    busy()
    await flush()
    const long = longPaste('line')
    await type('see ')
    await pasteLong(long)
    await click(tier('followUp'))
    expect(agent.followUp).toHaveBeenCalledTimes(1)
    expect(agent.followUp.mock.calls[0]![0]).toEqual({
      sessionId: 's1',
      text: 'see {{shuvixInlineToken:p0}}',
      inlineTokens: { p0: expect.objectContaining({ type: 'paste', payload: long }) },
      secrets: []
    })
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.prompt).not.toHaveBeenCalled()
    expect(store().inputText).toBe('')
  })

  it.each(['steer', 'followUp'] as const)(
    'P3-11-15 %s：点下去时视图已是 idle / interrupted → agent.prompt；关停中 → 什么都不调',
    async (name) => {
      await mountInput()
      for (const state of ['idle', 'interrupted'] as const) {
        busy()
        await flush()
        await type(`late ${state}`)
        const button = tier(name)
        await act(async () => {
          applySessionView('s1', V('s1', { run: { state } }))
          button.click()
        })
        await flush()
      }
      expect(agent.prompt.mock.calls.map((call) => call[0])).toEqual([
        { sessionId: 's1', text: 'late idle', secrets: [] },
        { sessionId: 's1', text: 'late interrupted', secrets: [] }
      ])
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.followUp).not.toHaveBeenCalled()

      busy()
      await flush()
      await type('closing')
      const button = tier(name)
      await act(async () => {
        useChatStore.setState({ sessionClosing: { s1: true } })
        button.click()
      })
      await flush()
      expect(agent.prompt).toHaveBeenCalledTimes(2)
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.followUp).not.toHaveBeenCalled()
    }
  )

  it.each(['steer', 'followUp'] as const)(
    'P3-11-15b %s 带粘贴芯片、点下去时已是 idle → agent.prompt 收标记态原文 + paste token；乐观占位也是标记态',
    async (name) => {
      const reply = deferred<unknown>()
      agent.prompt.mockReturnValueOnce(reply.promise)
      await mountInput()
      busy()
      await flush()
      const long = longPaste('line')
      await type('see ')
      await pasteLong(long)
      const button = tier(name)
      await act(async () => {
        applySessionView('s1', V('s1', { run: { state: 'idle' } }))
        button.click()
      })
      await flush()
      expect(agent.prompt).toHaveBeenCalledTimes(1)
      const sent = agent.prompt.mock.calls[0]![0] as Record<string, unknown>
      expect(sent).toEqual({
        sessionId: 's1',
        text: 'see {{shuvixInlineToken:p0}}',
        inlineTokens: { p0: expect.objectContaining({ type: 'paste', payload: long }) },
        secrets: []
      })
      expect(sent.images).toBeUndefined()
      expect(sent.attachedPaths).toBeUndefined()
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.followUp).not.toHaveBeenCalled()

      const pending = selectPendingPrompt(store())
      expect(pending?.content).toBe('see {{shuvixInlineToken:p0}}')
      expect(pending?.content).not.toContain(long)
      expect(pending?.metadata?.inlineTokens).toEqual({
        p0: expect.objectContaining({ type: 'paste', payload: long })
      })
      await act(async () => reply.resolve({ success: true }))
      await flush()
    }
  )
})

describe('P3-11-16..19 队列面板', () => {
  const THREE = [q(3, 'followUp', 'b'), q(4, 'steer', 'a'), q(5, 'steer', '', 2)]

  const rowIds = (): number[] =>
    [...container.querySelectorAll<HTMLElement>('[data-queue-row]')].map((row) =>
      Number(row.dataset.queueRow)
    )
  const withdrawButton = (id: number): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`[data-queue-withdraw="${id}"]`)!
  const notice = (): string | null =>
    container.querySelector('[data-queue-notice]')?.textContent ?? null

  async function expand(): Promise<void> {
    await click(container.querySelector('[data-queue-toggle]')!)
  }

  it('P3-11-16 空队列、legacy / none 视图 → 不渲染', async () => {
    await mountPanel()
    expect(container.innerHTML).toBe('')
    act(() =>
      applySessionView(
        's1',
        V('s1', {
          source: 'legacy',
          capabilities: { send: false, rollback: false, continue: false }
        })
      )
    )
    expect(container.innerHTML).toBe('')
    act(() => applySessionView('s1', null))
    expect(container.innerHTML).toBe('')
  })

  it('P3-11-16 三条：细条 Queue 3 / Now 2 / Append 1；展开是立即在前、档内按收件箱次序；只有图片的那条', async () => {
    busy({ queue: THREE })
    await mountPanel()
    const bar = container.querySelector('[data-queue-toggle]')!.textContent!
    expect(bar).toContain('Queue 3')
    expect(bar).toContain('Now 2')
    expect(bar).toContain('Append 1')
    expect(container.querySelector('[data-queue-row]')).toBeNull()
    await expand()
    expect(rowIds()).toEqual([4, 5, 3])
    const imagesOnly = container.querySelector('[data-queue-row="5"]')!.textContent!
    expect(imagesOnly).toContain('(images only)')
    expect(imagesOnly).toContain('2 image(s)')
  })

  it('P3-11-17 一条离开队列：其余行的 DOM 节点不换（按 submissionId 作 key）', async () => {
    busy({ queue: THREE })
    await mountPanel()
    await expand()
    const s2 = container.querySelector('[data-queue-row="5"]')
    const f1 = container.querySelector('[data-queue-row="3"]')
    busy({ queue: [THREE[0]!, THREE[2]!] })
    expect(rowIds()).toEqual([5, 3])
    expect(container.querySelector('[data-queue-row="5"]')).toBe(s2)
    expect(container.querySelector('[data-queue-row="3"]')).toBe(f1)
  })

  it('P3-11-18 撤回：一次调用、在途禁用、连点只发一次；不乐观移除；没有 HostApi 也有撤回', async () => {
    mocks.host = false
    const reply = deferred<WithdrawReply>()
    agent.withdrawQueued.mockReturnValueOnce(reply.promise)
    busy({ queue: THREE })
    await mountPanel()
    await expand()
    for (const id of [4, 5, 3]) expect(withdrawButton(id), `row ${id}`).not.toBeNull()
    const button = withdrawButton(4)
    await act(async () => {
      button.click()
      button.click()
    })
    expect(agent.withdrawQueued).toHaveBeenCalledTimes(1)
    expect(agent.withdrawQueued.mock.calls[0]![0]).toEqual({ sessionId: 's1', submissionId: 4 })
    expect(withdrawButton(4).disabled).toBe(true)
    await click(withdrawButton(4))
    expect(agent.withdrawQueued).toHaveBeenCalledTimes(1)
    await act(async () => reply.resolve({ result: 'aborted' }))
    // 不乐观移除：那一行等视图
    expect(rowIds()).toEqual([4, 5, 3])
    expect(withdrawButton(4).disabled).toBe(false)
    expect(notice()).toBeNull()
    busy({ queue: [THREE[0]!, THREE[2]!] })
    expect(rowIds()).toEqual([5, 3])
  })

  it('P3-11-19 already_placed → 一句提示、约 3 秒后消失（视图里那一行已经没了也照样显示）', async () => {
    vi.useFakeTimers()
    agent.withdrawQueued.mockResolvedValueOnce({ result: 'already_placed' })
    busy({ queue: [q(4, 'steer', 'a')] })
    await mountPanel()
    await act(async () => {
      ;(container.querySelector('[data-queue-toggle]') as HTMLElement).click()
    })
    await act(async () => {
      withdrawButton(4).click()
    })
    expect(notice()).toBe(en.queue.alreadyPlaced)
    expect(withdrawButton(4).disabled).toBe(false)
    // 它被放下了：视图里不再有它，面板为提示留着
    busy({ queue: [] })
    expect(notice()).toBe(en.queue.alreadyPlaced)
    act(() => vi.advanceTimersByTime(QUEUE_NOTICE_MS - 100))
    expect(notice()).toBe(en.queue.alreadyPlaced)
    act(() => vi.advanceTimersByTime(200))
    expect(notice()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it.each(['settled', 'not_found'])('P3-11-19 %s → 不出声，按钮恢复', async (result) => {
    agent.withdrawQueued.mockResolvedValueOnce({ result })
    busy({ queue: [q(4, 'steer', 'a')] })
    await mountPanel()
    await expand()
    await click(withdrawButton(4))
    expect(agent.withdrawQueued).toHaveBeenCalledTimes(1)
    expect(notice()).toBeNull()
    expect(withdrawButton(4).disabled).toBe(false)
  })

  it('P3-11-19 拒绝 → 提示里带错误文案，按钮恢复', async () => {
    agent.withdrawQueued.mockRejectedValueOnce(new Error('bridge down'))
    busy({ queue: [q(4, 'steer', 'a')] })
    await mountPanel()
    await expand()
    await click(withdrawButton(4))
    expect(notice()).toContain('bridge down')
    expect(withdrawButton(4).disabled).toBe(false)
  })
})

describe('发送失败', () => {
  const IMAGE = { data: 'aGk=', mimeType: 'image/png', preview: 'data:image/png;base64,aGk=' }
  const ERR = en.input.sendFailed.replace('{{error}}', en.input.connectionLost)
  const sentence = (reason: string): string => en.input.sendFailed.replace('{{error}}', reason)
  const sendError = (): string | null =>
    container.querySelector('[data-send-error]')?.textContent ?? null
  const shot = (): ReturnType<typeof composerShot> => composerShot(container)

  async function switchTo(sid: string, extra: Parameters<typeof V>[1] = {}): Promise<void> {
    const from = store().activeSessionId
    await act(async () => {
      store().setActiveSessionId(sid)
      if (from && from !== sid) releaseSessionView(from)
      applySessionView(sid, V(sid, { run: { state: 'busy' }, ...extra }))
    })
    await flush()
  }

  describe('两档', () => {
    /** 运行中：一张待发图片 + 文字 + 粘贴芯片；回 [发送前的样子, 那段长文] */
    async function composeWhileBusy(): Promise<{
      before: ReturnType<typeof composerShot>
      long: string
    }> {
      await mountInput()
      busy()
      await act(async () => useChatStore.setState({ pendingImages: [IMAGE] }))
      await flush()
      const long = longPaste('line')
      await type('see ')
      await pasteLong(long)
      const before = shot()
      expect(before.chips).toHaveLength(1)
      return { before, long }
    }

    const expectRestoredWhileBusy = (before: ReturnType<typeof composerShot>): void => {
      expect(shot()).toEqual(before)
      expect(store().pendingImages).toEqual([IMAGE])
      expect(selectIsStreaming(store())).toBe(true)
    }

    it('QS-1 回车 steer，notSent：放回（文字 + 粘贴芯片）、ERR、图片不翻倍、运行状态不变', async () => {
      agent.steer.mockRejectedValueOnce(notSent())
      const { before, long } = await composeWhileBusy()
      await pressEnter()
      expect(agent.steer.mock.calls[0]![0]).toEqual({
        sessionId: 's1',
        text: 'see {{shuvixInlineToken:p0}}',
        inlineTokens: { p0: expect.objectContaining({ type: 'paste', payload: long }) },
        secrets: []
      })
      expectRestoredWhileBusy(before)
      expect(sendError()).toBe(ERR)
    })

    it('QS-1b 输入框里有命令芯片：随这一条带走（cmd token）；没发出去时字照样放回，芯片还在', async () => {
      agent.steer.mockRejectedValueOnce(notSent())
      useChatStore.setState({
        slashCommands: [
          { commandId: 'cmd', name: 'Cmd', description: 'a command', template: 'Run: $ARGUMENTS' }
        ]
      })
      await mountInput()
      busy()
      await flush()
      await type('/cmd later')
      expect(shot().slash).toBe('/cmd')
      await pressEnter()
      expect(agent.steer).toHaveBeenCalledTimes(1)
      const sent = agent.steer.mock.calls[0]![0] as {
        text: string
        inlineTokens?: Record<string, { type: string; id: string }>
      }
      expect(Object.values(sent.inlineTokens ?? {})).toEqual([
        expect.objectContaining({ type: 'cmd', id: 'cmd' })
      ])
      expect(sent.text).toMatch(/\{\{shuvixInlineToken:[a-z0-9]+\}\}/)
      expect(textarea().value).toBe('later')
      expect(shot().slash).toBe('/cmd')
      expect(sendError()).toBe(ERR)
    })

    it('QS-1c 命令芯片随 steer 发出去：输入框与芯片都清空；下一句回车是纯文字的 steer、不带 token', async () => {
      useChatStore.setState({
        slashCommands: [
          { commandId: 'cmd', name: 'Cmd', description: 'a command', template: 'Run: $ARGUMENTS' }
        ]
      })
      await mountInput()
      busy()
      await flush()
      await type('/cmd later')
      expect(shot().slash).toBe('/cmd')
      await pressEnter()
      expect(agent.steer).toHaveBeenCalledTimes(1)
      const first = agent.steer.mock.calls[0]![0] as {
        text: string
        inlineTokens?: Record<string, { type: string; id: string }>
      }
      expect(Object.values(first.inlineTokens ?? {})).toEqual([
        expect.objectContaining({ type: 'cmd', id: 'cmd' })
      ])
      expect(textarea().value).toBe('')
      expect(shot().slash).toBeFalsy()
      expect(sendError()).toBeNull()

      await type('next')
      await pressEnter()
      expect(agent.steer).toHaveBeenCalledTimes(2)
      expect(agent.steer.mock.calls[1]![0]).toStrictEqual({
        sessionId: 's1',
        text: 'next',
        inlineTokens: undefined,
        secrets: [],
        attachedPaths: undefined
      })
    })

    it('QS-1c 变体：输入框里是没成芯片的 `/cmd x`（回填的草稿，发送时才解析）→ 运行中回车照样带一枚 cmd token', async () => {
      useChatStore.setState({
        slashCommands: [
          { commandId: 'cmd', name: 'Cmd', description: 'a command', template: 'Run: $ARGUMENTS' }
        ]
      })
      await mountInput()
      busy()
      await flush()
      act(() => store().setInputText('/cmd x'))
      await flush()
      expect(textarea().value).toBe('/cmd x')
      expect(shot().slash).toBeFalsy()
      await pressEnter()
      expect(agent.steer).toHaveBeenCalledTimes(1)
      const sent = agent.steer.mock.calls[0]![0] as {
        text: string
        inlineTokens?: Record<string, { type: string; id: string; payload: string }>
      }
      expect(Object.values(sent.inlineTokens ?? {})).toEqual([
        expect.objectContaining({ type: 'cmd', id: 'cmd', payload: 'Run: x' })
      ])
      expect(sent.text).toMatch(/^\{\{shuvixInlineToken:[a-z0-9]+\}\}/)
      expect(textarea().value).toBe('')
    })

    it('QS-2 followUp 按钮，notSent：同上', async () => {
      agent.followUp.mockRejectedValueOnce(notSent())
      const { before } = await composeWhileBusy()
      await click(tier('followUp'))
      expect(agent.followUp).toHaveBeenCalledTimes(1)
      expectRestoredWhileBusy(before)
      expect(sendError()).toBe(ERR)
    })

    it('QS-3 handler_error：报原文、放回', async () => {
      agent.steer.mockRejectedValueOnce(handlerError('queue is full'))
      const { before } = await composeWhileBusy()
      await pressEnter()
      expectRestoredWhileBusy(before)
      expect(sendError()).toBe(sentence('queue is full'))
    })

    it('QS-4 steer，lost：当场放回并报 ERR，不等', async () => {
      agent.steer.mockRejectedValueOnce(lost())
      const { before } = await composeWhileBusy()
      await pressEnter()
      expectRestoredWhileBusy(before)
      expect(sendError()).toBe(ERR)
      expect(link.onUp).not.toHaveBeenCalled()
      expect(link.onDown).not.toHaveBeenCalled()
    })

    it('QS-6 拒绝之前打了字 → 不盖掉，报 ERR', async () => {
      const reply = deferred<unknown>()
      agent.steer.mockReturnValueOnce(reply.promise)
      await mountInput()
      busy()
      await flush()
      await type('steer me')
      await pressEnter()
      expect(textarea().value).toBe('')
      await type('next thought')
      await act(async () => reply.reject(notSent()))
      await flush()
      expect(textarea().value).toBe('next thought')
      expect(sendError()).toBe(ERR)
    })

    it('QS-6 拒绝之前切到 B → B 不动，回 A 时 A 的字回来', async () => {
      const reply = deferred<unknown>()
      agent.steer.mockReturnValueOnce(reply.promise)
      await mountInput()
      busy()
      await flush()
      await type('for a')
      await pressEnter()
      await switchTo('s2', { run: { state: 'idle' } })
      await type('in b')
      await act(async () => reply.reject(notSent()))
      await flush()
      expect(textarea().value).toBe('in b')
      expect(sendError()).toBeNull()

      await switchTo('s1')
      expect(textarea().value).toBe('for a')
      expect(sendError()).toBe(ERR)
    })

    it('QS-7 点下去时在关停：不调用，字留着', async () => {
      await mountInput()
      busy()
      await flush()
      await type('wait for it')
      const button = tier('steer')
      await act(async () => {
        useChatStore.setState({ sessionClosing: { s1: true } })
        button.click()
      })
      await flush()
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.prompt).not.toHaveBeenCalled()
      expect(textarea().value).toBe('wait for it')
    })
  })

  describe('点下去时已经 idle：退回 prompt', () => {
    /** 运行中打了字，按「立即」的同一刻视图变 idle */
    async function pressAsTheRunEnds(value: string): Promise<void> {
      await mountInput()
      busy()
      await flush()
      await type(value)
      const button = tier('steer')
      await act(async () => {
        applySessionView('s1', V('s1', { run: { state: 'idle' } }))
        button.click()
      })
      await flush()
      expect(agent.prompt).toHaveBeenCalledTimes(1)
      expect(agent.steer).not.toHaveBeenCalled()
    }

    it('QS-8 notSent：放回、ERR', async () => {
      agent.prompt.mockRejectedValueOnce(notSent())
      await pressAsTheRunEnds('late')
      expect(textarea().value).toBe('late')
      expect(sendError()).toBe(ERR)
      expect(selectPendingPrompt(store())).toBeNull()
    })

    it('QS-9 lost，视图带来这条消息：受理之前有占位，没有提示、不放回', async () => {
      const reply = deferred<unknown>()
      agent.prompt.mockReturnValueOnce(reply.promise)
      await pressAsTheRunEnds('late')
      expect(selectPendingPrompt(store())?.content).toBe('late')
      await act(async () => reply.reject(lost()))
      await flush()
      expect(selectPendingPrompt(store())?.content).toBe('late')
      expect(sendError()).toBeNull()
      act(() =>
        applySessionView(
          's1',
          V('s1', { messages: [user('u_new', 'late')], run: { state: 'busy' } })
        )
      )
      await flush()
      expect(selectPendingPrompt(store())).toBeNull()
      expect(sendError()).toBeNull()
      expect(textarea().value).toBe('')
    })

    it('QS-10 lost，视图一直没带来：连回之后满 GRACE，放回并报 ERR', async () => {
      useFakeClock()
      const reply = deferred<unknown>()
      agent.prompt.mockReturnValueOnce(reply.promise)
      await pressAsTheRunEnds('late')
      act(() => link.goDown())
      await act(async () => reply.reject(lost()))
      await advance(10 * GRACE)
      expect(sendError()).toBeNull()
      act(() => link.goUp())
      await advance(GRACE - 1)
      expect(sendError()).toBeNull()
      expect(textarea().value).toBe('')
      await advance(1)
      expect(textarea().value).toBe('late')
      expect(sendError()).toBe(ERR)
      expect(selectPendingPrompt(store())).toBeNull()
    })

    it('QS-11 受理之后 handler_error：报原因，不放回', async () => {
      const reply = deferred<unknown>()
      agent.prompt.mockReturnValueOnce(reply.promise)
      await pressAsTheRunEnds('late')
      act(() =>
        applySessionView(
          's1',
          V('s1', { messages: [user('u_new', 'late')], run: { state: 'busy' } })
        )
      )
      await act(async () => reply.reject(handlerError('boom')))
      await flush()
      expect(sendError()).toBe(sentence('boom'))
      expect(textarea().value).toBe('')
    })
  })
})
