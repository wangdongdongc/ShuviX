/**
 * 协作编辑的 CM6 一侧 —— agent 在编辑器里「在场」的样子：
 *
 *  - **虚影**：agent 还在写 doc_edit / doc_insert 的参数时，目标段落被虚线标出，新内容以虚影块出现在
 *    段落之下（带「ShuviX 正在改写这里」的标签）。虚影不是文档的一部分，不进撤销、不触发保存；
 *    调用真正执行时它被收掉，改动一次落下。
 *  - **改动痕迹**：落下的改动先高亮，**用户看见之后**才开始淡出（落在屏幕外的一直亮着，由窗口里的
 *    提示条指路）；纯删除留一道细竖线。
 *  - **撤销分开**：agent 的事务带 `Transaction.addToHistory.of(false)` —— ⌘Z 只撤用户自己的输入，
 *    用户的历史在它周围映射，不会被 agent 的改动打乱。
 *
 * 这里只有状态与渲染；什么时候画虚影、什么时候落下，由 useCoEditing 决定。
 */
import {
  Annotation,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
  type ChangeSet
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view'

/** 标记「这次事务不是用户打的字」：agent 的修改（值 = 工具调用 id）与外部写盘的合并（值 = 'external'） */
export const remoteChange = Annotation.define<string>()

/** 改动痕迹被用户看见后，淡出用多久（与 CSS 动画同步） */
const FADE_MS = 2600

export type GhostMode = 'rewriting' | 'writing' | 'waiting'

export interface Ghost {
  /** 工具调用 id */
  id: string
  /** 被改写的原文范围（doc_edit）；doc_insert 没有 */
  target?: { from: number; to: number }
  /** 虚影块挂在哪个位置（所在行之后 / 之前） */
  anchor: number
  /** 挂在锚点所在行之前（doc_insert 的 before）而不是之后 */
  above: boolean
  /** 目前写出来的新内容 */
  text: string
  mode: GhostMode
}

/** 改动痕迹是谁留下的：agent 的修改，还是别的程序写盘后并进来的 */
export type ChangeOrigin = 'agent' | 'external'

export interface ChangeMark {
  id: number
  origin: ChangeOrigin
  from: number
  to: number
  /** 用户第一次看见它的时刻；null = 还没进过屏幕 */
  seenAt: number | null
}

export const setGhost = StateEffect.define<Ghost>()
export const clearGhost = StateEffect.define<string>()
const addChangeMarks = StateEffect.define<{
  origin: ChangeOrigin
  ranges: Array<{ from: number; to: number }>
}>()
const markSeen = StateEffect.define<number[]>()
const dropChangeMarks = StateEffect.define<number[]>()

function mapGhost(ghost: Ghost, changes: ChangeSet): Ghost {
  return {
    ...ghost,
    anchor: changes.mapPos(ghost.anchor, ghost.above ? -1 : 1),
    target: ghost.target
      ? { from: changes.mapPos(ghost.target.from, 1), to: changes.mapPos(ghost.target.to, -1) }
      : undefined
  }
}

export const ghostField = StateField.define<readonly Ghost[]>({
  create: () => [],
  update(ghosts, tr) {
    let next = tr.docChanged ? ghosts.map((g) => mapGhost(g, tr.changes)) : ghosts
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) {
        const ghost = effect.value
        next = [...next.filter((g) => g.id !== ghost.id), ghost]
      } else if (effect.is(clearGhost)) {
        next = next.filter((g) => g.id !== effect.value)
      }
    }
    return next
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghosts) => {
      const ranges: Range<Decoration>[] = []
      for (const ghost of ghosts) {
        if (ghost.target && ghost.target.to > ghost.target.from) {
          ranges.push(ghostTargetMark.range(ghost.target.from, ghost.target.to))
        }
        ranges.push(
          Decoration.widget({
            widget: new GhostWidget(ghost.text, ghost.mode),
            block: true,
            side: ghost.above ? -1 : 1
          }).range(ghost.anchor)
        )
      }
      return Decoration.set(ranges, true)
    })
})

let nextMarkId = 1

export const changeMarkField = StateField.define<readonly ChangeMark[]>({
  create: () => [],
  update(marks, tr) {
    let next = marks
    if (tr.docChanged) {
      next = next.map((m) => ({
        ...m,
        from: tr.changes.mapPos(m.from, 1),
        to: tr.changes.mapPos(m.to, -1)
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addChangeMarks)) {
        const { origin, ranges } = effect.value
        next = [
          ...next,
          ...ranges.map((r) => ({ id: nextMarkId++, origin, from: r.from, to: r.to, seenAt: null }))
        ]
      } else if (effect.is(markSeen)) {
        const ids = new Set(effect.value)
        const now = Date.now()
        next = next.map((m) => (ids.has(m.id) && m.seenAt === null ? { ...m, seenAt: now } : m))
      } else if (effect.is(dropChangeMarks)) {
        const ids = new Set(effect.value)
        next = next.filter((m) => !ids.has(m.id))
      }
    }
    return next
  },
  provide: (field) =>
    EditorView.decorations.from(field, (marks) => {
      const ranges: Range<Decoration>[] = []
      for (const m of marks) {
        const base =
          m.origin === 'external' ? 'cm-coedit-change cm-coedit-external' : 'cm-coedit-change'
        const cls = m.seenAt === null ? base : `${base} cm-coedit-fading`
        if (m.to > m.from) ranges.push(Decoration.mark({ class: cls }).range(m.from, m.to))
        else
          ranges.push(
            Decoration.widget({ widget: new DeletionWidget(m.seenAt !== null), side: 1 }).range(
              m.from
            )
          )
      }
      return Decoration.set(ranges, true)
    })
})

const ghostTargetMark = Decoration.mark({ class: 'cm-coedit-target' })

/** 虚影块的标签文字由宿主注入（i18n）；缺省英文 */
let ghostLabels: Record<GhostMode, string> = {
  rewriting: 'ShuviX is rewriting this',
  writing: 'ShuviX is writing',
  waiting: 'ShuviX is waiting for you to pause'
}

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly mode: GhostMode
  ) {
    super()
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text && other.mode === this.mode
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-coedit-ghost'
    box.dataset.mode = this.mode
    box.setAttribute('aria-hidden', 'true')
    const label = document.createElement('div')
    label.className = 'cm-coedit-ghost-label'
    label.textContent = ghostLabels[this.mode]
    box.appendChild(label)
    if (this.text) {
      const body = document.createElement('div')
      body.className = 'cm-coedit-ghost-text'
      body.textContent = this.text
      box.appendChild(body)
    }
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

class DeletionWidget extends WidgetType {
  constructor(readonly fading: boolean) {
    super()
  }

  eq(other: DeletionWidget): boolean {
    return other.fading === this.fading
  }

  toDOM(): HTMLElement {
    const bar = document.createElement('span')
    bar.className = this.fading ? 'cm-coedit-deletion cm-coedit-fading' : 'cm-coedit-deletion'
    bar.setAttribute('aria-hidden', 'true')
    return bar
  }
}

/** 位置此刻是否在屏幕上（渲染出来且落在滚动区的可见高度内） */
export function isOnScreen(view: EditorView, pos: number): boolean {
  const coords = view.coordsAtPos(Math.min(pos, view.state.doc.length))
  if (!coords) return false
  const box = view.scrollDOM.getBoundingClientRect()
  return coords.bottom > box.top && coords.top < box.bottom
}

/** 位置在屏幕之上 / 之下（不在屏幕上时） */
export function offScreenSide(view: EditorView, pos: number): 'above' | 'below' | null {
  if (isOnScreen(view, pos)) return null
  // 滚动区顶边处的文档位置：在它之前就是「上方」
  const box = view.scrollDOM.getBoundingClientRect()
  const topPos = view.posAtCoords({ x: box.left + box.width / 2, y: box.top + 2 }, false)
  return pos < topPos ? 'above' : 'below'
}

/** 还没被看见的 agent 改动，按在屏幕之上 / 之下计数（外部写盘并进来的不算 —— 那不是 ShuviX 改的） */
export function unseenChanges(view: EditorView): { above: number; below: number; first?: number } {
  let above = 0
  let below = 0
  let first: number | undefined
  for (const m of view.state.field(changeMarkField)) {
    if (m.seenAt !== null || m.origin !== 'agent') continue
    const side = offScreenSide(view, m.from)
    if (side === 'above') above++
    else if (side === 'below') below++
    else continue
    first ??= m.from
  }
  return { above, below, first }
}

export function currentGhosts(view: EditorView): readonly Ghost[] {
  return view.state.field(ghostField)
}

/**
 * 看见即开始淡出：每次视图更新、每次滚动都检查一遍还没看见的痕迹；进了屏幕就记下时刻，
 * 淡出动画放完再把它移除。检查的结果经 dispatch 生效，所以挪到更新之外（CM6 不许在更新中派发）。
 */
const seenTracker = ViewPlugin.fromClass(
  class {
    private scheduled = false
    private destroyed = false
    private readonly onScroll = (): void => this.schedule()

    constructor(readonly view: EditorView) {
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule()
      else if (update.transactions.some((tr) => tr.effects.some((e) => e.is(addChangeMarks)))) {
        this.schedule()
      }
    }

    private schedule(): void {
      if (this.scheduled) return
      this.scheduled = true
      requestAnimationFrame(() => {
        this.scheduled = false
        if (!this.destroyed) this.check()
      })
    }

    private check(): void {
      const marks = this.view.state.field(changeMarkField, false)
      if (!marks) return
      const seen = marks.filter((m) => m.seenAt === null && isOnScreen(this.view, m.from))
      if (seen.length === 0) return
      const ids = seen.map((m) => m.id)
      this.view.dispatch({ effects: markSeen.of(ids) })
      setTimeout(() => {
        if (!this.destroyed) this.view.dispatch({ effects: dropChangeMarks.of(ids) })
      }, FADE_MS)
    }

    destroy(): void {
      this.destroyed = true
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    }
  }
)

const coEditTheme = EditorView.baseTheme({
  '.cm-coedit-target': {
    backgroundColor: 'rgba(139, 92, 246, 0.08)',
    textDecoration: 'line-through',
    textDecorationColor: 'rgba(139, 92, 246, 0.55)',
    textDecorationThickness: '1px'
  },
  '.cm-coedit-ghost': {
    margin: '4px 0 6px',
    padding: '6px 10px 8px',
    borderLeft: '2px solid rgba(139, 92, 246, 0.7)',
    borderRadius: '4px',
    backgroundColor: 'rgba(139, 92, 246, 0.07)',
    fontStyle: 'italic',
    opacity: '0.85',
    animation: 'cm-coedit-breathe 1.8s ease-in-out infinite'
  },
  '.cm-coedit-ghost-label': {
    fontSize: '0.75em',
    fontStyle: 'normal',
    fontWeight: '600',
    letterSpacing: '0.02em',
    color: 'rgb(139, 92, 246)',
    marginBottom: '2px'
  },
  '.cm-coedit-ghost[data-mode="waiting"] .cm-coedit-ghost-label': {
    color: 'rgba(139, 92, 246, 0.75)'
  },
  '.cm-coedit-ghost-text': {
    whiteSpace: 'pre-wrap',
    color: 'var(--color-text-secondary, inherit)'
  },
  '.cm-coedit-change': {
    backgroundColor: 'rgba(139, 92, 246, 0.22)',
    borderRadius: '2px'
  },
  '.cm-coedit-external': {
    backgroundColor: 'rgba(148, 163, 184, 0.22)'
  },
  '.cm-coedit-deletion': {
    display: 'inline-block',
    width: '2px',
    height: '1.1em',
    verticalAlign: 'text-bottom',
    backgroundColor: 'rgba(139, 92, 246, 0.8)'
  },
  '.cm-coedit-fading': {
    animation: `cm-coedit-fade ${FADE_MS}ms ease-out forwards`
  },
  '.cm-coedit-external.cm-coedit-fading': {
    animation: `cm-coedit-fade-external ${FADE_MS}ms ease-out forwards`
  },
  '@keyframes cm-coedit-fade-external': {
    '0%': { backgroundColor: 'rgba(148, 163, 184, 0.3)' },
    '100%': { backgroundColor: 'rgba(148, 163, 184, 0)' }
  },
  '@keyframes cm-coedit-fade': {
    '0%': { backgroundColor: 'rgba(139, 92, 246, 0.32)' },
    '100%': { backgroundColor: 'rgba(139, 92, 246, 0)' }
  },
  '@keyframes cm-coedit-breathe': {
    '0%, 100%': { opacity: '0.85' },
    '50%': { opacity: '0.55' }
  }
})

/** 协作编辑的 CM6 扩展（挂载时一次）；标签文字按当前语言传入 */
export function coEditExtension(labels: Record<GhostMode, string>): Extension {
  ghostLabels = labels
  return [ghostField, changeMarkField, seenTracker, coEditTheme]
}

/**
 * 把 agent 的一次修改落进编辑器：一个事务里完成改动、收掉它的虚影、留下改动痕迹。
 * 不进撤销历史（⌘Z 只撤用户自己的输入），标注 remoteChange 让自动保存之外的旁听者认得它不是用户打的。
 */
export function applyAgentChange(
  view: EditorView,
  change: { id: string; from: number; to: number; insert: string }
): void {
  const end = change.from + change.insert.length
  view.dispatch({
    changes: { from: change.from, to: change.to, insert: change.insert },
    effects: [
      clearGhost.of(change.id),
      addChangeMarks.of({ origin: 'agent', ranges: [{ from: change.from, to: end }] })
    ],
    annotations: [remoteChange.of(change.id), Transaction.addToHistory.of(false)]
  })
}

/** 把外部写盘的改动并进编辑器（三方合并的结果）：同样不进撤销历史、留下痕迹 */
export function applyExternalChanges(view: EditorView, changes: ChangeSet): void {
  if (changes.empty) return
  const marks: Array<{ from: number; to: number }> = []
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => marks.push({ from: fromB, to: toB }))
  view.dispatch({
    changes,
    effects: addChangeMarks.of({ origin: 'external', ranges: marks }),
    annotations: [remoteChange.of('external'), Transaction.addToHistory.of(false)]
  })
}
