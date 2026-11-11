/**
 * 笔记里粘贴、拖入、插入文件（文件库 L1，设计稿 docs/file-library-design.md §5 与 docs/notebook-attachments-design.md §5）。
 *
 * 文件交给宿主存进库，光标处写一条 `shuvix://file/<id>/<文件名>` 链接。上传中的状态只是装饰（占位），绝不写进文档：
 * 文档会自动保存，agent 读的也是实时缓冲。成功时同一个事务里去掉占位、插入链接，进撤销历史；失败时占位变成错误提示，
 * 几秒后消失，文档不变。
 *
 * 必须以 `Prec.high` 装入，排在 CodeMirror 默认的 drop 处理（用 readAsText 把文件灌进文档）之前。
 */
import { Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/** 粘贴判定看到的一个文件 */
export interface PasteFileShape {
  /** 桌面窗口里从 Finder 复制来的文件有真实路径；截图、web 客户端没有 */
  path: string | null
}

/**
 * 粘贴的是附件还是文本。
 * 1. 有带真实路径的文件（桌面从 Finder 复制）→ 附件。
 * 2. 没有非空的 `text/plain`，有文件项 → 附件（截图、部分浏览器的图片复制）。
 * 3. 其余当文本：Word、Excel、Numbers 复制内容时会同时带文本和一张渲染图，不能把图当附件。
 */
export function classifyPaste(input: { files: PasteFileShape[]; text: string }): 'files' | 'text' {
  if (input.files.some((f) => !!f.path)) return 'files'
  if (input.files.length > 0 && input.text.trim() === '') return 'files'
  return 'text'
}

export type AttachSource = 'paste' | 'drop' | 'insert'

export type AttachOutcome = { ok: true; markdown: string } | { ok: false; message: string }

/** 要进库的一项：页面里的文件（粘贴、拖放、页面的文件选择框），或本机选择文件对话框给的路径 */
export interface AttachItem {
  name: string
  file?: File
  path?: string
}

export interface AttachmentsConfig {
  /** 这篇笔记能不能放文件（bot、agent、策略、hook 的 md 与只读内容不能） */
  attachable: boolean
  /** 一项交给宿主进库，返回要插入的 Markdown */
  attach: (item: AttachItem, source: AttachSource) => Promise<AttachOutcome>
  /** 桌面窗口取文件的真实路径（webUtils.getPathForFile）；web 客户端没有 */
  pathForFile?: (file: File) => string | null
  /** 本机的选择文件对话框（桌面）；取消 → null。不给 → 用页面的文件选择框 */
  pickFiles?: () => Promise<string[] | null>
  labels: {
    /** 占位：正在添加 `name` */
    adding: (name: string) => string
    /** 失败提示 */
    failed: (name: string, message: string) => string
    /** 这类笔记不能放文件 */
    notAttachable: string
  }
}

/** 错误提示留多久 */
const ERROR_LINGER_MS = 4000

interface Pending {
  id: number
  label: string
  error: boolean
  /** 同一批里的次序：同一位置的占位按它排（side 越大越靠后） */
  order: number
}

const addPending = StateEffect.define<{ id: number; pos: number; label: string; order: number }>({
  map: (v, mapping) => ({ ...v, pos: mapping.mapPos(v.pos, 1) })
})
const failPending = StateEffect.define<{ id: number; label: string; order: number }>()
const removePending = StateEffect.define<number>()

class PendingWidget extends WidgetType {
  constructor(readonly pending: Pending) {
    super()
  }
  eq(other: PendingWidget): boolean {
    return (
      other.pending.id === this.pending.id &&
      other.pending.label === this.pending.label &&
      other.pending.error === this.pending.error
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.pending.error ? 'cm-attach-pending cm-attach-error' : 'cm-attach-pending'
    el.setAttribute('data-attach-pending', String(this.pending.id))
    el.textContent = this.pending.label
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

function pendingWidget(p: Pending, pos: number): Range<Decoration> {
  return Decoration.widget({ widget: new PendingWidget(p), side: 1 + p.order }).range(pos)
}

const pendingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    let next = decos.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(addPending)) {
        next = next.update({
          add: [
            pendingWidget(
              { id: e.value.id, label: e.value.label, error: false, order: e.value.order },
              e.value.pos
            )
          ]
        })
      } else if (e.is(removePending)) {
        next = next.update({
          filter: (_from, _to, deco) => (deco.spec.widget as PendingWidget).pending.id !== e.value
        })
      } else if (e.is(failPending)) {
        const pos = pendingPos(next, e.value.id)
        if (pos === null) continue
        next = next
          .update({
            filter: (_from, _to, deco) =>
              (deco.spec.widget as PendingWidget).pending.id !== e.value.id
          })
          .update({
            add: [
              pendingWidget(
                { id: e.value.id, label: e.value.label, error: true, order: e.value.order },
                pos
              )
            ]
          })
      }
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f)
})

/** 占位此刻的位置（已被删掉 → null） */
function pendingPos(decos: DecorationSet, id: number): number | null {
  let found: number | null = null
  decos.between(0, Number.MAX_SAFE_INTEGER, (from, _to, deco) => {
    if ((deco.spec.widget as PendingWidget).pending.id === id) {
      found = from
      return false
    }
    return undefined
  })
  return found
}

let nextPendingId = 1

/**
 * 把一批文件逐个进库，按放入顺序写到 `pos`（彼此用换行分隔）。
 * `replaceSelection`：粘贴、插入时先删掉选区，占位放在选区起点；拖放不动选区。
 */
export async function attachFiles(
  view: EditorView,
  config: AttachmentsConfig,
  files: AttachItem[],
  pos: number,
  source: AttachSource,
  replaceSelection: boolean
): Promise<void> {
  if (files.length === 0 || view.state.readOnly) return
  let at = pos
  if (replaceSelection) {
    const sel = view.state.selection.main
    if (!sel.empty) {
      view.dispatch({
        changes: { from: sel.from, to: sel.to },
        selection: { anchor: sel.from },
        userEvent: source === 'drop' ? 'input.drop' : 'input.paste'
      })
    }
    at = sel.from
  }
  const ids = files.map(() => nextPendingId++)
  view.dispatch({
    effects: files.map((file, i) =>
      addPending.of({
        id: ids[i],
        pos: at,
        order: i,
        label: config.attachable
          ? config.labels.adding(file.name || 'file')
          : config.labels.notAttachable
      })
    )
  })
  let inserted = 0
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const id = ids[i]
    const outcome: AttachOutcome = config.attachable
      ? await config.attach(file, source).catch(
          (err: unknown): AttachOutcome => ({
            ok: false,
            message: err instanceof Error ? err.message : String(err)
          })
        )
      : { ok: false, message: config.labels.notAttachable }
    // 编辑器可能已经被卸载
    if (!view.dom.isConnected) return
    const where = pendingPos(view.state.field(pendingField, false) ?? Decoration.none, id)
    if (where === null) continue
    if (!outcome.ok) {
      const label = config.attachable
        ? config.labels.failed(file.name || 'file', outcome.message)
        : outcome.message
      view.dispatch({ effects: failPending.of({ id, label, order: i }) })
      setTimeout(() => {
        if (view.dom.isConnected) view.dispatch({ effects: removePending.of(id) })
      }, ERROR_LINGER_MS)
      continue
    }
    const text = (inserted > 0 ? '\n' : '') + outcome.markdown
    const sel = view.state.selection.main
    const follow = sel.empty && sel.head === where
    view.dispatch({
      changes: { from: where, insert: text },
      effects: removePending.of(id),
      ...(follow ? { selection: { anchor: where + text.length } } : {}),
      userEvent: source === 'drop' ? 'input.drop' : 'input.paste'
    })
    inserted++
  }
}

/** 目标在 input、textarea 或内层 contenteditable（表格单元格、属性卡）时不拦 */
function isNestedEditable(view: EditorView, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea')) return true
  const ce = target.closest('[contenteditable="true"], [contenteditable=""]')
  return !!ce && ce !== view.contentDOM
}

/** 页面里的文件 → 进库项 */
function itemsOf(files: File[]): AttachItem[] {
  return files.map((file) => ({ name: file.name, file }))
}

/** 选择文件（桌面：本机对话框；web：页面的文件选择框），把选中的写到光标处 */
export async function pickAndAttach(view: EditorView, config: AttachmentsConfig): Promise<void> {
  if (config.pickFiles) {
    const paths = await config.pickFiles()
    if (!paths || paths.length === 0) return
    const items = paths.map((path) => ({ name: path.split(/[/\\]/).pop() ?? path, path }))
    await attachFiles(view, config, items, view.state.selection.main.from, 'insert', true)
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    input.remove()
    if (files.length > 0) {
      void attachFiles(view, config, itemsOf(files), view.state.selection.main.from, 'insert', true)
    }
  })
  document.body.appendChild(input)
  input.click()
}

/** 编辑器扩展：拦下带文件的粘贴与拖放 */
export function attachmentsExtension(getConfig: () => AttachmentsConfig | null): Extension {
  return [
    pendingField,
    Prec.high(
      EditorView.domEventHandlers({
        paste(event, view) {
          const config = getConfig()
          if (!config?.attachable || view.state.readOnly) return false
          if (isNestedEditable(view, event.target)) return false
          const data = event.clipboardData
          if (!data) return false
          const files = Array.from(data.files ?? [])
          if (files.length === 0) return false
          const text = data.getData('text/plain') ?? ''
          const kind = classifyPaste({
            files: files.map((f) => ({ path: config.pathForFile?.(f) ?? null })),
            text
          })
          if (kind !== 'files') return false
          event.preventDefault()
          void attachFiles(
            view,
            config,
            itemsOf(files),
            view.state.selection.main.from,
            'paste',
            true
          )
          return true
        },
        drop(event, view) {
          const files = Array.from(event.dataTransfer?.files ?? [])
          if (files.length === 0) return false
          const config = getConfig()
          if (!config || view.state.readOnly) return false
          event.preventDefault()
          const pos =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.head
          void attachFiles(view, config, itemsOf(files), pos, 'drop', false)
          return true
        }
      })
    ),
    EditorView.baseTheme({
      '.cm-attach-pending': {
        display: 'inline-block',
        padding: '0 6px',
        margin: '0 2px',
        borderRadius: '4px',
        fontSize: '0.85em',
        opacity: '0.75',
        background: 'color-mix(in srgb, currentColor 8%, transparent)'
      },
      '.cm-attach-error': {
        opacity: '1',
        color: 'var(--color-danger, #d93025)',
        background: 'color-mix(in srgb, var(--color-danger, #d93025) 10%, transparent)'
      }
    })
  ]
}
