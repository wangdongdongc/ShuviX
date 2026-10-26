import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getUserConfigDir } from '../utils/paths'

/**
 * 本地密文 —— AES-256-GCM，**每个密文自己写明版本**，几种版本一直都能解：
 *   - `$SHUVIX_ENC$v1$`：密钥是每次安装随机生成的 `~/.shuvix/.session-state`（权限 0600），只靠文件权限保护；
 *   - `$SHUVIX_ENC$v2$`：密钥由系统钥匙环保护（Electron safeStorage，见 keyProtector.ts）—— 落盘的
 *     `~/.shuvix/.session-state-v2` 是钥匙环加密过的密钥，拷到别的机器上解不开。
 * 历史数据不重新加密；新写入的密文在 v2 可用时用 v2，否则用 v1（设计见 docs/auto-redaction-design.md §6）。
 * v2 是否可用由宿主装上的 MasterKeyProtector 说了算；`SHUVIX_ENCRYPTION=v1` 强制只用 v1（e2e）。
 */

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32
const AUTH_TAG_LENGTH = 16
const PREFIX_V1 = '$SHUVIX_ENC$v1$'
const PREFIX_V2 = '$SHUVIX_ENC$v2$'

/** 用系统钥匙环保护主密钥（宿主在 app ready 之后装上；没装 = 只有 v1） */
export interface MasterKeyProtector {
  /** 系统有真正的钥匙环后端（Linux 退回固定口令的 basic_text 时不算） */
  available(): boolean
  protect(key: Buffer): Buffer
  unprotect(blob: Buffer): Buffer
}

let cachedKey: Buffer | null = null
let protector: MasterKeyProtector | null = null
/** v2 主密钥：undefined = 还没取过；null = 取不到（不可用或解不开，本进程不再重试 —— 免得反复弹钥匙串授权框） */
let v2Key: Buffer | null | undefined

function getKeyPath(): string {
  return join(getUserConfigDir(), '.session-state')
}

function getV2KeyPath(): string {
  return join(getUserConfigDir(), '.session-state-v2')
}

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey

  const keyPath = getKeyPath()
  if (existsSync(keyPath)) {
    cachedKey = readFileSync(keyPath)
    if (cachedKey!.length !== KEY_LENGTH) {
      throw new Error('Invalid encryption key file')
    }
    return cachedKey!
  }

  const key = randomBytes(KEY_LENGTH)
  writeFileSync(keyPath, key, { mode: 0o600 })
  cachedKey = key
  return key
}

/** 装上（或卸下）钥匙环保护；换了就重新取 v2 主密钥 */
export function installMasterKeyProtector(next: MasterKeyProtector | null): void {
  protector = next
  v2Key = undefined
}

/**
 * v2 主密钥：有就解开它；没有且 create 时生成一把、交钥匙环加密后落盘。
 * 强制 v1、没装保护、钥匙环不可用、解不开 → null。
 */
function getV2Key(create: boolean): Buffer | null {
  if (process.env.SHUVIX_ENCRYPTION === 'v1' || !protector) return null
  if (v2Key !== undefined) return v2Key
  try {
    if (!protector.available()) return (v2Key = null)
    const keyPath = getV2KeyPath()
    if (existsSync(keyPath)) {
      const key = protector.unprotect(readFileSync(keyPath))
      return (v2Key = key.length === KEY_LENGTH ? key : null)
    }
    if (!create) return null
    const key = randomBytes(KEY_LENGTH)
    writeFileSync(keyPath, protector.protect(key), { mode: 0o600 })
    return (v2Key = key)
  } catch {
    return (v2Key = null)
  }
}

/** 新写入的密文用哪个版本 —— 设置页可以据此说明本机的密钥保护方式 */
export function currentEncryptionVersion(): 'v1' | 'v2' {
  return getV2Key(true) ? 'v2' : 'v1'
}

function seal(plaintext: string, key: Buffer, prefix: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${prefix}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

function open(payload: string, key: Buffer): string {
  const [ivHex, authTagHex, dataHex] = payload.split(':')

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(dataHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext
  if (isEncrypted(plaintext)) return plaintext

  const v2 = getV2Key(true)
  return v2 ? seal(plaintext, v2, PREFIX_V2) : seal(plaintext, getOrCreateKey(), PREFIX_V1)
}

/** 解密；不是密文原样返回。解不开（密钥换过、钥匙环拒绝、换了机器）抛错 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext
  if (ciphertext.startsWith(PREFIX_V1)) {
    return open(ciphertext.slice(PREFIX_V1.length), getOrCreateKey())
  }
  if (ciphertext.startsWith(PREFIX_V2)) {
    const key = getV2Key(false)
    if (!key)
      throw new Error(
        'This value was encrypted with the system keychain key, which is not available'
      )
    return open(ciphertext.slice(PREFIX_V2.length), key)
  }
  return ciphertext
}

/**
 * 给界面看的解密：解不开读成空串（同 findAllForModels）。钥匙环拒绝或换了机器时，设置页照样能打开，
 * 只是那几个值显示为空 —— 用户重新填写即可；各 DAO 的写入都是按字段更新，空着不会覆盖原密文。
 */
export function decryptOrEmpty(ciphertext: string): string {
  try {
    return decrypt(ciphertext)
  } catch {
    return ''
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2)
}
