import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32
const AUTH_TAG_LENGTH = 16
const PREFIX = '$SHUVIX_ENC$v1$'

let cachedKey: Buffer | null = null

function getKeyPath(): string {
  const dbDir = join(app.getPath('userData'), 'data')
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }
  return join(dbDir, '.session-state')
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

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext
  if (plaintext.startsWith(PREFIX)) return plaintext

  const key = getOrCreateKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext
  if (!ciphertext.startsWith(PREFIX)) return ciphertext

  const payload = ciphertext.slice(PREFIX.length)
  const [ivHex, authTagHex, dataHex] = payload.split(':')

  const key = getOrCreateKey()
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(dataHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}
