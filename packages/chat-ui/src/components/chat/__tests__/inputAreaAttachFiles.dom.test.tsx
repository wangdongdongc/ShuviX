// @vitest-environment jsdom
/**
 * 输入框添加任意文件：图片之外的文件（以及模型看不了的图片）以 `@文件名` 胶囊进输入框，发送时把它们的路径交给宿主，
 * 由宿主写进会话权限表（读）。路径只有桌面拿得到（`app.pathForFile`），别的宿主照旧只收图片。
 *
 *   AF-1  桌面：「+」里是「添加文件」、没有「添加图片」；选择器不限类型；模型不能看图也一样
 *   AF-2  没有 pathForFile 的宿主：「添加图片」、选择器 image/*；模型不能看图时没有选择器
 *   AF-3  选图片 + PDF，模型能看图：图片进待发图片、PDF 成胶囊
 *   AF-4  模型不能看图：图片也成胶囊
 *   AF-5  解不开的图片（HEIC）：退回胶囊，不丢
 *   AF-6  发送：token 的 payload 带绝对路径、attachedPaths 带路径；普通消息不带
 *   AF-7  胶囊删掉再发：不带路径 —— 没发的文件不授权
 *   AF-8  同名不同目录：两枚胶囊（后一枚带目录消歧）、各指各的文件；同一文件加两次只有一枚
 *   AF-9  运行中（steer / followUp 的通道不带 token）：文字里展开路径、带 attachedPaths；之后手打同样的文字不再算添加
 *   AF-10 回答询问的「其它」：展开路径、带 attachedPaths
 *   AF-11 斜杠命令：引用展开进参数，attachedPaths 照带
 *   AF-12 回退草稿：胶囊回来，再发照样带路径
 *   AF-13 发送失败放回输入框：胶囊回来，重发照样带路径
 *   AF-14 拖放：有路径的成胶囊；没路径的报原因
 *   AF-15 粘贴磁盘上的文件：胶囊、不贴那段文件名；Office 式的「文字 + 无路径图片」文字照贴
 *   AF-16 没有 pathForFile 的宿主：选 / 拖图片之外的文件报原因，图片照收
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

const mocks = vi.hoisted(() => ({
  /** 文件 → 本机路径（名字查表）；null = 这个宿主没有 pathForFile */
  paths: null as null | Record<string, string>,
  undecodable: new Set<string>(),
  /** 给了就顶替 paths（同名的两个文件要按对象认） */
  pathOf: null as null | ((file: File) => string)
}))

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
vi.mock('../../../utils/imageProcessing', () => ({
  fileToImageData: async (f: File) => {
    if (mocks.undecodable.has(f.name)) throw new Error('cannot decode')
    return { data: f.name, mimeType: f.type, preview: 'data:' + f.type }
  }
}))

import { applySessionView, releaseSessionView, useChatStore } from '../../../stores/chatStore'
import { InputArea, type InputAreaProps } from '../InputArea'
import { V, resetStore, store } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PDF_PATH = '/Users/u/Downloads/report final.pdf'
const pdf = new File(['p'], 'report final.pdf', { type: 'application/pdf' })
const png = new File(['i'], 'shot.png', { type: 'image/png' })
const heic = new File(['h'], 'photo.heic', { type: 'image/heic' })
const pdfChip = '@report final.pdf'

interface Sent {
  sessionId: string
  text: string
  inlineTokens?: Record<string, InlineToken>
  attachedPaths?: string[]
  response?: { kind: string; text: string }
}

const agent = {
  init: vi.fn(async () => ({ success: true })),
  prompt: vi.fn<(p: Sent) => Promise<unknown>>(async () => ({ success: true })),
  steer: vi.fn<(p: Sent) => Promise<unknown>>(async () => ({ success: true })),
  followUp: vi.fn<(p: Sent) => Promise<unknown>>(async () => ({ success: true })),
  respondToInput: vi.fn<(p: Sent) => Promise<unknown>>(async () => ({ success: true })),
  abort: vi.fn(async () => ({ success: true }))
}

function buildApi(): Record<string, unknown> {
  return {
    session: { list: async () => [] },
    agent,
    tools: { list: async () => [] },
    files: { scan: async () => ({ root: '/w', paths: [], truncated: false }) },
    mentions: { listKnowledgeEntries: async () => [] },
    events: { subscribe: () => () => {} },
    app: {
      openSettings: () => {},
      ...(mocks.paths
        ? {
            pathForFile: (file: File) =>
              mocks.pathOf?.(file) ?? (mocks.paths as Record<string, string>)[file.name] ?? ''
          }
        : {})
    }
  }
}

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(vision = true): Promise<void> {
  useChatStore.setState({ modelSupportsVision: vision })
  ;(window as unknown as { api: unknown }).api = buildApi()
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true }))
  })
  await flush()
}

const textarea = (): HTMLTextAreaElement => container.querySelector('textarea')!
const attachInput = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('input[data-attach-input]')
const sendError = (): string | null =>
  container.querySelector('[data-send-error]')?.textContent ?? null

/** 镜像层里的胶囊 */
const chips = (): string[] => {
  const mirror = textarea().parentElement?.querySelector('[aria-hidden="true"]')
  return [...(mirror?.querySelectorAll('span[role="button"]') ?? [])].map((s) =>
    (s.textContent ?? '').trim()
  )
}

async function choose(files: File[]): Promise<void> {
  const input = attachInput()!
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

async function drop(files: File[]): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files } })
  await act(async () => {
    textarea().dispatchEvent(event)
  })
  await flush()
}

/** 粘贴；回传默认动作有没有被拦下（拦下 = textarea 不会把文字贴进去） */
async function paste(files: File[], text: string): Promise<boolean> {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: () => text,
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file }))
    }
  })
  await act(async () => {
    textarea().dispatchEvent(event)
  })
  await flush()
  return event.defaultPrevented
}

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
  await flush()
}

const lastPrompt = (): Sent => agent.prompt.mock.lastCall![0]
const tokensOf = (sent: Sent): InlineToken[] => Object.values(sent.inlineTokens ?? {})

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  mocks.paths = { 'report final.pdf': PDF_PATH, 'shot.png': '/Users/u/shot.png' }
  mocks.undecodable.clear()
  mocks.pathOf = null
  for (const fn of Object.values(agent)) fn.mockClear()
  resetStore()
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
    slashCommands: [],
    pendingImages: []
  })
  store().setActiveSessionId('s1')
  store().setInputText('')
  act(() => applySessionView('s1', V('s1', { run: { state: 'idle' } })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  act(() => releaseSessionView('s1'))
  container.remove()
  document.body.innerHTML = ''
})

describe('入口', () => {
  it.each([true, false])(
    'AF-1 桌面，模型能看图 = %s：「添加文件」，选择器不限类型',
    async (vision) => {
      await mount(vision)
      await act(async () => {
        container.querySelector<HTMLElement>('[data-attach-button]')!.click()
      })
      expect(container.querySelector('[data-plus-files]')?.textContent).toContain(
        en.input.attachFiles
      )
      expect(container.querySelector('[data-plus-images]')).toBeNull()
      expect(attachInput()?.hasAttribute('accept')).toBe(false)
      expect(textarea().placeholder).toBe(en.input.placeholderFiles)
      expect(attachInput()?.multiple).toBe(true)
    }
  )

  it('AF-2 没有 pathForFile 的宿主：「添加图片」、image/*；不能看图时没有选择器', async () => {
    mocks.paths = null
    await mount(true)
    await act(async () => {
      container.querySelector<HTMLElement>('[data-attach-button]')!.click()
    })
    expect(container.querySelector('[data-plus-files]')).toBeNull()
    expect(container.querySelector('[data-plus-images]')).not.toBeNull()
    expect(attachInput()?.getAttribute('accept')).toBe('image/*')
    expect(textarea().placeholder).toBe(en.input.placeholderVision)
    await mount(false)
    expect(attachInput()).toBeNull()
  })
})

describe('分流', () => {
  it('AF-3 能看图：图片进待发图片，PDF 成胶囊', async () => {
    await mount(true)
    await choose([png, pdf])
    expect(store().pendingImages.map((img) => img.data)).toEqual(['shot.png'])
    expect(chips()).toEqual([pdfChip])
    expect(textarea().value).toBe(`${pdfChip} `)
  })

  it('AF-4 不能看图：图片也成胶囊', async () => {
    await mount(false)
    await choose([png])
    expect(store().pendingImages).toEqual([])
    expect(chips()).toEqual(['@shot.png'])
  })

  it('AF-5 解不开的图片退回胶囊', async () => {
    mocks.paths!['photo.heic'] = '/Users/u/photo.heic'
    mocks.undecodable.add('photo.heic')
    await mount(true)
    await choose([heic])
    expect(store().pendingImages).toEqual([])
    expect(chips()).toEqual(['@photo.heic'])
  })

  it('AF-14 拖放：有路径的成胶囊；没路径的报原因', async () => {
    await mount(true)
    await drop([pdf, new File(['x'], 'from-web.bin')])
    expect(chips()).toEqual([pdfChip])
    expect(sendError()).toBe(en.input.attachNoPath.replace('{{names}}', 'from-web.bin'))
  })

  it('AF-15 粘贴磁盘上的文件：胶囊、不贴文件名；无路径图片 + 文字：文字照贴', async () => {
    await mount(true)
    expect(await paste([pdf], 'report final.pdf')).toBe(true)
    expect(chips()).toEqual([pdfChip])
    expect(textarea().value).toBe(`${pdfChip} `)

    // Office 复制单元格：文字 + 一张没有路径的渲染图
    const rendered = new File(['r'], 'image.png', { type: 'image/png' })
    expect(await paste([rendered], 'a\tb')).toBe(false)
    expect(store().pendingImages.map((img) => img.data)).toEqual(['image.png'])
    expect(sendError()).toBeNull()
  })

  it('AF-16 没有 pathForFile 的宿主：图片之外的报原因，图片照收', async () => {
    mocks.paths = null
    await mount(true)
    await choose([png, pdf])
    expect(store().pendingImages.map((img) => img.data)).toEqual(['shot.png'])
    expect(chips()).toEqual([])
    expect(sendError()).toBe(en.input.attachNoPath.replace('{{names}}', 'report final.pdf'))
  })
})

describe('发送', () => {
  it('AF-6 token 带绝对路径、attachedPaths 带路径；普通消息不带', async () => {
    await mount(true)
    await choose([pdf])
    await act(async () => store().setInputText(`${textarea().value}look`))
    await pressEnter()
    const sent = lastPrompt()
    expect(sent.attachedPaths).toEqual([PDF_PATH])
    expect(tokensOf(sent).map((t) => t.payload)).toEqual([`[file: ${PDF_PATH}]`])
    expect(sent.text).toMatch(/^\{\{shuvixInlineToken:a0\}\} look$/)

    await type('plain')
    await pressEnter()
    expect(lastPrompt().attachedPaths).toBeUndefined()
  })

  it('AF-7 胶囊删掉再发：不带路径', async () => {
    await mount(true)
    await choose([pdf])
    await type('changed my mind')
    await pressEnter()
    expect(lastPrompt().attachedPaths).toBeUndefined()
    expect(lastPrompt().text).toBe('changed my mind')
  })

  it('AF-8 同名不同目录各指各的；同一文件加两次只有一枚', async () => {
    mocks.paths!['a.txt'] = '/x/a.txt'
    const first = new File(['1'], 'a.txt')
    await mount(true)
    await choose([first])
    await choose([first])
    expect(chips()).toEqual(['@a.txt'])

    mocks.paths!['a.txt'] = '/y/a.txt'
    await choose([first])
    expect(chips()).toEqual(['@a.txt', '@a.txt (/y)'])
    await pressEnter()
    expect(lastPrompt().attachedPaths).toEqual(['/x/a.txt', '/y/a.txt'])
    expect(tokensOf(lastPrompt()).map((t) => t.payload)).toEqual([
      '[file: /x/a.txt]',
      '[file: /y/a.txt]'
    ])
  })

  it('AF-8b 一次选两个同名文件也不串（连着插入，等不到渲染）', async () => {
    const [one, two] = [new File(['1'], 'a.txt'), new File(['2'], 'a.txt')]
    mocks.pathOf = (file) => (file === one ? '/x/a.txt' : '/y/a.txt')
    await mount(true)
    await choose([one, two])
    expect(chips()).toEqual(['@a.txt', '@a.txt (/y)'])
  })

  it('AF-9 运行中：文字里展开路径、带 attachedPaths；之后手打同样的文字不算添加', async () => {
    await mount(true)
    act(() => applySessionView('s1', V('s1', { run: { state: 'busy' } })))
    await flush()
    await choose([pdf])
    await pressEnter()
    const sent = agent.steer.mock.lastCall![0]
    expect(sent.text).toBe(`[file: ${PDF_PATH}]`)
    expect(sent.attachedPaths).toEqual([PDF_PATH])
    expect(textarea().value).toBe('')

    await type(`${pdfChip} `)
    await pressEnter()
    const again = agent.steer.mock.lastCall![0]
    expect(again.text).toBe(pdfChip)
    expect(again.attachedPaths).toBeUndefined()
  })

  it('AF-10 回答询问的「其它」：展开路径、带 attachedPaths', async () => {
    await mount(true)
    act(() =>
      applySessionView(
        's1',
        V('s1', {
          run: { state: 'busy' },
          asks: [
            {
              id: 'r1',
              kind: 'ask',
              toolName: 'bash',
              toolCallId: 'tc',
              payload: { command: 'ls' }
            }
          ] as never
        })
      )
    )
    await flush()
    await choose([pdf])
    await pressEnter()
    const sent = agent.respondToInput.mock.lastCall![0]
    expect(sent.response).toMatchObject({ kind: 'other', text: `[file: ${PDF_PATH}]` })
    expect(sent.attachedPaths).toEqual([PDF_PATH])
  })

  it('AF-11 斜杠命令：引用展开进参数，attachedPaths 照带', async () => {
    useChatStore.setState({
      slashCommands: [
        { commandId: 'rev', name: 'Rev', description: '', template: 'review $ARGUMENTS' }
      ] as never
    })
    await mount(true)
    await choose([pdf])
    await act(async () => store().setInputText(`/rev ${textarea().value}`))
    await pressEnter()
    const sent = lastPrompt()
    expect(sent.attachedPaths).toEqual([PDF_PATH])
    expect(tokensOf(sent).map((t) => t.payload)).toEqual([`review [file: ${PDF_PATH}]`])
  })

  it('AF-12 回退草稿：胶囊回来，再发照样带路径', async () => {
    await mount(true)
    await choose([pdf])
    await pressEnter()
    const sent = lastPrompt()
    await act(async () => store().requestDraftRestore(sent.text, sent.inlineTokens))
    await flush()
    expect(chips()).toEqual([pdfChip])
    await pressEnter()
    expect(lastPrompt().attachedPaths).toEqual([PDF_PATH])
    expect(lastPrompt().inlineTokens).toEqual(sent.inlineTokens)
  })

  it('AF-13 发送失败放回输入框：胶囊回来，重发照样带路径', async () => {
    agent.prompt.mockRejectedValueOnce(new Error('nope'))
    await mount(true)
    await choose([pdf])
    await pressEnter()
    await flush()
    expect(sendError()).toContain('nope')
    expect(chips()).toEqual([pdfChip])
    await pressEnter()
    expect(agent.prompt).toHaveBeenCalledTimes(2)
    expect(lastPrompt().attachedPaths).toEqual([PDF_PATH])
  })
})
