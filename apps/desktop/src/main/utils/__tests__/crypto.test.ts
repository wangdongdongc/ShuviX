/**
 * 本地密文的版本（docs/auto-redaction-design.md §6）：
 *   - 每个密文自己写明版本，v1 与 v2 一直都能解；历史数据不重新加密；
 *   - 新写入的密文在 v2 可用时用 v2（主密钥交钥匙环保护后落盘，盘上没有明文主密钥）；
 *   - 不可用（没装保护、钥匙环不可用、强制 v1、解不开）就用 v1；
 *   - v2 主密钥解不开时，v2 密文抛错，给界面看的读成空串。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => ({ path: '' }))
// 密钥文件放进只属于本文件的临时目录（绝不碰 ~/.shuvix）
vi.mock('../paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  dir.path = mkdtempSync(joinPath(tmpdir(), 'shuvix-crypto-test-'))
  return { getUserConfigDir: () => dir.path }
})

import {
  currentEncryptionVersion,
  decrypt,
  decryptOrEmpty,
  encrypt,
  installMasterKeyProtector,
  isEncrypted,
  type MasterKeyProtector
} from '../crypto'

/** 假的钥匙环：保护 = 和一个固定字节异或再加个头（能看出盘上不是明文主密钥） */
function fakeProtector(opts: { available?: boolean; deny?: boolean } = {}): MasterKeyProtector {
  const mask = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    available: () => opts.available !== false,
    protect: (key) => Buffer.concat([Buffer.from('KC1'), mask(key)]),
    unprotect: (blob) => {
      if (opts.deny) throw new Error('User canceled the keychain prompt')
      return mask(blob.subarray(3))
    }
  }
}

const v2File = (): string => join(dir.path, '.session-state-v2')

beforeEach(() => {
  installMasterKeyProtector(null)
  delete process.env.SHUVIX_ENCRYPTION
})

afterEach(() => {
  rmSync(v2File(), { force: true })
  delete process.env.SHUVIX_ENCRYPTION
})

describe('本地密文的版本', () => {
  it('CR-1 没装钥匙环保护 → v1，能解；不是密文原样返回', () => {
    const c = encrypt('sk-abc')
    expect(c.startsWith('$SHUVIX_ENC$v1$')).toBe(true)
    expect(decrypt(c)).toBe('sk-abc')
    expect(decrypt('plain')).toBe('plain')
    expect(currentEncryptionVersion()).toBe('v1')
  })

  it('CR-2 钥匙环可用 → 新密文用 v2，盘上存的是保护过的主密钥；之前的 v1 密文照样能解', () => {
    const old = encrypt('old-v1-value')
    installMasterKeyProtector(fakeProtector())
    const fresh = encrypt('sk-new')
    expect(fresh.startsWith('$SHUVIX_ENC$v2$')).toBe(true)
    expect(isEncrypted(fresh)).toBe(true)
    expect(encrypt(fresh)).toBe(fresh)
    expect(decrypt(fresh)).toBe('sk-new')
    expect(decrypt(old)).toBe('old-v1-value')
    expect(readFileSync(v2File()).subarray(0, 3).toString()).toBe('KC1')

    // 重新装上（模拟重启）：从盘上解开同一把主密钥
    installMasterKeyProtector(fakeProtector())
    expect(decrypt(fresh)).toBe('sk-new')
  })

  it('CR-3 强制 v1、或钥匙环不可用（Linux 的 basic_text）→ 用 v1，不生成 v2 主密钥', () => {
    installMasterKeyProtector(fakeProtector())
    process.env.SHUVIX_ENCRYPTION = 'v1'
    expect(encrypt('x-value').startsWith('$SHUVIX_ENC$v1$')).toBe(true)
    delete process.env.SHUVIX_ENCRYPTION

    installMasterKeyProtector(fakeProtector({ available: false }))
    expect(encrypt('y-value').startsWith('$SHUVIX_ENC$v1$')).toBe(true)
    expect(existsSync(v2File())).toBe(false)
  })

  it('CR-4 v2 主密钥解不开（钥匙环拒绝、换了机器）→ 新密文退回 v1；v2 密文抛错、给界面的读成空串', () => {
    installMasterKeyProtector(fakeProtector())
    const v2 = encrypt('sk-under-v2')
    installMasterKeyProtector(fakeProtector({ deny: true }))
    expect(() => decrypt(v2)).toThrow(/system keychain key/)
    expect(decryptOrEmpty(v2)).toBe('')
    expect(encrypt('later').startsWith('$SHUVIX_ENC$v1$')).toBe(true)
  })
})
