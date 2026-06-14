import { ipcMain } from 'electron'
import { sshCredentialDao } from '../dao/sshCredentialDao'
import type { SshCredentialAddParams, SshCredentialUpdateParams } from '../types'

/**
 * SSH 凭据管理 IPC 处理器
 */
export function registerSshCredentialHandlers(): void {
  /** 获取所有 SSH 凭据（解密后返回给 UI） */
  ipcMain.handle('sshCredential:list', () => {
    return sshCredentialDao.findAll()
  })

  /** 添加 SSH 凭据 */
  ipcMain.handle('sshCredential:add', (_event, params: SshCredentialAddParams) => {
    const id = sshCredentialDao.insert(params)
    return { id }
  })

  /** 更新 SSH 凭据 */
  ipcMain.handle('sshCredential:update', (_event, params: SshCredentialUpdateParams) => {
    const { id, ...fields } = params
    sshCredentialDao.update(id, fields)
    return { success: true }
  })

  /** 删除 SSH 凭据 */
  ipcMain.handle('sshCredential:delete', (_event, id: string) => {
    sshCredentialDao.deleteById(id)
    return { success: true }
  })

  /** 仅获取凭据名称列表（轻量，供工具描述用） */
  ipcMain.handle('sshCredential:listNames', () => {
    return sshCredentialDao.findAllNames()
  })
}
