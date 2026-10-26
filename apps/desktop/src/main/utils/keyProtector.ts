import { safeStorage } from 'electron'
import type { MasterKeyProtector } from './crypto'

/**
 * 用 Electron safeStorage 保护 v2 主密钥（见 crypto.ts）。各平台的实际保护程度不同
 * （docs/auto-redaction-design.md §6）：macOS 钥匙串按应用签名控制访问；Windows DPAPI、Linux 桌面的钥匙环
 * 防不住同一用户的进程；Linux 没有钥匙环时 safeStorage 退回固定口令的 basic_text —— 那比 v1 的随机密钥
 * 文件还弱，所以不算可用，继续用 v1。必须在 app ready 之后使用。
 */
export const safeStorageProtector: MasterKeyProtector = {
  available() {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform !== 'linux') return true
    const backend = safeStorage.getSelectedStorageBackend()
    return backend !== 'basic_text' && backend !== 'unknown'
  },
  protect: (key) => safeStorage.encryptString(key.toString('base64')),
  unprotect: (blob) => Buffer.from(safeStorage.decryptString(blob), 'base64')
}
