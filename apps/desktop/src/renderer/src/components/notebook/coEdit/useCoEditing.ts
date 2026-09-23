/**
 * 协作编辑的渲染端控制器（从系统打开的 md 窗口）。三件事：
 *
 *  1. **虚影**：订阅本会话的 `toolcall_generating`，doc_edit / doc_insert 的参数一边生成，一边从半截 JSON
 *     里取出定位原文与新内容，在目标处画虚影（coEditState）。
 *  2. **执行**：接主进程转来的 doc_* 请求（liveDocumentBridge），在编辑器的当前缓冲上当场执行 ——
 *     读就连同「用户在哪、改了什么」一起答；改就按原文定位、一次落下（不进撤销栈）。用户正在那一段
 *     打字（或输入法组字中）就先等他停手，最多等 MAX_WAIT_MS。请求逐个排队执行，彼此不交错。
 *  3. **指路**：落在屏幕外的改动、屏幕外正在写的虚影，以及「正在读」的一瞬，汇成提示条的状态。
 *
 * 外部写盘（别的程序改了文件）经 NotebookView 的 onExternalChange 交到这里做三方合并，同样不重挂载编辑器。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { ChangeSet, type Extension, type Text } from '@codemirror/state'
import type { LivePreviewEditorHandle } from '@shuvix/app-shell'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import {
  DOC_EDIT_TOOL,
  DOC_INSERT_TOOL,
  type LiveDocOp,
  type LiveDocRequest,
  type LiveDocResult,
  type LiveDocUserContext
} from '@shuvix/chat-protocol/liveDocument'
import {
  applyAgentChange,
  applyExternalChanges,
  clearGhost,
  coEditExtension,
  currentGhosts,
  offScreenSide,
  remoteChange,
  setGhost,
  unseenChanges,
  type Ghost,
  type GhostMode
} from './coEditState'
import {
  mergeExternalChange,
  partialJsonString,
  planDocChange,
  userChangesPatch,
  type DocChangePlan
} from './docOps'

/** 用户停手多久算「停下来了」 */
const IDLE_MS = 1500
/** 为等用户停手最多拖多久；过了就照常落下（事务会映射他的光标） */
const MAX_WAIT_MS = 10_000
/** 「正在读」提示亮多久 */
const READING_FLASH_MS = 1400
/** 选区回给 agent 时的上限 */
const MAX_SELECTION_CHARS = 600

export interface CoEditIndicator {
  reading: boolean
  /** 屏幕上方 / 下方还没被看见的改动数 */
  changesAbove: number
  changesBelow: number
  /** 正在写的虚影在屏幕外的哪一侧（在屏幕上 / 没有虚影为 null） */
  workingSide: 'above' | 'below' | null
}

const EMPTY_INDICATOR: CoEditIndicator = {
  reading: false,
  changesAbove: 0,
  changesBelow: 0,
  workingSide: null
}

type WriteOp = Exclude<LiveDocOp, { kind: 'read' }>

export interface CoEditing {
  /** 挂到编辑器上的 CM6 扩展（稳定引用） */
  extensions: readonly Extension[]
  /** 编辑器句柄 —— 交给 NotebookSession，这里经它拿 CM6 视图 */
  editorRef: React.RefObject<LivePreviewEditorHandle | null>
  /** 外部写盘的三方合并（交给 NotebookView.onExternalChange） */
  onExternalChange: (change: { disk: string; base: string; view: EditorView }) => boolean
  indicator: CoEditIndicator
  /** 把视图滚到提示条指的地方（最近一处没看见的改动 / 正在写的虚影） */
  reveal: () => void
}

export function useCoEditing(sessionId: string): CoEditing {
  const { t } = useTranslation()
  const editorRef = useRef<LivePreviewEditorHandle | null>(null)
  const [indicator, setIndicator] = useState<CoEditIndicator>(EMPTY_INDICATOR)

  // ─── 可变状态（都在 ref 里：事件回调与 CM6 监听器共用，不引起重渲染） ───
  /** 用户上一次改动文字的时刻（agent 与外部合并的事务不算） */
  const lastUserEditAt = useRef<number | null>(null)
  /**
   * 「自 agent 上次读以来用户改了什么」的账本（首次读之前为 null）：
   *  - base：agent 上次读到的全文；
   *  - userDoc：base 只叠上**用户**（及外部写盘）的改动之后的样子；
   *  - agent：从 userDoc 到编辑器当前文本的那些 agent 改动。
   * 用户的事务先映射过 agent 改动的逆（落到 userDoc 的坐标里）再叠上去，agent 改动再按它 rebase ——
   * 于是报给 agent 的 diff（base → userDoc）里只有用户的改动，它自己的修改不会被当成用户写的报回去，
   * 哪怕它改的是用户在它上次读之后才加的字。
   */
  const tracker = useRef<{ base: string; userDoc: Text; agent: ChangeSet } | null>(null)
  /** 正在生成的 doc_edit / doc_insert：toolCallId → 工具名 + 已到的参数 JSON */
  const streams = useRef(new Map<string, { toolName: string; json: string }>())
  /** 正在等用户停手的写请求：toolCallId → 等待中的模式，虚影据此显示「等你停下来」 */
  const waiting = useRef(new Set<string>())
  /** 被主进程撤回的请求 */
  const cancelled = useRef(new Set<string>())
  /** 请求串行执行 */
  const queue = useRef<Promise<void>>(Promise.resolve())
  const readingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readingRef = useRef(false)
  const refreshScheduled = useRef(false)

  const getView = useCallback((): EditorView | null => editorRef.current?.getView() ?? null, [])

  // ─── 提示条 ───────────────────────────────────────────
  const refreshIndicator = useCallback((): void => {
    if (refreshScheduled.current) return
    refreshScheduled.current = true
    requestAnimationFrame(() => {
      refreshScheduled.current = false
      const view = getView()
      if (!view) {
        setIndicator((prev) => (prev === EMPTY_INDICATOR ? prev : EMPTY_INDICATOR))
        return
      }
      const unseen = unseenChanges(view)
      const ghost = currentGhosts(view)[0]
      const next: CoEditIndicator = {
        reading: readingRef.current,
        changesAbove: unseen.above,
        changesBelow: unseen.below,
        workingSide: ghost ? offScreenSide(view, ghost.target?.from ?? ghost.anchor) : null
      }
      setIndicator((prev) =>
        prev.reading === next.reading &&
        prev.changesAbove === next.changesAbove &&
        prev.changesBelow === next.changesBelow &&
        prev.workingSide === next.workingSide
          ? prev
          : next
      )
    })
  }, [getView])

  const reveal = useCallback((): void => {
    const view = getView()
    if (!view) return
    const ghost = currentGhosts(view)[0]
    const target = ghost ? (ghost.target?.from ?? ghost.anchor) : unseenChanges(view).first
    if (target === undefined) return
    view.dispatch({ effects: EditorView.scrollIntoView(target, { y: 'center' }) })
  }, [getView])

  // ─── CM6 扩展：虚影 / 痕迹 + 旁听用户输入 ─────────────
  const extensions = useMemo<readonly Extension[]>(() => {
    const labels: Record<GhostMode, string> = {
      rewriting: t('notebook.coEdit.rewriting'),
      writing: t('notebook.coEdit.writing'),
      waiting: t('notebook.coEdit.waiting')
    }
    return [
      coEditExtension(labels),
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) {
          if (!tr.docChanged) continue
          const origin = tr.annotation(remoteChange)
          const byAgent = origin !== undefined && origin !== 'external'
          if (origin === undefined) lastUserEditAt.current = Date.now()
          const book = tracker.current
          if (!book) continue
          try {
            if (byAgent) {
              book.agent = book.agent.compose(tr.changes)
            } else {
              // 用户（或外部写盘）的改动：先落到「只有用户改动」的坐标里，再让 agent 的改动在它之上 rebase
              const mine = tr.changes.map(book.agent.invert(book.userDoc))
              book.userDoc = mine.apply(book.userDoc)
              book.agent = book.agent.map(mine)
            }
          } catch {
            // 账本对不上（理论上不该发生）：宁可下次读不报用户改动，也不能让编辑器的更新抛错
            tracker.current = null
          }
        }
        refreshIndicator()
      }),
      // 滚动发生在 scrollDOM 上（不冒泡到 contentDOM 的事件处理器）：提示条要跟着滚动更新
      ViewPlugin.define((view) => {
        const onScroll = (): void => refreshIndicator()
        view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
        return { destroy: () => view.scrollDOM.removeEventListener('scroll', onScroll) }
      })
    ]
    // 挂载时捕获一次：标签随语言变化要等下次开窗，与编辑器其他扩展同一规则
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── 虚影：从半截参数画出来 ───────────────────────────
  const ghostFrom = useCallback(
    (view: EditorView, id: string, toolName: string, json: string): Ghost | null => {
      const doc = view.state.doc
      const mode: GhostMode = waiting.current.has(id)
        ? 'waiting'
        : toolName === DOC_EDIT_TOOL
          ? 'rewriting'
          : 'writing'
      if (toolName === DOC_EDIT_TOOL) {
        const find = partialJsonString(json, 'find')
        if (!find?.complete) return null
        const plan = planDocChange(doc.toString(), {
          kind: 'edit',
          toolCallId: id,
          find: find.value,
          replace: ''
        })
        if (!plan.ok) return null
        const text = partialJsonString(json, 'replace')?.value ?? ''
        return {
          id,
          target: { from: plan.from, to: plan.to },
          anchor: doc.lineAt(plan.to).to,
          above: false,
          text,
          mode
        }
      }
      const after = partialJsonString(json, 'after')
      const before = partialJsonString(json, 'before')
      if ((after && !after.complete) || (before && !before.complete)) return null
      const text = partialJsonString(json, 'text')
      if (!after && !before && !text) return null
      const plan = planDocChange(doc.toString(), {
        kind: 'insert',
        toolCallId: id,
        text: '',
        ...(after ? { after: after.value } : {}),
        ...(before ? { before: before.value } : {})
      })
      if (!plan.ok) return null
      const above = !!before
      return {
        id,
        anchor: above ? doc.lineAt(plan.from).from : doc.lineAt(plan.from).to,
        above,
        text: text?.value ?? '',
        mode
      }
    },
    []
  )

  const drawGhost = useCallback(
    (id: string): void => {
      const view = getView()
      const stream = streams.current.get(id)
      if (!view || !stream) return
      const ghost = ghostFrom(view, id, stream.toolName, stream.json)
      if (ghost) view.dispatch({ effects: setGhost.of(ghost) })
    },
    [getView, ghostFrom]
  )

  const dropGhost = useCallback(
    (id: string): void => {
      streams.current.delete(id)
      const view = getView()
      if (view && currentGhosts(view).some((g) => g.id === id)) {
        view.dispatch({ effects: clearGhost.of(id) })
      }
    },
    [getView]
  )

  // ─── 请求执行 ─────────────────────────────────────────
  const userContext = useCallback((view: EditorView): LiveDocUserContext => {
    const { state } = view
    const sel = state.selection.main
    const cursorLine = state.doc.lineAt(sel.head).number
    // 光标之上最近的标题：从头扫到光标行，跳过代码围栏里的 `#` 行（那是代码不是标题）
    let section: string | undefined
    let fence: string | null = null
    for (let n = 1; n <= cursorLine; n++) {
      const text = state.doc.line(n).text
      const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1]
      if (marker) {
        if (fence === null) fence = marker[0]
        else if (marker[0] === fence) fence = null
        continue
      }
      if (fence === null && /^#{1,6}\s/.test(text)) section = text.trim()
    }
    const selected = sel.empty ? undefined : state.sliceDoc(sel.from, sel.to)
    const box = view.scrollDOM.getBoundingClientRect()
    const x = box.left + box.width / 2
    const topPos = view.posAtCoords({ x, y: box.top + 2 }, false)
    const bottomPos = view.posAtCoords({ x, y: box.bottom - 2 }, false)
    return {
      cursorLine,
      ...(section ? { section } : {}),
      ...(selected
        ? {
            selection:
              selected.length > MAX_SELECTION_CHARS
                ? `${selected.slice(0, MAX_SELECTION_CHARS)}…`
                : selected
          }
        : {}),
      visibleFromLine: state.doc.lineAt(topPos).number,
      visibleToLine: state.doc.lineAt(bottomPos).number,
      lastEditAgoMs: lastUserEditAt.current === null ? null : Date.now() - lastUserEditAt.current
    }
  }, [])

  /** 用户此刻是不是正在这段改动附近打字（或输入法组字中） */
  const userBusyNear = useCallback(
    (view: EditorView, plan: { from: number; to: number }): boolean => {
      if (view.composing) return true
      const last = lastUserEditAt.current
      if (last === null || Date.now() - last >= IDLE_MS) return false
      const doc = view.state.doc
      const caretLine = doc.lineAt(view.state.selection.main.head).number
      const fromLine = doc.lineAt(plan.from).number
      const toLine = doc.lineAt(plan.to).number
      return caretLine >= fromLine - 1 && caretLine <= toLine + 1
    },
    []
  )

  const flashReading = useCallback((): void => {
    readingRef.current = true
    if (readingTimer.current) clearTimeout(readingTimer.current)
    readingTimer.current = setTimeout(() => {
      readingRef.current = false
      refreshIndicator()
    }, READING_FLASH_MS)
    refreshIndicator()
  }, [refreshIndicator])

  const runWrite = useCallback(
    async (requestId: string, op: WriteOp): Promise<LiveDocResult | null> => {
      const view = getView()
      if (!view)
        return { ok: false, error: 'The document is not ready yet; try again in a moment.' }
      let plan: DocChangePlan = planDocChange(view.state.doc.toString(), op)
      if (!plan.ok) {
        dropGhost(op.toolCallId)
        return plan
      }
      // 用户正在这一段打字：虚影改成「等你停下来」，等他停手（或到上限）再落下；等的期间他可能
      // 改掉了原文，所以每轮都重新定位
      const started = Date.now()
      if (userBusyNear(view, plan)) {
        waiting.current.add(op.toolCallId)
        if (!streams.current.has(op.toolCallId)) {
          streams.current.set(op.toolCallId, {
            toolName: op.kind === 'edit' ? DOC_EDIT_TOOL : DOC_INSERT_TOOL,
            json: JSON.stringify(op.kind === 'edit' ? { find: op.find, replace: op.replace } : op)
          })
        }
        drawGhost(op.toolCallId)
        while (plan.ok && userBusyNear(view, plan) && Date.now() - started < MAX_WAIT_MS) {
          await new Promise((r) => setTimeout(r, 200))
          if (cancelled.current.has(requestId)) break
          plan = planDocChange(view.state.doc.toString(), op)
        }
        waiting.current.delete(op.toolCallId)
      }
      if (cancelled.current.has(requestId)) {
        cancelled.current.delete(requestId)
        dropGhost(op.toolCallId)
        return null
      }
      if (!plan.ok) {
        dropGhost(op.toolCallId)
        return plan
      }
      const current = getView()
      if (!current) return { ok: false, error: 'The document window is closing.' }
      applyAgentChange(current, { id: op.toolCallId, ...plan })
      streams.current.delete(op.toolCallId)
      const doc = current.state.doc
      // 报「新内容从哪一行开始」：插入常以换行开头（接在锚点之后），跳过那几个换行
      const leading = /^\n*/.exec(plan.insert)?.[0].length ?? 0
      const firstLine = doc.lineAt(Math.min(plan.from + leading, doc.length)).number
      const lastLine = doc.lineAt(Math.min(plan.from + plan.insert.length, doc.length)).number
      const fromLine = Math.max(1, doc.lineAt(plan.from).number - 1)
      const toLine = Math.min(doc.lines, Math.max(lastLine + 1, fromLine), fromLine + 24)
      const width = String(toLine).length
      const context: string[] = []
      for (let n = fromLine; n <= toLine; n++) {
        context.push(`${String(n).padStart(width, ' ')}│${doc.line(n).text}`)
      }
      refreshIndicator()
      const waited = Date.now() - started
      return {
        ok: true,
        kind: op.kind,
        line: firstLine,
        context: context.join('\n'),
        waitedMs: waited > 250 ? waited : 0
      }
    },
    [getView, dropGhost, drawGhost, userBusyNear, refreshIndicator]
  )

  const handleRequest = useCallback(
    async (request: LiveDocRequest): Promise<void> => {
      const { requestId, op } = request
      // 排队期间被撤回（工具已中止 / 超时）：不执行 —— 尤其不能让一次没人收的读把账本往前推
      if (cancelled.current.delete(requestId)) return
      let result: LiveDocResult | null
      if (op.kind === 'read') {
        const view = getView()
        if (!view) {
          result = { ok: false, error: 'The document is not ready yet; try again in a moment.' }
        } else {
          const text = view.state.doc.toString()
          const book = tracker.current
          const userChanges = book
            ? userChangesPatch(book.base, book.userDoc.toString())
            : undefined
          tracker.current = {
            base: text,
            userDoc: view.state.doc,
            agent: ChangeSet.empty(view.state.doc.length)
          }
          flashReading()
          result = {
            ok: true,
            kind: 'read',
            text,
            user: userContext(view),
            ...(userChanges ? { userChanges } : {})
          }
        }
      } else {
        result = await runWrite(requestId, op)
      }
      cancelled.current.delete(requestId)
      if (result) await window.api.liveDoc.respond(requestId, result)
    },
    [getView, runWrite, userContext, flashReading]
  )

  // ─── 订阅：主进程的请求 / 撤回、本会话的流式参数 ─────────
  useEffect(() => {
    const offRequest = window.api.liveDoc.onRequest((request) => {
      if (request.sessionId !== sessionId) return
      queue.current = queue.current.then(() => handleRequest(request)).catch(() => {})
    })
    const offCancel = window.api.liveDoc.onCancel(({ requestId }) => {
      // 撤回可能晚于执行完成到达：记下的 id 只在执行时被取走，给集合一个上限免得只进不出
      if (cancelled.current.size > 200) cancelled.current.clear()
      cancelled.current.add(requestId)
    })
    let frame: number | null = null
    const dirty = new Set<string>()
    const offEvent = window.api.agent.onEvent((event: ChatEvent) => {
      if (event.sessionId !== sessionId) return
      if (event.type === 'toolcall_generating') {
        if (event.toolName !== DOC_EDIT_TOOL && event.toolName !== DOC_INSERT_TOOL) return
        if (!event.toolCallId) return
        const stream = streams.current.get(event.toolCallId) ?? {
          toolName: event.toolName,
          json: ''
        }
        stream.json += event.argsDelta ?? ''
        streams.current.set(event.toolCallId, stream)
        dirty.add(event.toolCallId)
        // 增量逐 token 到：一帧画一次
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null
            for (const id of dirty) drawGhost(id)
            dirty.clear()
          })
        }
      } else if (event.type === 'tool_end') {
        dropGhost(event.toolCallId)
      } else if (event.type === 'agent_end' || event.type === 'error') {
        for (const id of [...streams.current.keys()]) dropGhost(id)
        const view = getView()
        if (view) {
          for (const g of currentGhosts(view)) view.dispatch({ effects: clearGhost.of(g.id) })
        }
      }
    })
    return () => {
      offRequest()
      offCancel()
      offEvent()
      if (frame !== null) cancelAnimationFrame(frame)
      if (readingTimer.current) clearTimeout(readingTimer.current)
    }
  }, [sessionId, handleRequest, drawGhost, dropGhost, getView])

  // ─── 外部写盘：三方合并，不重挂载 ─────────────────────
  const onExternalChange = useCallback(
    ({ disk, base, view }: { disk: string; base: string; view: EditorView }): boolean => {
      const changes = mergeExternalChange(base, view.state.doc.toString(), disk)
      applyExternalChanges(view, changes)
      return true
    },
    []
  )

  return { extensions, editorRef, onExternalChange, indicator, reveal }
}
