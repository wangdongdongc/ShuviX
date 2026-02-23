import { ipcMain, dialog } from 'electron'
import { skillService } from '../services/skillService'
import type { SkillAddParams, SkillUpdateParams } from '../types'

/**
 * Skill 相关 IPC 处理器（基于文件系统 ~/.shuvix/skills/）
 */
export function registerSkillHandlers(): void {
  /** 获取所有 Skill */
  ipcMain.handle('skill:list', () => {
    return skillService.findAll()
  })

  /** 手动创建 Skill */
  ipcMain.handle('skill:add', (_event, params: SkillAddParams) => {
    return skillService.create(params)
  })

  /** 更新 Skill */
  ipcMain.handle('skill:update', (_event, params: SkillUpdateParams) => {
    skillService.update(params)
    return { success: true }
  })

  /** 删除 Skill（移除整个目录） */
  ipcMain.handle('skill:delete', (_event, name: string) => {
    skillService.deleteByName(name)
    return { success: true }
  })

  /** 解析 SKILL.md 文本 → { name, description, content } */
  ipcMain.handle('skill:parseMarkdown', (_event, text: string) => {
    return skillService.parseSkillMarkdown(text)
  })

  /** 从本地目录导入 Skill（弹出文件夹选择器） */
  ipcMain.handle('skill:importFromDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Skill Directory'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, reason: 'canceled' }
    }
    try {
      const skill = skillService.importFromDirectory(result.filePaths[0])
      return { success: true, skill }
    } catch (e: any) {
      return { success: false, reason: e.message }
    }
  })

  /** 获取 skills 目录路径 */
  ipcMain.handle('skill:getDir', () => {
    return skillService.getSkillsDir()
  })
}
