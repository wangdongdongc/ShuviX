/**
 * 主进程 ⇄ 组件宿主子进程（widgetHost.ts）的消息（Node IPC，`process.send` / `child.send`，JSON 序列化）。
 *
 * 组件宿主（设计稿 docs/widget-tool-design.md §6）：所有 SQLite 组件的 QuickJS 沙箱和数据库连接都住在这一个子进程里，
 * 主进程按需拉起；一次调用超时，主进程 SIGKILL 整个进程再拉起 —— better-sqlite3 没有暴露 `sqlite3_interrupt`，
 * 进程内打断不了一条执行很久的语句。
 */
import type { CallOutcome, OpMode, WidgetCaller } from './sandboxRuntime'

export type { CallOutcome, OpMode, WidgetCaller }

/** 一个组件在宿主里的位置：数据文件与当前生效的 API 快照 */
export interface WidgetHostTarget {
  widgetId: string
  /** `~/.shuvix/widgets-data/<id>/data.sqlite` */
  dbPath: string
}

export type HostRequestBody =
  | {
      type: 'call'
      target: WidgetHostTarget
      /** 生效快照的 API 包（宿主按 bundleHash 缓存热上下文；hash 变了就换新） */
      bundlePath: string
      bundleHash: string
      op: string
      /** 来自构建清单，不来自沙箱 —— 决定用只读还是读写连接 */
      mode: OpMode
      args: unknown
      caller: WidgetCaller
      /** 整个调用放进一个最后回滚的保存点（`widget` 工具 `call` 的 `dry_run`） */
      dryRun?: boolean
      /** 沙箱里纯计算的上限（QuickJS 中断回调），毫秒 */
      cpuMs: number
    }
  | {
      /** 在一个临时沙箱里执行刚打好的包，取清单（build 时） */
      type: 'manifest'
      bundleCode: string
      cpuMs: number
    }
  | { type: 'applySchema'; target: WidgetHostTarget; ddl: string }
  | { type: 'query'; target: WidgetHostTarget; sql: string }
  /** 扔掉这个组件的热上下文、关掉它的连接（重新构建、删除、迁移之前） */
  | { type: 'forget'; widgetId: string }

export type HostRequest = HostRequestBody & { id: number }

export interface CallResult {
  outcome: CallOutcome
  /** 这次调用有没有提交过写（决定是否推送 `data` 事件）；dry-run 恒为 false */
  wrote: boolean
  logs: string[]
}

export interface HostError {
  code: string
  message: string
}

export type HostResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: HostError }

/** 宿主启动完成后发的第一条消息 */
export interface HostReady {
  ready: true
}
