/**
 * 协作编辑（live document）—— agent 与用户同时编辑同一份 md 的请求 / 结果契约。
 *
 * 场景：从系统打开的 md 窗口。窗口开着的时候，**编辑器里的那份内容才是事实源**（磁盘只是它的
 * 存档，由编辑器的自动保存写）。agent 不经文件工具改盘，而是用 `doc_*` 工具：主进程把请求转给
 * 那个窗口的渲染进程，在编辑器的当前缓冲上当场执行 —— 按原文定位、一次落下、不进用户的撤销栈；
 * 用户正在那一段打字就等他停手。于是没有「写盘 → 重载」，也就没有互相覆盖。
 *
 * 纯类型与常量，两个进程共用；执行在渲染进程（desktop renderer components/notebook/coEdit/），转发在主进程
 * （desktop services/liveDocumentBridge.ts），工具面在 desktop tools/doc.ts。
 */

/** 三个协作编辑工具的名字（工具名也是渲染端识别流式参数、画虚影的依据） */
export const DOC_READ_TOOL = 'doc_read'
export const DOC_EDIT_TOOL = 'doc_edit'
export const DOC_INSERT_TOOL = 'doc_insert'

export type LiveDocOp =
  | { kind: 'read' }
  | {
      kind: 'edit'
      /** 这次工具调用的 id —— 渲染端据此收掉生成期间画的那个虚影 */
      toolCallId: string
      find: string
      replace: string
    }
  | {
      kind: 'insert'
      toolCallId: string
      text: string
      /** 插在这段原文之后（与 before 互斥；都不给 = 文末） */
      after?: string
      /** 插在这段原文之前 */
      before?: string
    }

/** 主进程 → 渲染进程 */
export interface LiveDocRequest {
  requestId: string
  sessionId: string
  op: LiveDocOp
}

/** 用户此刻在哪、在干什么（doc_read 附带给 agent） */
export interface LiveDocUserContext {
  /** 光标所在行（1 起） */
  cursorLine: number
  /** 光标所在的最近一级标题（原样，如 `## 安装`）；文首之前没有标题时缺省 */
  section?: string
  /** 选中的文字（截断过）；没有选区时缺省 */
  selection?: string
  /** 屏幕上可见的行（1 起，闭区间） */
  visibleFromLine: number
  visibleToLine: number
  /** 距离用户上一次改动文字过了多少毫秒；打开以来没改过为 null */
  lastEditAgoMs: number | null
}

export type LiveDocResult =
  | {
      ok: true
      kind: 'read'
      /** 编辑器里此刻的全文（含尚未存盘的输入） */
      text: string
      user: LiveDocUserContext
      /**
       * 自 agent 上次 doc_read 以来用户做的改动（统一 diff，已截断）；首次读取或没有改动时缺省。
       * agent 自己的修改不算在内。
       */
      userChanges?: string
    }
  | {
      ok: true
      kind: 'edit' | 'insert'
      /** 改动落下后所在的行（1 起） */
      line: number
      /** 落点附近的当前文本（几行），让 agent 不必为确认再读一遍全文 */
      context: string
      /** 为等用户停手而延后的毫秒数（没等为 0） */
      waitedMs: number
    }
  | { ok: false; error: string }
