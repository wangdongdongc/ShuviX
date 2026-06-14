/**
 * Hook 相关 IPC 处理器 —— 给设置页 UI 用
 *
 * 注意：MVP 不暴露"创建/编辑 hook"接口，用户直接编辑 hooks.json 文件，
 * 由 watcher 自动 reload。这里只给"列表 / 状态 / 打开配置文件 / 手动 reload"。
 */

import { ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { hookService } from '../services/hooks'
import { globalHookFile, projectHookFile } from '../services/hooks/hookConfig'
import { createLogger } from '../logger'

const log = createLogger('HookHandlers')

/** 文件不存在时写一份占位内容，方便用户直接编辑 */
const PLACEHOLDER_CONTENT = `{
  "hooks": {}
}
`

function ensureFileExists(absolutePath: string): void {
  if (existsSync(absolutePath)) return
  try {
    mkdirSync(join(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, PLACEHOLDER_CONTENT, 'utf-8')
    log.info(`已创建空 hooks 配置: ${absolutePath}`)
  } catch (err) {
    log.warn(`创建 hooks 配置失败 ${absolutePath}: ${err instanceof Error ? err.message : err}`)
  }
}

export function registerHookHandlers(): void {
  /** 列出所有 user 来源的 hook（默认隐藏 builtin） */
  ipcMain.handle('hook:list', (_event, opts?: { includeBuiltin?: boolean }) => {
    return hookService.list({ includeBuiltin: opts?.includeBuiltin ?? false })
  })

  /** 当前 global / project 配置文件的健康状态 */
  ipcMain.handle('hook:status', () => {
    return hookService.status()
  })

  /** 手动 reload（watcher 已自动 reload，此接口给 UI "Reload" 按钮兜底） */
  ipcMain.handle('hook:reload', () => {
    hookService.reload()
    return { success: true }
  })

  /**
   * 打开 hooks.json。若文件不存在则先创建空占位再打开 —— 用户期望"点了就能编辑"。
   * scope = 'global' → ~/.shuvix/hooks.json
   * scope = 'project' → <projectDir>/.shuvix/hooks.json（需要传入 projectDir）
   */
  ipcMain.handle(
    'hook:openConfigFile',
    async (_event, scope: 'global' | 'project', projectDir?: string) => {
      let path: string
      if (scope === 'global') {
        path = globalHookFile()
      } else {
        if (!projectDir) return { success: false, reason: 'projectDir required for project scope' }
        path = projectHookFile(projectDir)
      }
      ensureFileExists(path)
      const err = await shell.openPath(path)
      if (err) {
        log.warn(`openPath 失败 ${path}: ${err}`)
        return { success: false, reason: err }
      }
      return { success: true, path }
    }
  )
}
