import { ipcMain } from 'electron'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import { dbManager } from '../services/builtinMcp/dbConnections'
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

  /** 凭据 id → 现在的名字（打开着的连接按名字记账） */
  const nameOf = (id: string): string | undefined =>
    dbCredentialDao.findAllSafe().find((c) => c.id === id)?.name

  /**
   * 更新数据库凭据。打开着的连接是按旧配置建的（旧主机、旧账号、旧的只读位）—— 全部断开，
   * 下次用到时按新配置重连。尤其是「改成只读」：不断开的话，安全门按只读放行，语句却跑在旧的可写连接上
   */
  ipcMain.handle('dbCredential:update', async (_event, params: DbCredentialUpdateParams) => {
    const { id, ...fields } = params
    // 编辑对话框的约定是「密码留空 = 保持不变」，而它把空串原样送了过来 —— 不拦的话，保存一次
    // 就把已存的密码抹成空（新建时密码必填，所以空串在这里只可能是「没改」）
    if (fields.password === '') delete fields.password
    const before = nameOf(id)
    dbCredentialDao.update(id, fields)
    if (before) await dbManager.disconnectCredential(before)
    return { success: true }
  })

  /** 删除数据库凭据（连同各会话里用它打开着的连接） */
  ipcMain.handle('dbCredential:delete', async (_event, id: string) => {
    const before = nameOf(id)
    dbCredentialDao.deleteById(id)
    if (before) await dbManager.disconnectCredential(before)
    return { success: true }
  })

  /** 测试连接（不保存） */
  ipcMain.handle('dbCredential:testConnection', (_event, params: DbCredentialTestParams) => {
    return dbManager.testConnection(params)
  })
}
