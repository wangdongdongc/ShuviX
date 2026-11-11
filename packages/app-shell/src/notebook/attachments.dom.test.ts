// @vitest-environment jsdom
/**
 * 笔记里粘贴、拖入、插入文件（文件库 L1；jsdom + 真 EditorView）。测试设计 docs/file-library-l1-tests.md §10.1。
 *
 *   AT-1  classifyPaste 判定表（有路径 → files；无路径看文本是否为空；Word/Excel 的混合剪贴板 → text）
 *   AT-2  单个成功：进行中只是装饰（文档不变、没有 docChanged 事务），完成后同一事务换成链接、光标跟到链接后；
 *         userEvent 粘贴 input.paste、拖放 input.drop
 *   AT-3  失败（ok:false 与 reject）：占位变错误提示，文档不变，4000 ms 后消失
 *   AT-4  多个文件按放入顺序写，换行分隔；中间失败的不留空行
 *   AT-5  进行中用户打字（映射）、移走光标（尊重用户）、没动光标（跟到链接后）
 *   AT-6  粘贴先删选区；拖放不动选区
 *   AT-7  撤销只去掉插入的那条链接，不再调 attach
 *   AT-8  attachable:false 拖入 → not-attachable 占位再变错误；粘贴不拦；只读什么都不做
 *   AT-9  粘贴分流（真 domEventHandlers 路径）：文件/文本/路径/内层可编辑/视图已卸载
 *   AT-10 拖放分流：posAtCoords 与回退、无文件不拦、Prec.high 排在低优先级 drop 之前
 *   AT-11 pickAndAttach：本机对话框路径、取消、页面的隐藏文件选择框
 *
 * 「没被拦下」用一个 Prec.low 的探针处理器来观察：Prec.high 的附件处理器回 false，事件才会走到探针；
 * 探针记下当时的 defaultPrevented 再回 true，免得 CodeMirror 自带的 paste/drop 处理器接着改文档。
 * jsdom 没有布局：CM6 量尺寸要的 Range#getClientRects / getBoundingClientRect 补成空矩形。
 */
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { EditorState, Prec, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import {
  attachFiles,
  attachmentsExtension,
  classifyPaste,
  pickAndAttach,
  type AttachItem,
  type AttachOutcome,
  type AttachSource,
  type AttachmentsConfig
} from './attachments'

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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------- 夹具 ----------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让 attachFiles 里排着的 await 都走完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const MD = '![](shuvix://file/0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10/a.png)'

type AttachMock = Mock<(item: AttachItem, source: AttachSource) => Promise<AttachOutcome>>
type Config = AttachmentsConfig & { attach: AttachMock }

function makeConfig(over: Partial<AttachmentsConfig> = {}): Config {
  return {
    attachable: true,
    attach: vi.fn(async () => ({ ok: true, markdown: MD }) as AttachOutcome),
    labels: {
      adding: (n) => 'adding:' + n,
      failed: (n, m) => 'failed:' + n + ':' + m,
      notAttachable: 'not-attachable'
    },
    ...over
  } as Config
}

interface TxRecord {
  docChanged: boolean
  userEvent: string | undefined
}
interface PendingSnap {
  error: boolean
  text: string
}

interface Harness {
  view: EditorView
  txs: TxRecord[]
  /** 每次视图更新后的占位快照 */
  snaps: PendingSnap[][]
  probe: { paste: Mock; drop: Mock; pastePrevented: boolean[]; dropPrevented: boolean[] }
}

function pendingEls(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-attach-pending'))
}
function snapshot(view: EditorView): PendingSnap[] {
  return pendingEls(view).map((el) => ({
    error: el.classList.contains('cm-attach-error'),
    text: el.textContent ?? ''
  }))
}

function makeView(
  doc: string,
  config: AttachmentsConfig | null,
  opts: { cursor?: number; anchor?: number; head?: number; extra?: Extension[] } = {}
): Harness {
  const txs: TxRecord[] = []
  const snaps: PendingSnap[][] = []
  const pastePrevented: boolean[] = []
  const dropPrevented: boolean[] = []
  const probe = {
    paste: vi.fn((event: ClipboardEvent) => {
      pastePrevented.push(event.defaultPrevented)
      return true
    }),
    drop: vi.fn((event: DragEvent) => {
      dropPrevented.push(event.defaultPrevented)
      return true
    }),
    pastePrevented,
    dropPrevented
  }
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const anchor = opts.anchor ?? opts.cursor ?? 0
  const head = opts.head ?? anchor
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        history(),
        attachmentsExtension(() => config),
        Prec.low(EditorView.domEventHandlers({ paste: probe.paste, drop: probe.drop })),
        EditorView.updateListener.of((u) => {
          for (const tr of u.transactions) {
            txs.push({
              docChanged: tr.docChanged,
              userEvent: tr.annotation(Transaction.userEvent)
            })
          }
          snaps.push(snapshot(u.view))
        }),
        ...(opts.extra ?? [])
      ]
    })
  })
  views.push(view)
  return { view, txs, snaps, probe }
}

const file = (name: string, type = 'image/png'): File =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type })

/** 合成的 paste：clipboardData 是假对象 `{ files, getData }` */
function pasteEvent(files: File[], text = ''): ClipboardEvent {
  const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(ev, 'clipboardData', {
    value: { files, getData: (type: string) => (type === 'text/plain' ? text : '') }
  })
  return ev
}

/** 合成的 drop：dataTransfer 只带 files 与文本 */
function dropEvent(files: File[], text = '', x = 10, y = 20): DragEvent {
  const ev = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(ev, 'dataTransfer', {
    value: { files, getData: (type: string) => (type === 'text/plain' ? text : ''), types: [] }
  })
  Object.defineProperty(ev, 'clientX', { value: x })
  Object.defineProperty(ev, 'clientY', { value: y })
  return ev
}

// ---------- AT-1 ----------

describe('AT-1 classifyPaste', () => {
  it.each([
    {
      name: '有带路径的文件 + 任意文本',
      files: [{ path: '/x/a.png' }],
      text: 'Hello',
      want: 'files'
    },
    { name: '有带路径的文件、文本为空', files: [{ path: '/x/a.png' }], text: '', want: 'files' },
    { name: '无路径、文本为空串', files: [{ path: null }], text: '', want: 'files' },
    { name: '无路径、文本只有空白', files: [{ path: null }], text: '  \n', want: 'files' },
    {
      name: '无路径、文本是 Hello（Word / Excel 的混合剪贴板）',
      files: [{ path: null }],
      text: 'Hello',
      want: 'text'
    },
    { name: '没有文件、有文本', files: [], text: 'Hello', want: 'text' },
    { name: '没有文件、没有文本', files: [], text: '', want: 'text' },
    {
      name: '一个有路径一个没路径 + 文本',
      files: [{ path: '/x/a.png' }, { path: null }],
      text: 'Hello',
      want: 'files'
    }
  ] as const)('$name → $want', ({ files, text, want }) => {
    expect(classifyPaste({ files: [...files], text })).toBe(want)
  })
})

// ---------- AT-2 ----------

describe('AT-2 单个成功', () => {
  it('进行中只有装饰占位，文档不变；完成后同一事务换成链接，光标跟到链接后，userEvent = input.paste', async () => {
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view, txs } = makeView('abcd', config, { cursor: 2 })
    const item = { name: 'a.png', file: file('a.png') }
    const done = attachFiles(view, config, [item], 2, 'paste', true)

    expect(config.attach).toHaveBeenCalledTimes(1)
    expect(config.attach).toHaveBeenCalledWith(item, 'paste')
    expect(view.state.doc.toString()).toBe('abcd')
    expect(txs.some((t) => t.docChanged)).toBe(false)
    const pend = pendingEls(view)
    expect(pend).toHaveLength(1)
    expect(pend[0].textContent).toBe('adding:a.png')
    expect(pend[0].classList.contains('cm-attach-error')).toBe(false)
    // 占位挂在位置 2（ab 与 cd 之间）
    expect(view.posAtDOM(pend[0])).toBe(2)
    expect(view.contentDOM.textContent).toBe('abadding:a.pngcd')

    d.resolve({ ok: true, markdown: MD })
    await done

    expect(view.state.doc.toString()).toBe('ab' + MD + 'cd')
    expect(pendingEls(view)).toHaveLength(0)
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe(2 + MD.length)
    // 唯一一个改文档的事务就是插入，占位的去掉与它同一个事务
    expect(txs.filter((t) => t.docChanged)).toEqual([
      { docChanged: true, userEvent: 'input.paste' }
    ])
  })

  it('source 为 drop 时插入事务的 userEvent 是 input.drop', async () => {
    const config = makeConfig()
    const { view, txs } = makeView('abcd', config, { cursor: 2 })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 2, 'drop', false)
    expect(view.state.doc.toString()).toBe('ab' + MD + 'cd')
    expect(txs.filter((t) => t.docChanged)).toEqual([{ docChanged: true, userEvent: 'input.drop' }])
  })
})

// ---------- AT-3 ----------

describe('AT-3 失败', () => {
  it('ok:false → 占位变成错误提示，文档不变；4000 ms 后消失', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const config = makeConfig({
      attach: vi.fn(async () => ({ ok: false, message: 'too big' }) as AttachOutcome)
    })
    const { view, txs } = makeView('abcd', config, { cursor: 2 })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 2, 'paste', true)

    expect(view.state.doc.toString()).toBe('abcd')
    expect(txs.some((t) => t.docChanged)).toBe(false)
    const pend = pendingEls(view)
    expect(pend).toHaveLength(1)
    expect(pend[0].classList.contains('cm-attach-error')).toBe(true)
    expect(pend[0].textContent).toBe('failed:a.png:too big')

    vi.advanceTimersByTime(3999)
    expect(pendingEls(view)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(pendingEls(view)).toHaveLength(0)
    expect(view.state.doc.toString()).toBe('abcd')
  })

  it('attach reject Error(boom) → 同样处理，文字是 failed:a.png:boom', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const config = makeConfig({ attach: vi.fn(() => Promise.reject(new Error('boom'))) })
    const { view } = makeView('abcd', config, { cursor: 2 })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 2, 'paste', true)

    expect(view.state.doc.toString()).toBe('abcd')
    const pend = pendingEls(view)
    expect(pend).toHaveLength(1)
    expect(pend[0].classList.contains('cm-attach-error')).toBe(true)
    expect(pend[0].textContent).toBe('failed:a.png:boom')
    vi.advanceTimersByTime(4000)
    expect(pendingEls(view)).toHaveLength(0)
  })
})

// ---------- AT-4 ----------

describe('AT-4 多个文件按放入顺序', () => {
  const items = (): AttachItem[] => ['f1', 'f2', 'f3'].map((n) => ({ name: n, file: file(n) }))

  it('三个文件依次调 attach，文档里是 L1\\nL2\\nL3', async () => {
    const config = makeConfig({
      attach: vi.fn(async (item: AttachItem) => ({
        ok: true as const,
        markdown: 'L' + item.name.slice(1)
      }))
    })
    const { view } = makeView('', config)
    await attachFiles(view, config, items(), 0, 'paste', true)
    expect(config.attach.mock.calls.map((c) => c[0].name)).toEqual(['f1', 'f2', 'f3'])
    expect(view.state.doc.toString()).toBe('L1\nL2\nL3')
    expect(pendingEls(view)).toHaveLength(0)
  })

  it('中间那个失败 → L1\\nL3，没有空行；错误占位留着', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const config = makeConfig({
      attach: vi.fn(async (item: AttachItem) =>
        item.name === 'f2'
          ? { ok: false as const, message: 'nope' }
          : { ok: true as const, markdown: 'L' + item.name.slice(1) }
      )
    })
    const { view } = makeView('', config)
    await attachFiles(view, config, items(), 0, 'paste', true)
    expect(view.state.doc.toString()).toBe('L1\nL3')
    expect(snapshot(view)).toEqual([{ error: true, text: 'failed:f2:nope' }])
  })
})

// ---------- AT-5 ----------

describe('AT-5 位置映射与光标', () => {
  it('进行中用户在占位处打了 XYZ → 链接插在 XYZ 之后（位置随映射移动），光标跟到链接后', async () => {
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view } = makeView('abcd', config, { cursor: 2 })
    const done = attachFiles(
      view,
      config,
      [{ name: 'a.png', file: file('a.png') }],
      2,
      'paste',
      true
    )
    view.dispatch({
      changes: { from: 2, insert: 'XYZ' },
      selection: { anchor: 5 },
      userEvent: 'input.type'
    })
    expect(view.posAtDOM(pendingEls(view)[0])).toBe(5)
    d.resolve({ ok: true, markdown: MD })
    await done
    expect(view.state.doc.toString()).toBe('abXYZ' + MD + 'cd')
    expect(view.state.selection.main.head).toBe(5 + MD.length)
  })

  it('进行中用户在前面打字、把光标放在别处 → 链接随映射插入，光标停在用户放的位置', async () => {
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view } = makeView('abcd', config, { cursor: 2 })
    const done = attachFiles(
      view,
      config,
      [{ name: 'a.png', file: file('a.png') }],
      2,
      'paste',
      true
    )
    view.dispatch({ changes: { from: 0, insert: 'XYZ' }, selection: { anchor: 1 } })
    d.resolve({ ok: true, markdown: MD })
    await done
    expect(view.state.doc.toString()).toBe('XYZab' + MD + 'cd')
    expect(view.state.selection.main.head).toBe(1)
    expect(view.state.selection.main.empty).toBe(true)
  })

  it('进行中用户把光标移走 → 完成后光标停在用户放的位置', async () => {
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view } = makeView('abcd', config, { cursor: 2 })
    const done = attachFiles(
      view,
      config,
      [{ name: 'a.png', file: file('a.png') }],
      2,
      'paste',
      true
    )
    view.dispatch({ selection: { anchor: 4 } })
    d.resolve({ ok: true, markdown: MD })
    await done
    expect(view.state.doc.toString()).toBe('ab' + MD + 'cd')
    // 用户放在 d 之后（原 4），插入后映射到 4 + 链接长度
    expect(view.state.selection.main.head).toBe(4 + MD.length)
  })

  it('用户没动光标 → 光标跟到链接之后', async () => {
    const config = makeConfig()
    const { view } = makeView('abcd', config, { cursor: 2 })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 2, 'paste', true)
    expect(view.state.selection.main.head).toBe(2 + MD.length)
  })
})

// ---------- AT-6 ----------

describe('AT-6 选区', () => {
  it('粘贴时有选区 [2, 4]：attach 完成之前就删掉选区，占位放在 2', async () => {
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view } = makeView('abcdef', config, { anchor: 2, head: 4 })
    const done = attachFiles(
      view,
      config,
      [{ name: 'a.png', file: file('a.png') }],
      2,
      'paste',
      true
    )
    expect(view.state.doc.toString()).toBe('abef')
    expect(view.posAtDOM(pendingEls(view)[0])).toBe(2)
    d.resolve({ ok: true, markdown: MD })
    await done
    expect(view.state.doc.toString()).toBe('ab' + MD + 'ef')
  })

  it('拖放不动选区：选区文字保留，链接插在落点', async () => {
    const config = makeConfig()
    const { view } = makeView('abcdef', config, { anchor: 2, head: 4 })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 5, 'drop', false)
    expect(view.state.doc.toString()).toBe('abcde' + MD + 'f')
    const sel = view.state.selection.main
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe('cd')
  })
})

// ---------- AT-7 ----------

describe('AT-7 撤销', () => {
  it('成功后 undo 恰好去掉插入的那条链接；attach 没有再被调', async () => {
    const config = makeConfig()
    const { view } = makeView('abcd', config, { cursor: 2 })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 2, 'paste', true)
    expect(view.state.doc.toString()).toBe('ab' + MD + 'cd')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('abcd')
    expect(config.attach).toHaveBeenCalledTimes(1)
  })
})

// ---------- AT-8 ----------

describe('AT-8 不可附加与只读', () => {
  it('attachable:false 拖入文件 → 先是 not-attachable 占位，再变成同一句的错误提示；attach 从未被调，文档不变', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const config = makeConfig({ attachable: false })
    const { view, snaps, probe } = makeView('abcd', config, { cursor: 2 })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(null)
    const ev = dropEvent([file('a.png')])
    view.contentDOM.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(true)
    expect(probe.drop).not.toHaveBeenCalled()
    expect(config.attach).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('abcd')
    const shown = snaps.filter((s) => s.length > 0)
    expect(shown[0]).toEqual([{ error: false, text: 'not-attachable' }])
    expect(shown[shown.length - 1]).toEqual([{ error: true, text: 'not-attachable' }])
    expect(snapshot(view)).toEqual([{ error: true, text: 'not-attachable' }])
    vi.advanceTimersByTime(4000)
    expect(pendingEls(view)).toHaveLength(0)
  })

  it('attachable:false 粘贴 → 处理器回 false，没有 preventDefault，交给后面的流程', () => {
    const config = makeConfig({ attachable: false })
    const { view, probe } = makeView('abcd', config, { cursor: 2 })
    view.contentDOM.dispatchEvent(pasteEvent([file('a.png')]))
    expect(probe.paste).toHaveBeenCalledTimes(1)
    expect(probe.pastePrevented).toEqual([false])
    expect(config.attach).not.toHaveBeenCalled()
    expect(pendingEls(view)).toHaveLength(0)
  })

  it('EditorState.readOnly 时 attachFiles 什么都不做，不出占位', async () => {
    const config = makeConfig()
    const { view, txs } = makeView('abcd', config, {
      cursor: 2,
      extra: [EditorState.readOnly.of(true)]
    })
    await attachFiles(view, config, [{ name: 'a.png', file: file('a.png') }], 2, 'paste', true)
    expect(config.attach).not.toHaveBeenCalled()
    expect(pendingEls(view)).toHaveLength(0)
    expect(txs).toHaveLength(0)
    expect(view.state.doc.toString()).toBe('abcd')
  })
})

// ---------- AT-9 ----------

/** 一个带内层可编辑区与 input 的挂件（ignoreEvent=false，事件交给编辑器的处理器） */
class NestedWidget extends WidgetType {
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'true')
    ce.className = 'nested-ce'
    const inner = document.createElement('span')
    inner.className = 'nested-ce-inner'
    inner.textContent = 'cell'
    ce.appendChild(inner)
    const input = document.createElement('input')
    input.className = 'nested-input'
    wrap.append(ce, input)
    return wrap
  }
  ignoreEvent(): boolean {
    return false
  }
}
const nestedWidget: Extension = EditorView.decorations.of(
  Decoration.set([Decoration.widget({ widget: new NestedWidget(), side: 1 }).range(0)])
)

describe('AT-9 粘贴分流', () => {
  it('有文件、文本为空 → preventDefault；attach 的 source 是 paste，item 是 { name, file }', async () => {
    const config = makeConfig()
    const { view, probe } = makeView('abcd', config, { cursor: 2 })
    const f = file('shot.png')
    const ev = pasteEvent([f], '')
    view.contentDOM.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(probe.paste).not.toHaveBeenCalled()
    expect(config.attach).toHaveBeenCalledTimes(1)
    expect(config.attach).toHaveBeenCalledWith({ name: 'shot.png', file: f }, 'paste')
    await flush()
    expect(view.state.doc.toString()).toBe('ab' + MD + 'cd')
  })

  it('有文件、文本 Hello、没有路径 → 不拦，attach 不调', () => {
    const config = makeConfig({ pathForFile: () => null })
    const { view, probe } = makeView('abcd', config, { cursor: 2 })
    const ev = pasteEvent([file('render.png')], 'Hello')
    view.contentDOM.dispatchEvent(ev)
    expect(probe.paste).toHaveBeenCalledTimes(1)
    expect(probe.pastePrevented).toEqual([false])
    expect(config.attach).not.toHaveBeenCalled()
  })

  it('pathForFile 回 /x/a.png，加文本 → 拦下', () => {
    const pathForFile = vi.fn(() => '/x/a.png')
    const config = makeConfig({ pathForFile })
    const { view, probe } = makeView('abcd', config, { cursor: 2 })
    const f = file('a.png')
    const ev = pasteEvent([f], 'a.png')
    view.contentDOM.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(probe.paste).not.toHaveBeenCalled()
    expect(pathForFile).toHaveBeenCalledWith(f)
    expect(config.attach).toHaveBeenCalledWith({ name: 'a.png', file: f }, 'paste')
  })

  it('没有文件 → 不拦', () => {
    const config = makeConfig()
    const { view, probe } = makeView('abcd', config, { cursor: 2 })
    view.contentDOM.dispatchEvent(pasteEvent([], 'Hello'))
    expect(probe.paste).toHaveBeenCalledTimes(1)
    expect(probe.pastePrevented).toEqual([false])
    expect(config.attach).not.toHaveBeenCalled()
  })

  it.each([
    ['内层 [contenteditable=true]', '.nested-ce-inner'],
    ['input', '.nested-input']
  ])('target 在%s里 → 不拦', (_label, selector) => {
    const config = makeConfig()
    const { view, probe } = makeView('abcd', config, { cursor: 2, extra: [nestedWidget] })
    const target = view.contentDOM.querySelector<HTMLElement>(selector)
    expect(target).not.toBeNull()
    target!.dispatchEvent(pasteEvent([file('a.png')], ''))
    expect(probe.paste).toHaveBeenCalledTimes(1)
    expect(probe.pastePrevented).toEqual([false])
    expect(config.attach).not.toHaveBeenCalled()
  })

  it('attach 完成之前视图已经 destroy → 不抛，也不 dispatch', async () => {
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view } = makeView('abcd', config, { cursor: 2 })
    view.contentDOM.dispatchEvent(pasteEvent([file('a.png')], ''))
    expect(config.attach).toHaveBeenCalledTimes(1)
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    view.destroy()
    d.resolve({ ok: true, markdown: MD })
    await flush()
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('attach 完成之前视图已经 destroy、attach 失败 → 也不 dispatch、不留定时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const d = deferred<AttachOutcome>()
    const config = makeConfig({ attach: vi.fn(() => d.promise) })
    const { view } = makeView('abcd', config, { cursor: 2 })
    const done = attachFiles(
      view,
      config,
      [{ name: 'a.png', file: file('a.png') }],
      2,
      'paste',
      true
    )
    const dispatchSpy = vi.spyOn(view, 'dispatch')
    view.destroy()
    d.reject(new Error('boom'))
    await expect(done).resolves.toBeUndefined()
    vi.advanceTimersByTime(5000)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})

// ---------- AT-10 ----------

describe('AT-10 拖放分流', () => {
  it('有文件 → 拦下，source 是 drop，落点取 posAtCoords', async () => {
    const config = makeConfig()
    const { view, probe } = makeView('abcd', config, { cursor: 3 })
    const posAtCoords = vi.spyOn(view, 'posAtCoords').mockReturnValue(1)
    const f = file('a.png')
    const ev = dropEvent([f], '', 11, 22)
    view.contentDOM.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(probe.drop).not.toHaveBeenCalled()
    expect(posAtCoords).toHaveBeenCalledWith({ x: 11, y: 22 })
    expect(config.attach).toHaveBeenCalledWith({ name: 'a.png', file: f }, 'drop')
    await flush()
    expect(view.state.doc.toString()).toBe('a' + MD + 'bcd')
  })

  it('posAtCoords 回 null（jsdom 没有布局）→ 退回 selection.main.head', async () => {
    const config = makeConfig()
    const { view } = makeView('abcd', config, { cursor: 3 })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(null)
    view.contentDOM.dispatchEvent(dropEvent([file('a.png')]))
    await flush()
    expect(view.state.doc.toString()).toBe('abc' + MD + 'd')
  })

  it('没有文件的拖放（文本、URL）→ 不拦', () => {
    const config = makeConfig()
    const { view, probe } = makeView('abcd', config, { cursor: 3 })
    view.contentDOM.dispatchEvent(dropEvent([], 'https://e.example'))
    expect(probe.drop).toHaveBeenCalledTimes(1)
    expect(probe.dropPrevented).toEqual([false])
    expect(config.attach).not.toHaveBeenCalled()
  })

  it('同一视图里低优先级的 drop 处理器收不到带文件的拖放（Prec.high 排在前面）', () => {
    const config = makeConfig()
    const { view, probe } = makeView('abcd', config, { cursor: 3 })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(null)
    view.contentDOM.dispatchEvent(dropEvent([file('a.png')]))
    expect(probe.drop).not.toHaveBeenCalled()
    expect(config.attach).toHaveBeenCalledTimes(1)
  })

  it('getConfig 回 null → 不拦', () => {
    const { view, probe } = makeView('abcd', null, { cursor: 3 })
    view.contentDOM.dispatchEvent(dropEvent([file('a.png')]))
    expect(probe.drop).toHaveBeenCalledTimes(1)
    expect(probe.dropPrevented).toEqual([false])
  })
})

// ---------- AT-11 ----------

describe('AT-11 pickAndAttach', () => {
  it('pickFiles 回两个路径 → attach 依次收到 { name, path }，source 是 insert，并替换选区', async () => {
    const config = makeConfig({
      pickFiles: vi.fn(async () => ['/a/x.png', 'C:\\d\\y.pdf']),
      attach: vi.fn(async (item: AttachItem) => ({ ok: true as const, markdown: 'M:' + item.name }))
    })
    const { view } = makeView('abcd', config, { anchor: 1, head: 3 })
    await pickAndAttach(view, config)
    expect(config.attach.mock.calls).toEqual([
      [{ name: 'x.png', path: '/a/x.png' }, 'insert'],
      [{ name: 'y.pdf', path: 'C:\\d\\y.pdf' }, 'insert']
    ])
    expect(view.state.doc.toString()).toBe('aM:x.png\nM:y.pdfd')
  })

  it.each([[null], [[]]])('pickFiles 回 %j → 什么都不做', async (picked) => {
    const config = makeConfig({ pickFiles: vi.fn(async () => picked as string[] | null) })
    const { view, txs } = makeView('abcd', config, { anchor: 1, head: 3 })
    await pickAndAttach(view, config)
    expect(config.attach).not.toHaveBeenCalled()
    expect(txs).toHaveLength(0)
    expect(view.state.doc.toString()).toBe('abcd')
  })

  it('没有 pickFiles → body 里加一个隐藏的 input[type=file][multiple] 并 click；带文件的 change → attach（insert），input 移除', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const config = makeConfig()
    const { view } = makeView('abcd', config, { cursor: 2 })
    await pickAndAttach(view, config)
    expect(click).toHaveBeenCalledTimes(1)
    const input = document.body.querySelector<HTMLInputElement>('input[type=file]')
    expect(input).not.toBeNull()
    expect(input!.multiple).toBe(true)
    expect(input!.style.display).toBe('none')
    expect(input!.parentElement).toBe(document.body)
    expect(click.mock.instances[0]).toBe(input)

    const f = file('x.png')
    Object.defineProperty(input!, 'files', { value: [f], configurable: true })
    input!.dispatchEvent(new Event('change'))
    expect(input!.isConnected).toBe(false)
    expect(config.attach).toHaveBeenCalledWith({ name: 'x.png', file: f }, 'insert')
    await flush()
    expect(view.state.doc.toString()).toBe('ab' + MD + 'cd')
  })

  it('页面的文件选择框 change 没带文件 → 什么都不做（input 照样移除）', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const config = makeConfig()
    const { view, txs } = makeView('abcd', config, { cursor: 2 })
    await pickAndAttach(view, config)
    const input = document.body.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { value: [], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flush()
    expect(input.isConnected).toBe(false)
    expect(config.attach).not.toHaveBeenCalled()
    expect(txs).toHaveLength(0)
  })
})
