/**
 * 自动脱敏在桌面端的钥匙（services/redaction/keys.ts）：
 *   RK-1 占位符确定：同一个值同一个占位符；HMAC 密钥加密后落盘（盘上不是明文密钥）
 *   RK-2 对照表的值：加密存、原样取；一段本地密文本身也能当值存取，不会被误解开
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('../../../utils/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  dir.path = mkdtempSync(joinPath(tmpdir(), 'shuvix-redaction-keys-'))
  return { getUserConfigDir: () => dir.path }
})

import { makePlaceholder } from '@shuvix/agent-runtime'
import { encrypt } from '../../../utils/crypto'
import { placeholderSigner, redactionVault } from '../keys'

describe('自动脱敏的钥匙', () => {
  it('RK-1 同一个值同一个占位符；HMAC 密钥加密落盘', () => {
    const a = makePlaceholder(placeholderSigner, 'API_KEY', 'sk-abc')
    expect(makePlaceholder(placeholderSigner, 'API_KEY', 'sk-abc')).toBe(a)
    expect(a).toMatch(/^\{\{API_KEY_[a-z2-7]{8}\}\}$/)
    const onDisk = readFileSync(join(dir.path, '.redaction-key'), 'utf8')
    expect(onDisk.startsWith('$SHUVIX_ENC$')).toBe(true)
  })

  it('RK-2 对照表的值加密存、原样取；本地密文本身也能当值', () => {
    const sealed = redactionVault.seal('Tr0ub4dor&3xq')
    expect(sealed).not.toContain('Tr0ub4dor')
    expect(redactionVault.open(sealed)).toBe('Tr0ub4dor&3xq')
    const ciphertext = encrypt('inner')
    expect(redactionVault.open(redactionVault.seal(ciphertext))).toBe(ciphertext)
    expect(() => redactionVault.open(encrypt('no tag'))).toThrow()
  })
})
