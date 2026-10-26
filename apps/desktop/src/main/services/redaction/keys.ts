import { createHmac, randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PlaceholderSigner, RedactionVault } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { decrypt, encrypt } from '../../utils/crypto'
import { getUserConfigDir } from '../../utils/paths'

/**
 * 自动脱敏在桌面端的两把钥匙（docs/auto-redaction-design.md §4.3 / §5 / §6）：
 *   - 占位符的 HMAC 密钥：全局一把、不轮换 —— 同一个值在任何会话里都得到同一个占位符。加密后存在
 *     `~/.shuvix/.redaction-key`（本地密文，v1 / v2 见 utils/crypto.ts）。解不开时（钥匙环拒绝、换了机器）
 *     本进程用一把临时密钥：占位符和以前的对不上，但每个会话的对照表自己记着占位符与真值，照样还原；
 *     绝不重新生成并覆盖那个文件 —— 钥匙环只是暂时拒绝时，下次启动还能解开原来的。
 *   - 对照表里真值的加密：就是本地密文。存进去的值加一个前缀再加密，取出来去掉 —— 检测到的「秘密」恰好是
 *     一段本地密文时（agent 读了数据库），encrypt 会原样放过它，decrypt 又会把它解开，前缀让两边都不会误会。
 */

const log = createLogger('Redaction')

const KEY_LENGTH = 32
const VALUE_TAG = 'v:'

let hmacKey: Buffer | null = null

function keyPath(): string {
  return join(getUserConfigDir(), '.redaction-key')
}

function loadHmacKey(): Buffer {
  if (hmacKey) return hmacKey
  try {
    const path = keyPath()
    if (existsSync(path)) {
      const key = Buffer.from(decrypt(readFileSync(path, 'utf8').trim()), 'base64')
      if (key.length !== KEY_LENGTH) throw new Error('the key has the wrong length')
      return (hmacKey = key)
    }
    const key = randomBytes(KEY_LENGTH)
    writeFileSync(path, encrypt(key.toString('base64')), { mode: 0o600 })
    return (hmacKey = key)
  } catch (err) {
    log.error(
      `cannot read the placeholder key, using a temporary one for this run: ${err instanceof Error ? err.message : String(err)}`
    )
    return (hmacKey = randomBytes(KEY_LENGTH))
  }
}

export const placeholderSigner: PlaceholderSigner = {
  sign: (data) => createHmac('sha256', loadHmacKey()).update(data, 'utf8').digest()
}

export const redactionVault: RedactionVault = {
  seal: (value) => encrypt(VALUE_TAG + value),
  open: (sealed) => {
    const plain = decrypt(sealed)
    if (!plain.startsWith(VALUE_TAG)) throw new Error('not a redaction table value')
    return plain.slice(VALUE_TAG.length)
  }
}
