// @vitest-environment jsdom
/**
 * 笔记编辑器与文件库之间的那一层（文件库 L1；jsdom）。测试设计 docs/file-library-l1-tests.md §10.2。
 *
 *   LE-1 没有宿主 / 宿主没有 library → unavailable，add 没被调
 *   LE-2 交路径：item.path、pathForFile 拿到的路径；pathForFile 回 '' → 退回交字节；sessionId 原样带上
 *   LE-3 粘贴的位图：pasted-<本地时间>.<ext>，base64 不带 data: 前缀，label ''
 *   LE-4 其余字节文件：保留原名、没有 label；没名字 → file
 *   LE-5 渲染端先查大小：超 32 MiB → tooLarge('32 MB')，不读文件、不调 add
 *   LE-6 结果映射与 source 映射
 *   LE-7 libraryImageMissing：登记过的库图片 error → 标成已删除；load → 摘掉并还原 alt；destroy 后不动
 *   LE-8 buildAttachConfig：pathForFile / pickFiles 只在宿主有时给；labels 的键与参数；notAttachable 取用时才读；
 *        attach 把笔记本会话 id 交给 library.add，并在调用时才取宿主
 *
 * `@shuvix/chat-ui` 只替掉 getHostApi（宿主放在可变的 hostState 里）。假时钟只替 Date
 * （FileReader 的回调仍按真定时器走）。
 */
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { HostApi } from '@shuvix/chat-protocol/chatApi'
import type { LibraryAddParams, LibraryAddResult } from '@shuvix/chat-protocol/fileLibrary'

const hostState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@shuvix/chat-ui', () => ({
  getHostApi: () => hostState.current
}))

import {
  attachToLibrary,
  buildAttachConfig,
  libraryImageMissing,
  noteLibraryImageUrl,
  type AttachMessages
} from './libraryEditor'

beforeAll(() => {
  const emptyRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({})
    }) as DOMRect
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRectList
    getBoundingClientRect?: () => DOMRect
  }
  if (!proto.getClientRects) {
    proto.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator]
      }) as unknown as DOMRectList
  }
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect
})

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) {
    if (view.dom.isConnected) view.destroy()
  }
  document.body.innerHTML = ''
  hostState.current = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------- 夹具 ----------

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const MD = `![](shuvix://file/${ID}/a.png)`
const OK: LibraryAddResult = {
  ok: true,
  reused: false,
  markdown: MD,
  item: { id: ID } as Extract<LibraryAddResult, { ok: true }>['item']
}

type AddMock = Mock<(params: LibraryAddParams) => Promise<LibraryAddResult>>

interface FakeHost {
  library?: { add: AddMock; pickFiles: Mock<() => Promise<string[] | null>> }
  app?: { pathForFile?: Mock<(file: File) => string> }
}

function makeHost(
  opts: { pathForFile?: (file: File) => string; result?: LibraryAddResult; library?: boolean } = {}
): FakeHost & { library: NonNullable<FakeHost['library']> } {
  const host: FakeHost = {
    ...(opts.library === false
      ? {}
      : {
          library: {
            add: vi.fn(async () => opts.result ?? OK),
            pickFiles: vi.fn(async () => ['/p/a.png'])
          }
        }),
    app: opts.pathForFile ? { pathForFile: vi.fn(opts.pathForFile) } : {}
  }
  return host as FakeHost & { library: NonNullable<FakeHost['library']> }
}
const asHost = (h: FakeHost | null): HostApi | null => h as unknown as HostApi | null

const messages: AttachMessages = {
  unavailable: 'unavailable',
  tooLarge: (limit) => 'tooLarge:' + limit,
  notAFile: 'notAFile'
}

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 250, 251])
const B64 = Buffer.from(BYTES).toString('base64')
const mkFile = (name: string, type: string): File => new File([BYTES], name, { type })

/** 只替 Date：2026-11-10 15:30:12（本地时间） */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 10, 15, 30, 12))
}

// ---------- LE-1 ----------

describe('LE-1 没有宿主', () => {
  it('host 为 null → unavailable', async () => {
    const out = await attachToLibrary(null, { name: 'a.png', path: '/x/a.png' }, 'paste', messages)
    expect(out).toEqual({ ok: false, message: 'unavailable' })
  })

  it('宿主没有 library → unavailable，pathForFile 也不问', async () => {
    const host = makeHost({ library: false, pathForFile: () => '/x/a.png' })
    const out = await attachToLibrary(
      asHost(host),
      { name: 'a.png', file: mkFile('a.png', 'image/png') },
      'drop',
      messages
    )
    expect(out).toEqual({ ok: false, message: 'unavailable' })
    expect(host.app?.pathForFile).not.toHaveBeenCalled()
  })
})

// ---------- LE-2 ----------

describe('LE-2 交路径', () => {
  it('item.path → add({ item: { kind: path }, source: note-insert })，没有 label 键与 sessionId 键', async () => {
    const host = makeHost()
    const out = await attachToLibrary(
      asHost(host),
      { name: 'a.png', path: '/x/a.png' },
      'insert',
      messages
    )
    expect(out).toEqual({ ok: true, markdown: MD })
    expect(host.library.add).toHaveBeenCalledTimes(1)
    const params = host.library.add.mock.calls[0][0]
    expect(params).toEqual({ item: { kind: 'path', path: '/x/a.png' }, source: 'note-insert' })
    expect('label' in params).toBe(false)
    expect('sessionId' in params).toBe(false)
  })

  it('传了 sessionId → 原样带进 library.add', async () => {
    const host = makeHost()
    await attachToLibrary(
      asHost(host),
      { name: 'a.png', path: '/x/a.png' },
      'insert',
      messages,
      'S1'
    )
    expect(host.library.add).toHaveBeenCalledWith({
      item: { kind: 'path', path: '/x/a.png' },
      source: 'note-insert',
      sessionId: 'S1'
    })
  })

  it("sessionId 为 '' → 不带 sessionId 键", async () => {
    const host = makeHost()
    await attachToLibrary(asHost(host), { name: 'a.png', path: '/x/a.png' }, 'insert', messages, '')
    expect('sessionId' in host.library.add.mock.calls[0][0]).toBe(false)
  })

  it('item.file 且 pathForFile 回路径 → 交 kind: path，不读文件', async () => {
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    const host = makeHost({ pathForFile: () => '/Users/x/a.png' })
    const f = mkFile('a.png', 'image/png')
    await attachToLibrary(asHost(host), { name: 'a.png', file: f }, 'drop', messages, 'S1')
    expect(host.app?.pathForFile).toHaveBeenCalledWith(f)
    expect(host.library.add).toHaveBeenCalledWith({
      item: { kind: 'path', path: '/Users/x/a.png' },
      source: 'note-drop',
      sessionId: 'S1'
    })
    expect(readSpy).not.toHaveBeenCalled()
  })

  it("pathForFile 回 '' → 退回交字节", async () => {
    const host = makeHost({ pathForFile: () => '' })
    await attachToLibrary(
      asHost(host),
      { name: 'a.png', file: mkFile('a.png', 'image/png') },
      'drop',
      messages
    )
    expect(host.library.add).toHaveBeenCalledWith({
      item: { kind: 'bytes', name: 'a.png', mimeType: 'image/png', dataBase64: B64 },
      source: 'note-drop'
    })
  })

  it('既没有 path 也没有 file → notAFile，add 没被调', async () => {
    const host = makeHost()
    const out = await attachToLibrary(asHost(host), { name: 'a.png' }, 'insert', messages)
    expect(out).toEqual({ ok: false, message: 'notAFile' })
    expect(host.library.add).not.toHaveBeenCalled()
  })
})

// ---------- LE-3 ----------

describe('LE-3 粘贴的位图', () => {
  it('交字节：name pasted-20261110-153012.png、image/png、base64 不带 data: 前缀、label 为空串', async () => {
    freezeClock()
    const host = makeHost()
    await attachToLibrary(
      asHost(host),
      { name: 'image.png', file: mkFile('image.png', 'image/png') },
      'paste',
      messages,
      'S1'
    )
    const params = host.library.add.mock.calls[0][0]
    expect(params).toEqual({
      item: {
        kind: 'bytes',
        name: 'pasted-20261110-153012.png',
        mimeType: 'image/png',
        dataBase64: B64
      },
      source: 'note-paste',
      label: '',
      sessionId: 'S1'
    })
    expect((params.item as { dataBase64: string }).dataBase64.startsWith('data:')).toBe(false)
  })

  it.each([
    ['image/jpeg', 'pasted-20261110-153012.jpg'],
    ['image/x-foo', 'pasted-20261110-153012.png']
  ])('%s → %s', async (type, name) => {
    freezeClock()
    const host = makeHost()
    await attachToLibrary(asHost(host), { name: '', file: mkFile('', type) }, 'paste', messages)
    const params = host.library.add.mock.calls[0][0]
    expect(params.item).toMatchObject({ kind: 'bytes', name, mimeType: type })
    expect(params.label).toBe('')
  })
})

// ---------- LE-4 ----------

describe('LE-4 其余字节文件', () => {
  it('拖入的图片保留 file.name，没有 label 键', async () => {
    const host = makeHost()
    await attachToLibrary(
      asHost(host),
      { name: 'Diagram.png', file: mkFile('Diagram.png', 'image/png') },
      'drop',
      messages
    )
    const params = host.library.add.mock.calls[0][0]
    expect(params.item).toMatchObject({ kind: 'bytes', name: 'Diagram.png' })
    expect('label' in params).toBe(false)
  })

  it('粘贴的非图片 a.pdf 保留原名，没有 label', async () => {
    const host = makeHost()
    await attachToLibrary(
      asHost(host),
      { name: 'a.pdf', file: mkFile('a.pdf', 'application/pdf') },
      'paste',
      messages
    )
    const params = host.library.add.mock.calls[0][0]
    expect(params).toEqual({
      item: { kind: 'bytes', name: 'a.pdf', mimeType: 'application/pdf', dataBase64: B64 },
      source: 'note-paste'
    })
  })

  it("文件没有名字 → 'file'", async () => {
    const host = makeHost()
    await attachToLibrary(asHost(host), { name: '', file: mkFile('', '') }, 'drop', messages)
    expect(host.library.add.mock.calls[0][0].item).toMatchObject({ kind: 'bytes', name: 'file' })
  })
})

// ---------- LE-5 ----------

describe('LE-5 渲染端先查大小', () => {
  it("file.size 超过 32 MiB → tooLarge('32 MB')；没用 FileReader，add 没被调", async () => {
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    const host = makeHost()
    const f = mkFile('big.bin', 'application/octet-stream')
    Object.defineProperty(f, 'size', { value: 32 * 1024 * 1024 + 1 })
    const out = await attachToLibrary(asHost(host), { name: 'big.bin', file: f }, 'drop', messages)
    expect(out).toEqual({ ok: false, message: 'tooLarge:32 MB' })
    expect(readSpy).not.toHaveBeenCalled()
    expect(host.library.add).not.toHaveBeenCalled()
  })

  it('恰好 32 MiB 照常读、照常交', async () => {
    const host = makeHost()
    const f = mkFile('edge.bin', 'application/octet-stream')
    Object.defineProperty(f, 'size', { value: 32 * 1024 * 1024 })
    await attachToLibrary(asHost(host), { name: 'edge.bin', file: f }, 'drop', messages)
    expect(host.library.add).toHaveBeenCalledTimes(1)
  })
})

// ---------- LE-6 ----------

describe('LE-6 结果映射', () => {
  const fail = (
    reason: 'too-large' | 'not-a-file' | 'refused' | 'io',
    message: string
  ): LibraryAddResult => ({ ok: false, name: 'a.png', reason, message })

  it.each([
    ['too-large', '32 MB', { ok: false, message: 'tooLarge:32 MB' }],
    ['not-a-file', 'whatever', { ok: false, message: 'notAFile' }],
    [
      'refused',
      'Only file contents can be added from this client.',
      {
        ok: false,
        message: 'Only file contents can be added from this client.'
      }
    ],
    ['io', 'disk full', { ok: false, message: 'disk full' }]
  ] as const)('%s → %j', async (reason, message, want) => {
    const host = makeHost({ result: fail(reason, message) })
    const out = await attachToLibrary(
      asHost(host),
      { name: 'a.png', path: '/x/a.png' },
      'insert',
      messages
    )
    expect(out).toEqual(want)
  })

  it('ok → { ok: true, markdown }', async () => {
    const host = makeHost()
    const out = await attachToLibrary(
      asHost(host),
      { name: 'a.png', path: '/x/a.png' },
      'drop',
      messages
    )
    expect(out).toEqual({ ok: true, markdown: MD })
  })

  it.each([
    ['paste', 'note-paste'],
    ['drop', 'note-drop'],
    ['insert', 'note-insert']
  ] as const)('source %s → %s', async (source, want) => {
    const host = makeHost()
    await attachToLibrary(asHost(host), { name: 'a.png', path: '/x/a.png' }, source, messages)
    expect(host.library.add.mock.calls[0][0].source).toBe(want)
  })
})

// ---------- LE-7 ----------

class ImgWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }
  toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.setAttribute('src', this.src)
    img.alt = this.alt
    return img
  }
}

let urlSeq = 0
/** 每条用例一个新地址：登记表是模块级的 */
const freshUrl = (): string => `blob:lib-${++urlSeq}`

function viewWithImg(src: string, alt: string): { view: EditorView; img: HTMLImageElement } {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: 'x',
      extensions: [
        libraryImageMissing('File deleted'),
        EditorView.decorations.of(
          Decoration.set([Decoration.widget({ widget: new ImgWidget(src, alt) }).range(0)])
        )
      ]
    })
  })
  views.push(view)
  const img = view.dom.querySelector('img')
  if (!img) throw new Error('no img')
  return { view, img }
}

describe('LE-7 libraryImageMissing', () => {
  it('登记过的 <img> 触发 error → 加 cm-library-missing，alt 与 title 换成提示', () => {
    const url = freshUrl()
    noteLibraryImageUrl(url)
    const { img } = viewWithImg(url, 'Chart')
    img.dispatchEvent(new Event('error'))
    expect(img.classList.contains('cm-library-missing')).toBe(true)
    expect(img.alt).toBe('File deleted')
    expect(img.title).toBe('File deleted')
  })

  it('没登记过的 <img> 触发 error → 不动', () => {
    const { img } = viewWithImg(freshUrl(), 'Chart')
    img.dispatchEvent(new Event('error'))
    expect(img.classList.contains('cm-library-missing')).toBe(false)
    expect(img.alt).toBe('Chart')
    expect(img.hasAttribute('title')).toBe(false)
  })

  it('登记过的随后触发 load → 去掉 class 与 title，alt 恢复成原值', () => {
    const url = freshUrl()
    noteLibraryImageUrl(url)
    const { img } = viewWithImg(url, 'Chart')
    img.dispatchEvent(new Event('error'))
    // 再错一次也不能把「原值」记成提示文字
    img.dispatchEvent(new Event('error'))
    img.dispatchEvent(new Event('load'))
    expect(img.classList.contains('cm-library-missing')).toBe(false)
    expect(img.hasAttribute('title')).toBe(false)
    expect(img.alt).toBe('Chart')
  })

  it('alt 原本为空 → load 后还是空', () => {
    const url = freshUrl()
    noteLibraryImageUrl(url)
    const { img } = viewWithImg(url, '')
    img.dispatchEvent(new Event('error'))
    expect(img.alt).toBe('File deleted')
    img.dispatchEvent(new Event('load'))
    expect(img.alt).toBe('')
  })

  it('没出过错的图片 load → 不动', () => {
    const url = freshUrl()
    noteLibraryImageUrl(url)
    const { img } = viewWithImg(url, 'Chart')
    img.title = 'keep'
    img.dispatchEvent(new Event('load'))
    expect(img.title).toBe('keep')
    expect(img.alt).toBe('Chart')
  })

  it('插件 destroy 之后再触发 error → 不动', () => {
    const url = freshUrl()
    noteLibraryImageUrl(url)
    const { view, img } = viewWithImg(url, 'Chart')
    view.destroy()
    img.dispatchEvent(new Event('error'))
    expect(img.classList.contains('cm-library-missing')).toBe(false)
    expect(img.alt).toBe('Chart')
  })
})

// ---------- LE-8 ----------

describe('LE-8 buildAttachConfig', () => {
  /** t 委托给可换的实现：返回 `key|参数 JSON` */
  let impl: (key: string, opts?: Record<string, unknown>) => string
  const t = vi.fn((key: string, opts?: Record<string, unknown>) => impl(key, opts))
  const reset = (): void => {
    impl = (key, opts) => (opts ? `${key}|${JSON.stringify(opts)}` : key)
    t.mockClear()
  }

  it("宿主有 pathForFile 与 library：config 带 pathForFile（收到 '' 回 null）与 pickFiles（调 library.pickFiles）", async () => {
    reset()
    let next = '/x/a.png'
    const host = makeHost({ pathForFile: () => next })
    hostState.current = host
    const config = buildAttachConfig(true, t)
    expect(config.attachable).toBe(true)
    const f = mkFile('a.png', 'image/png')
    expect(config.pathForFile?.(f)).toBe('/x/a.png')
    next = ''
    expect(config.pathForFile?.(f)).toBeNull()
    expect(config.pickFiles).toBeTypeOf('function')
    await expect(config.pickFiles!()).resolves.toEqual(['/p/a.png'])
    expect(host.library.pickFiles).toHaveBeenCalledTimes(1)
  })

  it('web 那样没有 pathForFile 的宿主：两个都没有', () => {
    reset()
    hostState.current = makeHost()
    const config = buildAttachConfig(false, t)
    expect(config.attachable).toBe(false)
    expect('pathForFile' in config).toBe(false)
    expect('pickFiles' in config).toBe(false)
  })

  it('有 pathForFile 但没有 library：只有 pathForFile', () => {
    reset()
    hostState.current = makeHost({ library: false, pathForFile: () => '/x' })
    const config = buildAttachConfig(true, t)
    expect(config.pathForFile).toBeTypeOf('function')
    expect('pickFiles' in config).toBe(false)
  })

  it('labels 用正确的键与参数调 t', () => {
    reset()
    hostState.current = makeHost()
    const config = buildAttachConfig(true, t)
    expect(config.labels.adding('a.png')).toBe('notebook.attach.adding|{"name":"a.png"}')
    expect(t).toHaveBeenLastCalledWith('notebook.attach.adding', { name: 'a.png' })
    expect(config.labels.failed('a.png', 'boom')).toBe(
      'notebook.attach.failed|{"name":"a.png","message":"boom"}'
    )
    expect(t).toHaveBeenLastCalledWith('notebook.attach.failed', { name: 'a.png', message: 'boom' })
    expect(config.labels.notAttachable).toBe('notebook.attach.notAttachable')
    expect(t).toHaveBeenLastCalledWith('notebook.attach.notAttachable')
  })

  it('notAttachable 是取用时才读的：build 之后换掉 t 的文字，读到的是新文字', () => {
    reset()
    hostState.current = makeHost()
    const config = buildAttachConfig(false, t)
    expect(config.labels.notAttachable).toBe('notebook.attach.notAttachable')
    impl = (key) => 'NEW:' + key
    expect(config.labels.notAttachable).toBe('NEW:notebook.attach.notAttachable')
  })

  it('attach 把笔记本会话 id 交给 library.add，失败文案用 t 的键', async () => {
    reset()
    const host = makeHost({
      result: { ok: false, name: 'a', reason: 'too-large', message: '32 MB' }
    })
    hostState.current = host
    const config = buildAttachConfig(true, t, 'S-note')
    const out = await config.attach({ name: 'a.png', path: '/x/a.png' }, 'drop')
    expect(host.library.add).toHaveBeenCalledWith({
      item: { kind: 'path', path: '/x/a.png' },
      source: 'note-drop',
      sessionId: 'S-note'
    })
    expect(out).toEqual({ ok: false, message: 'notebook.attach.tooLarge|{"limit":"32 MB"}' })
  })

  it('不传 sessionId → library.add 里没有 sessionId 键', async () => {
    reset()
    const host = makeHost()
    hostState.current = host
    const config = buildAttachConfig(true, t)
    await config.attach({ name: 'a.png', path: '/x/a.png' }, 'insert')
    expect('sessionId' in host.library.add.mock.calls[0][0]).toBe(false)
  })

  it('attach 在调用时才取宿主：build 时没有宿主，调用时有 → 照常交', async () => {
    reset()
    hostState.current = null
    const config = buildAttachConfig(true, t, 'S1')
    const host = makeHost()
    hostState.current = host
    const out = await config.attach({ name: 'a.png', path: '/x/a.png' }, 'paste')
    expect(out).toEqual({ ok: true, markdown: MD })
    expect(host.library.add).toHaveBeenCalledTimes(1)
  })

  it('调用时没有宿主 → unavailable 的文案（notebook.attach.unavailable），notAFile 也走 t', async () => {
    reset()
    hostState.current = null
    const config = buildAttachConfig(true, t)
    await expect(config.attach({ name: 'a.png', path: '/x/a.png' }, 'paste')).resolves.toEqual({
      ok: false,
      message: 'notebook.attach.unavailable'
    })
    hostState.current = makeHost({
      result: { ok: false, name: 'a', reason: 'not-a-file', message: 'x' }
    })
    await expect(config.attach({ name: 'a.png', path: '/x/a.png' }, 'paste')).resolves.toEqual({
      ok: false,
      message: 'notebook.attach.notAFile'
    })
  })
})
