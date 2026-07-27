/**
 * hooks.json 加载、校验、文件监听
 *
 * 解析失败时保留上一次成功的 groups，避免坏配置导致全部 hook 失效；
 * status 字段反映当前真实的错误，供 UI 显示。
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { createLogger } from '../../logger'
import { getUserConfigDir } from '../../utils/paths'
import type {
  HookConfigFile,
  HookEntry,
  HookEvent,
  HookFileStatus,
  HookGroup,
  HookSource
} from './types'

const log = createLogger('HookConfig')

const VALID_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop'
])

export interface LoadedConfig {
  /** 按事件归类的 hook group。校验失败的条目已被剔除。 */
  groups: Map<HookEvent, HookGroup[]>
  /** 当前文件的状态 —— UI 用 */
  status: HookFileStatus
}

/** 全局 hooks.json 绝对路径：~/.shuvix/hooks.json */
export function globalHookFile(): string {
  return join(getUserConfigDir(), 'hooks.json')
}

/** 项目级 hooks.json 绝对路径：<projectDir>/.shuvix/hooks.json */
export function projectHookFile(projectDir: string): string {
  return join(projectDir, '.shuvix', 'hooks.json')
}

/**
 * 解析 + 校验单份 hooks.json。
 *
 * - 文件不存在 → status.ok = true, count = 0（不算错误）
 * - JSON.parse 失败 → status.ok = false, kind = 'parse'，groups 为空
 * - 个别条目 schema 不合法 → 在 status.errors 里列出，合法条目仍加载
 */
export function loadConfigFile(absolutePath: string): LoadedConfig {
  if (!existsSync(absolutePath)) {
    return { groups: new Map(), status: { ok: true, count: 0 } }
  }
  let raw: string
  try {
    raw = readFileSync(absolutePath, 'utf-8')
  } catch (err) {
    return {
      groups: new Map(),
      status: {
        ok: false,
        kind: 'parse',
        message: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      groups: new Map(),
      status: {
        ok: false,
        kind: 'parse',
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }
  return validateConfig(parsed)
}

function validateConfig(parsed: unknown): LoadedConfig {
  const errors: string[] = []
  const groups = new Map<HookEvent, HookGroup[]>()

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      groups,
      status: {
        ok: false,
        kind: 'schema',
        message: '顶层必须是对象',
        errors: ['root: 必须是对象']
      }
    }
  }
  const file = parsed as HookConfigFile
  if (file.hooks == null) {
    return { groups, status: { ok: true, count: 0 } }
  }
  if (typeof file.hooks !== 'object' || Array.isArray(file.hooks)) {
    return {
      groups,
      status: {
        ok: false,
        kind: 'schema',
        message: '`hooks` 字段必须是对象',
        errors: ['hooks: 必须是对象']
      }
    }
  }

  let total = 0
  for (const [eventName, eventGroupsRaw] of Object.entries(file.hooks)) {
    if (!VALID_EVENTS.has(eventName as HookEvent)) {
      errors.push(`未知事件名 "${eventName}"，已跳过`)
      continue
    }
    if (!Array.isArray(eventGroupsRaw)) {
      errors.push(`hooks.${eventName}: 必须是数组，已跳过`)
      continue
    }
    const event = eventName as HookEvent
    const groupList: HookGroup[] = []

    eventGroupsRaw.forEach((groupRaw, gi) => {
      if (!groupRaw || typeof groupRaw !== 'object') {
        errors.push(`hooks.${event}[${gi}]: 必须是对象，已跳过`)
        return
      }
      const group = groupRaw as HookGroup
      if (group.matcher != null && typeof group.matcher !== 'string') {
        errors.push(`hooks.${event}[${gi}].matcher: 必须是字符串，已跳过该 group`)
        return
      }
      if (!Array.isArray(group.hooks)) {
        errors.push(`hooks.${event}[${gi}].hooks: 必须是数组，已跳过该 group`)
        return
      }
      const validEntries: HookEntry[] = []
      group.hooks.forEach((entryRaw, hi) => {
        if (!entryRaw || typeof entryRaw !== 'object') {
          errors.push(`hooks.${event}[${gi}].hooks[${hi}]: 必须是对象`)
          return
        }
        const entry = entryRaw as HookEntry
        if (entry.type !== 'command') {
          errors.push(`hooks.${event}[${gi}].hooks[${hi}].type: 仅支持 'command'`)
          return
        }
        if (typeof entry.command !== 'string' || !entry.command.trim()) {
          errors.push(`hooks.${event}[${gi}].hooks[${hi}].command: 必须是非空字符串`)
          return
        }
        if (entry.timeout != null && (typeof entry.timeout !== 'number' || entry.timeout <= 0)) {
          errors.push(`hooks.${event}[${gi}].hooks[${hi}].timeout: 必须是正数`)
          return
        }
        validEntries.push(entry)
      })
      if (validEntries.length > 0) {
        groupList.push({ matcher: group.matcher, hooks: validEntries })
        total += validEntries.length
      }
    })

    if (groupList.length > 0) {
      groups.set(event, groupList)
    }
  }

  if (errors.length > 0) {
    return {
      groups,
      status: {
        ok: false,
        kind: 'schema',
        message: `${errors.length} 个 schema 错误`,
        errors
      }
    }
  }
  return { groups, status: { ok: true, count: total } }
}

export interface HookFileSpec {
  source: HookSource
  path: string
}

export interface ConfigWatcher {
  /** 当前各 source 的加载状态。坏配置时 groups 来自上一次成功值，status 反映当前错误。 */
  getLoaded(): Map<HookSource, LoadedConfig>
  /** 手动 reload —— UI 兜底用 */
  reload(): void
  /** watcher 初扫完成；初扫窗口内创建的文件会被 ignoreInitial 吞掉，事件仅在此之后保证可见 */
  ready: Promise<void>
  close(): Promise<void>
}

/**
 * 启动文件监听。每次变动 debounce 后 reload，并调用 onChange。
 * 注意：chokidar.watch 对不存在的文件也会 watch 其后续创建，所以 sources 可以含未来才出现的路径。
 */
export function watchHookFiles(
  files: HookFileSpec[],
  onChange: (loaded: Map<HookSource, LoadedConfig>) => void,
  debounceMs = 200
): ConfigWatcher {
  const loaded = new Map<HookSource, LoadedConfig>()
  const lastGood = new Map<HookSource, LoadedConfig>()

  const doLoad = (): void => {
    for (const { source, path } of files) {
      const next = loadConfigFile(path)
      if (next.status.ok) {
        lastGood.set(source, next)
        loaded.set(source, next)
      } else {
        const prev = lastGood.get(source)
        loaded.set(source, {
          groups: prev?.groups ?? new Map(),
          status: next.status
        })
      }
    }
  }

  // 初次同步加载
  doLoad()

  let timer: NodeJS.Timeout | null = null
  const debouncedReload = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      doLoad()
      onChange(loaded)
    }, debounceMs)
  }

  const watcher: FSWatcher = chokidar.watch(
    files.map((f) => f.path),
    {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    }
  )
  watcher.on('add', debouncedReload)
  watcher.on('change', debouncedReload)
  watcher.on('unlink', debouncedReload)
  watcher.on('error', (e) =>
    log.warn(`watcher error: ${e instanceof Error ? e.message : String(e)}`)
  )
  const ready = new Promise<void>((resolve) => watcher.once('ready', resolve))

  return {
    ready,
    getLoaded: () => loaded,
    reload: () => {
      if (timer) clearTimeout(timer)
      timer = null
      doLoad()
      onChange(loaded)
    },
    close: async () => {
      if (timer) clearTimeout(timer)
      await watcher.close()
    }
  }
}
