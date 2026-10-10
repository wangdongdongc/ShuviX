// @vitest-environment jsdom
/**
 * 属性卡的「ShuviX 设置」槽位（`mountMetaStrip`）与它交出的 `setObjectId`（jsdom + 真 EditorView）。
 *
 * 卡片只开槽、交上下文，内容归宿主（LivePreviewEditor → FrontmatterMetaStrip，那边另有用例）：
 *   - FC-M1..4 槽位：不给接缝就没有槽；给了恰挂一次，上下文是标记类型、缓冲区里 frontmatter 的**原文**、
 *     编辑器只读态；槽在卡片里、字段区之后；YAML 写坏也照挂；frontmatter 一变旧的收尾、新的重挂；销毁视图收尾；
 *   - FC-M5..10 setObjectId：往**缓冲区**写 `shuvix-id`（chat-protocol setShuvixIdLine 的那一种行）——
 *     只改这一行、一次事务、光标随之平移、⌘Z 原样撤回；同 id 不起事务；BOM 留着；CRLF 文件不留 `\r`；
 *     整体缩进这种没法只改一行的写法回 false 不动文档；写完重挂的槽读到新行。
 *
 * jsdom 没有布局：CM6 量尺寸要的 Range#getClientRects / getBoundingClientRect 在这里补成空矩形。
 * 焦点镜像初值为 false，所以视图一建好卡片就是折叠态（已渲染的那张卡）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, undoDepth } from '@codemirror/commands'
import { frontmatterCard, type FrontmatterMetaMount } from './frontmatterCard'

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const V = '0199d3a2-0000-7000-8000-000000000000'
/** U+FEFF —— 写成字面量会被 lint 当成不规则空白 */
const BOM = String.fromCharCode(0xfeff)

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
})

type MountFn = (slot: HTMLElement, ctx: FrontmatterMetaMount) => (() => void) | void
type MountSpy = ReturnType<typeof vi.fn<MountFn>>

/** 建视图（挂进 document）；mount 不给 = 不提供接缝 */
function makeView(
  doc: string,
  opts: { mount?: MountSpy; readOnly?: boolean; extra?: Extension[] } = {}
): { view: EditorView; docChanges: () => number } {
  let changes = 0
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        frontmatterCard({ t: (key) => key, mountMetaStrip: opts.mount }),
        ...(opts.readOnly ? [EditorState.readOnly.of(true)] : []),
        ...(opts.extra ?? []),
        EditorView.updateListener.of((update) => {
          changes += update.transactions.filter((tr) => tr.docChanged).length
        })
      ]
    })
  })
  views.push(view)
  return { view, docChanges: () => changes }
}

/** frontmatter 行 + 正文；返回整份文档与 frontmatter 两条定界线之间的原文 */
const AGENT_LINES = ['shuvix: agent v1', 'name: meta-card', 'description: d']
const doc = (lines: string[] = AGENT_LINES, body = '\n# Body\n\nbody text\n'): string =>
  `---\n${lines.join('\n')}\n---\n${body}`

/** 最近一次挂载的上下文 */
const lastCtx = (mount: MountSpy): FrontmatterMetaMount => {
  const call = mount.mock.calls.at(-1)
  if (!call) throw new Error('mountMetaStrip was never called')
  return call[1]
}

describe('mountMetaStrip —— 槽位', () => {
  it('FC-M1 不给接缝 → 卡片照常渲染，没有 .cm-shuvix-fmcard-meta', () => {
    const { view } = makeView(doc())
    expect(view.dom.querySelector('.cm-shuvix-fmcard')).not.toBeNull()
    expect(view.dom.querySelector('.cm-shuvix-fmcard-meta')).toBeNull()
  })

  it('FC-M2 给了接缝 → 恰挂一次：markerType agent / yaml 是原文 / readOnly false；槽在卡片里、字段区之后；只读编辑器 → readOnly true', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const { view } = makeView(doc(), { mount })
    expect(mount).toHaveBeenCalledTimes(1)
    const [slot, ctx] = mount.mock.calls[0]
    expect(ctx).toMatchObject({
      markerType: 'agent',
      yaml: AGENT_LINES.join('\n'),
      readOnly: false
    })
    expect(typeof ctx.setObjectId).toBe('function')
    const card = view.dom.querySelector('.cm-shuvix-fmcard')!
    expect(slot.classList.contains('cm-shuvix-fmcard-meta')).toBe(true)
    expect(slot.parentElement).toBe(card)
    const rows = card.querySelector('.cm-shuvix-fmcard-rows')!
    expect(rows).not.toBeNull()
    expect(rows.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const ro: MountSpy = vi.fn<MountFn>()
    makeView(doc(), { mount: ro, readOnly: true })
    expect(ro).toHaveBeenCalledTimes(1)
    expect(lastCtx(ro).readOnly).toBe(true)
  })

  it('FC-M3 YAML 写坏（标记仍读得出）→ 卡片亮 YAML 错误，槽照样挂', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const { view } = makeView(doc(['shuvix: agent v1', 'name: x', 'broken: [unclosed']), { mount })
    expect(view.dom.querySelector('.cm-shuvix-fmcard-err')).not.toBeNull()
    expect(view.dom.querySelector('.cm-shuvix-fmcard-meta')).not.toBeNull()
    expect(mount).toHaveBeenCalledTimes(1)
    expect(lastCtx(mount).yaml).toContain('broken: [unclosed')
  })

  it('FC-M4 frontmatter 一变：上一次的收尾被调、带新原文重挂；销毁视图 → 收尾', () => {
    const cleanups: ReturnType<typeof vi.fn>[] = []
    const mount: MountSpy = vi.fn<MountFn>(() => {
      const cleanup = vi.fn()
      cleanups.push(cleanup)
      return cleanup
    })
    const { view } = makeView(doc(), { mount })
    expect(mount).toHaveBeenCalledTimes(1)
    const nameLine = view.state.doc.line(3)
    view.dispatch({ changes: { from: nameLine.from, to: nameLine.to, insert: 'name: renamed' } })
    expect(cleanups[0]).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledTimes(2)
    expect(lastCtx(mount).yaml).toContain('name: renamed')

    view.destroy()
    expect(cleanups[1]).toHaveBeenCalledTimes(1)
  })
})

describe('setObjectId —— 往缓冲区写 shuvix-id', () => {
  it('FC-M5 没有 id → true；id 行紧跟标记行、其余逐字节不变；恰一次事务；正文里的光标平移插入的长度；⌘Z 原样撤回', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const original = doc()
    const { view, docChanges } = makeView(original, { mount, extra: [history()] })
    const bodyPos = original.indexOf('body text')
    view.dispatch({ selection: EditorSelection.cursor(bodyPos) })

    expect(lastCtx(mount).setObjectId(U)).toBe(true)
    const expected = original.replace('shuvix: agent v1\n', `shuvix: agent v1\nshuvix-id: ${U}\n`)
    expect(view.state.doc.toString()).toBe(expected)
    expect(docChanges()).toBe(1)
    const inserted = `shuvix-id: ${U}\n`.length
    expect(view.state.selection.main.head).toBe(bodyPos + inserted)

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(original)
  })

  it('FC-M6 已有 U → 换成 V：只有 id 行变了，⌘Z 换回 U；写坏的 `shuvix-id: nope` 原位替换', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const withU = doc(['shuvix: agent v1', `shuvix-id: ${U}`, 'name: meta-card', 'description: d'])
    const { view } = makeView(withU, { mount, extra: [history()] })
    expect(lastCtx(mount).setObjectId(V)).toBe(true)
    expect(view.state.doc.toString()).toBe(withU.replace(`shuvix-id: ${U}`, `shuvix-id: ${V}`))
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(withU)

    const bad = doc(['shuvix: agent v1', 'name: meta-card', 'shuvix-id: nope', 'description: d'])
    const second: MountSpy = vi.fn<MountFn>()
    const { view: badView } = makeView(bad, { mount: second })
    expect(lastCtx(second).setObjectId(U)).toBe(true)
    expect(badView.state.doc.toString()).toBe(bad.replace('shuvix-id: nope', `shuvix-id: ${U}`))
  })

  it('FC-M7 同一个 id → true，不起事务，撤销栈深度不变', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const withU = doc(['shuvix: agent v1', `shuvix-id: ${U}`, 'name: meta-card'])
    const { view, docChanges } = makeView(withU, { mount, extra: [history()] })
    const depth = undoDepth(view.state)
    expect(lastCtx(mount).setObjectId(U)).toBe(true)
    expect(docChanges()).toBe(0)
    expect(undoDepth(view.state)).toBe(depth)
    expect(view.state.doc.toString()).toBe(withU)
  })

  it('FC-M8 文件以 BOM 开头 → BOM 留着，id 行照样落在标记之后', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const original = `${BOM}${doc()}`
    const { view } = makeView(original, { mount })
    expect(view.dom.querySelector('.cm-shuvix-fmcard')).not.toBeNull()
    expect(lastCtx(mount).setObjectId(U)).toBe(true)
    const text = view.state.doc.toString()
    expect(text.startsWith(`${BOM}---\n`)).toBe(true)
    expect(text).toBe(original.replace('shuvix: agent v1\n', `shuvix: agent v1\nshuvix-id: ${U}\n`))
  })

  it('FC-M8b CRLF 源文件 → id 行在、文档里没有落单的 \\r', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const { view } = makeView(doc().replace(/\n/g, '\r\n'), { mount })
    expect(lastCtx(mount).setObjectId(U)).toBe(true)
    const text = view.state.doc.toString()
    expect(text).toContain(`shuvix: agent v1\nshuvix-id: ${U}\nname: meta-card`)
    expect(text).not.toContain('\r')
  })

  it('FC-M9 整体缩进的 frontmatter：卡片照出，但 setObjectId 回 false、文档不动', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    const original = '---\n  shuvix: agent v1\n  name: x\n---\n\nbody\n'
    const { view, docChanges } = makeView(original, { mount })
    // 标记行容忍缩进 → 卡片在；没挂上就说明前提变了（这条用例会空转），直接报出来
    expect(view.dom.querySelector('.cm-shuvix-fmcard')).not.toBeNull()
    expect(lastCtx(mount).setObjectId(U)).toBe(false)
    expect(view.state.doc.toString()).toBe(original)
    expect(docChanges()).toBe(0)
  })

  it('FC-M10 写完重挂的槽：ctx.yaml 里有新的 id 行', () => {
    const mount: MountSpy = vi.fn<MountFn>()
    makeView(doc(), { mount })
    expect(lastCtx(mount).setObjectId(U)).toBe(true)
    expect(mount).toHaveBeenCalledTimes(2)
    expect(lastCtx(mount).yaml).toBe(
      ['shuvix: agent v1', `shuvix-id: ${U}`, 'name: meta-card', 'description: d'].join('\n')
    )
  })
})
