import { ipcMain, dialog } from 'electron'
import { skillService } from '../services/skillService'
import type { SkillUpdateParams, SkillDir } from '../types'

/**
 * Skill 相关 IPC 处理器（基于文件系统 ~/.shuvix/skills/）
 */
export function registerSkillHandlers(): void {
  /** 获取所有 Skill */
  ipcMain.handle('skill:list', () => {
    return skillService.findAll()
  })

  /** 获取按目录分组的 Skill 列表 */
  ipcMain.handle('skill:listGrouped', () => {
    return skillService.findAllGrouped()
  })

  /** 更新 Skill */
  ipcMain.handle('skill:update', (_event, params: SkillUpdateParams) => {
    skillService.update(params)
    return { success: true }
  })

  /** 删除默认目录中的 Skill（移除整个子目录） */
  ipcMain.handle('skill:deleteDefault', (_event, name: string) => {
    skillService.deleteDefaultSkill(name)
    return { success: true }
  })

  /** 解析 SKILL.md 文本 → { name, description, content } */
  ipcMain.handle('skill:parseMarkdown', (_event, text: string) => {
    return skillService.parseSkillMarkdown(text)
  })

  /** 获取默认 skills 目录路径 */
  ipcMain.handle('skill:getDefaultDir', () => {
    return skillService.getDefaultSkillsDir()
  })

  // ============ 目录管理 ============

  /** 获取外部 skill 源目录列表 */
  ipcMain.handle('skill:listExternalDirs', () => {
    return skillService.listExternalDirs()
  })

  /** 弹出文件夹选择器（仅返回路径，不执行添加） */
  ipcMain.handle('skill:pickExternalDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'showHiddenFiles'],
      title: 'Select Skill Source Directory'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, reason: 'canceled' }
    }
    return { success: true, path: result.filePaths[0] }
  })

  /** 添加外部 skill 源目录 */
  ipcMain.handle('skill:addExternalDir', (_event, dir: SkillDir) => {
    try {
      skillService.addExternalDir(dir)
      return { success: true }
    } catch (e: unknown) {
      return { success: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 移除外部 skill 源目录 */
  ipcMain.handle('skill:removeExternalDir', (_event, name: string) => {
    skillService.removeExternalDir(name)
    return { success: true }
  })

  /** 切换分组总开关（关闭后整组 skills 失效） */
  ipcMain.handle(
    'skill:setGroupEnabled',
    (_event, params: { dirName: string; isEnabled: boolean }) => {
      skillService.setGroupEnabled(params.dirName, params.isEnabled)
      return { success: true }
    }
  )
}
