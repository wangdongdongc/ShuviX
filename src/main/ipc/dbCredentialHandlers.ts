import { ipcMain } from 'electron'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import { dbManager } from '../services/dbManager'
import type {
  DbCredentialAddParams,
  DbCredentialUpdateParams,
  DbCredentialTestParams
} from '../types'

/**
 * 数据库凭据管理 IPC 处理器
 */
export function registerDbCredentialHandlers(): void {
  /** 获取所有数据库凭据（不含 password，供 UI 展示） */
  ipcMain.handle('dbCredential:list', () => {
    return dbCredentialDao.findAllSafe()
  })

  /** 添加数据库凭据 */
  ipcMain.handle('dbCredential:add', (_event, params: DbCredentialAddParams) => {
    const id = dbCredentialDao.insert(params)
    return { id }
  })

  /** 更新数据库凭据 */
  ipcMain.handle('dbCredential:update', (_event, params: DbCredentialUpdateParams) => {
    const { id, ...fields } = params
    dbCredentialDao.update(id, fields)
    return { success: true }
  })

  /** 删除数据库凭据 */
  ipcMain.handle('dbCredential:delete', (_event, id: string) => {
    dbCredentialDao.deleteById(id)
    return { success: true }
  })

  /** 测试连接（不保存） */
  ipcMain.handle('dbCredential:testConnection', (_event, params: DbCredentialTestParams) => {
    return dbManager.testConnection(params)
  })
}
