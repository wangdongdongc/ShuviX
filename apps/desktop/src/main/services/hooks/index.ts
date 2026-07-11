/**
 * Hook 模块对外入口 —— HookService 单例
 *
 * 协议、事件、配置 schema 详见同目录 [types.ts](./types.ts)。
 */

import { HookEngine } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { matchHook } from './hookMatcher'
import { runHookProcess } from './hookRunner'
import {
  globalHookFile,
  projectHookFile,
  watchHookFiles,
  type ConfigWatcher,
  type LoadedConfig
} from './hookConfig'
import type {
  BuiltinHookEntry,
  HookEntry,
  HookEvent,
  HookFileStatus,
  HookFirer,
  HookInput,
  HookOutput,
  HookSource,
  ResolvedHook
} from './types'

const log = createLogger('HookService')

const COMMAND_DEFAULT_TIMEOUT_SEC = 30

/**
 * 桌面 HookService —— 组合各端共享的 {@link HookEngine}（内置 hook 引擎）并在其后
 * 追加 global/project command 层（子进程 + 文件监听，桌面专属）。
 *
 * 实现 {@link HookFirer}：`fire()` 先跑内置（deny 短路），再跑 command。
 */
export class HookService implements HookFirer {
  /** 内置 hook 引擎（与扩展共享同一实现）；registerBuiltin/内置执行全部委托它 */
  private engine = new HookEngine(log)
  private currentProjectDir: string | undefined
  private watcher: ConfigWatcher | undefined
  private loaded: Map<HookSource, LoadedConfig> = new Map()

  /** 注册内置 hook（委托共享引擎）。由启动序列在 watcher 启动前调用。 */
  registerBuiltin(event: HookEvent, matcher: string, entry: Omit<BuiltinHookEntry, 'type'>): void {
    this.engine.registerBuiltin(event, matcher, entry)
  }

  /** 启动文件监听。projectDir 可在运行期通过 setProjectDir 切换。 */
  start(projectDir?: string): void {
    this.currentProjectDir = projectDir
    this.restartWatcher()
  }

  /** 切换当前项目时调用 */
  setProjectDir(projectDir: string | undefined): void {
    if (this.currentProjectDir === projectDir) return
    this.currentProjectDir = projectDir
    this.restartWatcher()
  }

  /** 手动 reload —— 给 UI 兜底，watcher 已自动 reload */
  reload(): void {
    this.watcher?.reload()
  }

  /** 关闭 watcher（应用退出时调用） */
  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = undefined
  }

  /** 各文件加载状态 —— 设置页 UI 用 */
  status(): { global: HookFileStatus; project: HookFileStatus } {
    return {
      global: this.loaded.get('global')?.status ?? { ok: true, count: 0 },
      project: this.loaded.get('project')?.status ?? { ok: true, count: 0 }
    }
  }

  /** 合并后的 hook 列表（默认隐藏 builtin） */
  list(opts?: { includeBuiltin?: boolean }): ResolvedHook[] {
    const result: ResolvedHook[] = []
    if (opts?.includeBuiltin) {
      result.push(...this.engine.listBuiltins())
    }
    for (const source of ['global', 'project'] as const) {
      const cfg = this.loaded.get(source)
      if (!cfg) continue
      for (const [event, groups] of cfg.groups) {
        for (const g of groups) {
          for (const h of g.hooks) {
            result.push({
              event,
              matcher: g.matcher || '*',
              source,
              description: h.command,
              timeout: h.timeout ?? COMMAND_DEFAULT_TIMEOUT_SEC
            })
          }
        }
      }
    }
    return result
  }

  /**
   * 触发一个事件。按 (builtin → global → project) 顺序串行执行所有匹配 hook，
   * 任一返回 `permissionDecision: 'deny'` 立即短路。
   * 内置层委托共享 {@link HookEngine}；command 层为桌面专属。
   */
  async fire(event: HookEvent, input: HookInput): Promise<HookOutput[]> {
    // ① 内置 hook（共享引擎，内部已 deny 短路）
    const outputs = await this.engine.fire(event, input)
    if (outputs.some((o) => o.hookSpecificOutput?.permissionDecision === 'deny')) {
      return outputs
    }

    // ② global / project command hook（桌面专属）
    const target = input.tool_name ?? ''
    for (const source of ['global', 'project'] as const) {
      const cfg = this.loaded.get(source)
      if (!cfg) continue
      const groups = cfg.groups.get(event) ?? []
      for (const group of groups) {
        if (!matchHook(group.matcher, target)) continue
        for (const entry of group.hooks) {
          const out = await this.invokeCommand(entry, input)
          if (out) outputs.push(out)
          if (out?.hookSpecificOutput?.permissionDecision === 'deny') return outputs
        }
      }
    }

    return outputs
  }

  private async invokeCommand(entry: HookEntry, input: HookInput): Promise<HookOutput | undefined> {
    const cwd = input.cwd
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env.SHUVIX_PROJECT_DIR = cwd
    env.CLAUDE_PROJECT_DIR = cwd
    env.SHUVIX_SESSION_ID = input.session_id
    env.SHUVIX_EVENT_NAME = input.hook_event_name

    const result = await runHookProcess(entry, input, { cwd, env })

    if (result.exitCode === 0) {
      return result.output
    }
    if (result.exitCode === 2) {
      const reason = result.stderr.trim() || 'hook exited with code 2'
      return {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          reason
        }
      }
    }
    // 其他退出码（含 null = 被 kill / spawn 失败）→ 非阻塞警告
    if (result.timedOut) {
      log.warn(`hook 超时未阻断: ${entry.command}`)
    } else if (result.exitCode != null) {
      log.warn(
        `hook 非阻塞错误 exit=${result.exitCode}: ${entry.command} stderr=${result.stderr.trim()}`
      )
    }
    return undefined
  }

  private restartWatcher(): void {
    void this.watcher?.close()
    const files = [{ source: 'global' as HookSource, path: globalHookFile() }]
    if (this.currentProjectDir) {
      files.push({ source: 'project' as HookSource, path: projectHookFile(this.currentProjectDir) })
    }
    this.watcher = watchHookFiles(files, (loaded) => {
      this.loaded = loaded
      const s = this.status()
      log.info(
        `hooks reload: global=${this.fmtStatus(s.global)}, project=${this.fmtStatus(s.project)}`
      )
    })
    this.loaded = this.watcher.getLoaded()
  }

  private fmtStatus(s: HookFileStatus): string {
    return s.ok ? `${s.count} ok` : `${s.kind}-err: ${s.message}`
  }
}

/** HookService 单例 */
export const hookService = new HookService()

// 仅类型导出（便于消费方 import 不引入运行时副作用）
export type {
  HookEvent,
  HookInput,
  HookOutput,
  HookFileStatus,
  HookSource,
  ResolvedHook,
  HookHandler,
  BuiltinHookEntry,
  HookEntry,
  HookGroup,
  HookConfigFile
} from './types'
