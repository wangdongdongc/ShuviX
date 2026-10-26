/**
 * 会话的占位符对照表（durable/redactionTable.ts，docs/auto-redaction-design.md §5）：真宿主（MemoryStorage 会话）上读写。
 *
 *   RT-1 记进去的项：文档里存的是加密后的值，内存视图里是真值；已知值按原文认得出；同一个占位符只记一次
 *   RT-2 重新读出（模拟重开）：解得开的回到视图；解不开的标成不可用（占位符认得，真值查不到）
 *   RT-3 并发的两次记录各自落下，不互相覆盖
 *   RT-4 没有这份文档（从没记过）：读出空表，文档不补种；文档定义（kind / scope）
 */
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { RedactionTableDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import {
  loadRedactionTable,
  recordRedactions,
  type RedactionEntry,
  type RedactionVault
} from '../redactionTable'
import { makeHost, registerHostCleanup } from './support/host'

registerHostCleanup()

/** 「加密」= 反转再加个头；open 认不出头就抛错（模拟主密钥不在） */
const vault: RedactionVault = {
  seal: (v) => `SEALED:${[...v].reverse().join('')}`,
  open: (s) => {
    if (!s.startsWith('SEALED:')) throw new Error('cannot open')
    return [...s.slice(7)].reverse().join('')
  }
}

const entry = (placeholder: string, value: string, category = 'SECRET'): RedactionEntry => ({
  placeholder,
  category,
  rule: 'secret-field',
  value
})

async function openSession(sid: string): Promise<DurableSession> {
  const t = await makeHost({ ephemeral: [sid] })
  return t.open(sid)
}

describe('会话的占位符对照表', () => {
  it('RT-1 文档里存加密值、视图里是真值；已知值认得出；同一个占位符只记一次', async () => {
    const session = await openSession('rt1')
    const table = await loadRedactionTable(session.harness, vault)
    expect(table.size).toBe(0)
    const n = await recordRedactions(
      session.harness,
      table,
      [
        entry('{{SECRET_aaaaaaaa}}', 'Tr0ub4dor&3xq'),
        entry('{{SECRET_aaaaaaaa}}', 'Tr0ub4dor&3xq')
      ],
      vault
    )
    expect(n).toBe(1)
    expect(table.valueOf('{{SECRET_aaaaaaaa}}')).toBe('Tr0ub4dor&3xq')
    expect(table.known.spans('use Tr0ub4dor&3xq').map((s) => s.placeholder)).toEqual([
      '{{SECRET_aaaaaaaa}}'
    ])
    const doc = await session.harness.snapshot(RedactionTableDoc, BG)
    expect(doc?.items['{{SECRET_aaaaaaaa}}']).toEqual({
      category: 'SECRET',
      rule: 'secret-field',
      value: vault.seal('Tr0ub4dor&3xq')
    })
    expect(doc?.items['{{SECRET_aaaaaaaa}}'].value).not.toContain('Tr0ub4dor')
    expect(
      await recordRedactions(session.harness, table, [entry('{{SECRET_aaaaaaaa}}', 'x')], vault)
    ).toBe(0)
  })

  it('RT-2 重新读出：解得开的回到视图，解不开的标成不可用', async () => {
    const session = await openSession('rt2')
    const table = await loadRedactionTable(session.harness, vault)
    await recordRedactions(
      session.harness,
      table,
      [entry('{{EMAIL_bbbbbbbb}}', 'li.na@qq.com', 'EMAIL')],
      vault
    )
    // 再写一项外人写的、解不开的
    await session.harness.commit(async (tx) => {
      const doc = await tx.doc(RedactionTableDoc)
      doc.items['{{API_KEY_cccccccc}}'] = { category: 'API_KEY', rule: 'sk-key', value: 'garbage' }
    }, BG)
    const again = await loadRedactionTable(session.harness, vault)
    expect(again.valueOf('{{EMAIL_bbbbbbbb}}')).toBe('li.na@qq.com')
    expect(again.has('{{API_KEY_cccccccc}}')).toBe(true)
    expect(again.valueOf('{{API_KEY_cccccccc}}')).toBeUndefined()
    expect(again.known.size).toBe(1)
  })

  it('RT-3 并发的两次记录都落下', async () => {
    const session = await openSession('rt3')
    const a = await loadRedactionTable(session.harness, vault)
    const b = await loadRedactionTable(session.harness, vault)
    await Promise.all([
      recordRedactions(session.harness, a, [entry('{{SECRET_dddddddd}}', 'first-value-1')], vault),
      recordRedactions(session.harness, b, [entry('{{SECRET_eeeeeeee}}', 'second-value-2')], vault)
    ])
    const doc = await session.harness.snapshot(RedactionTableDoc, BG)
    expect(Object.keys(doc?.items ?? {}).sort()).toEqual([
      '{{SECRET_dddddddd}}',
      '{{SECRET_eeeeeeee}}'
    ])
  })

  it('RT-4 从没记过：空表、文档不补种；文档是整条会话一份', async () => {
    const session = await openSession('rt4')
    expect((await loadRedactionTable(session.harness, vault)).size).toBe(0)
    expect(await session.harness.snapshot(RedactionTableDoc, BG)).toBeUndefined()
    const { kind, scope } = RedactionTableDoc.definition as unknown as Record<string, unknown>
    expect(kind).toBe('shuvix.redaction-table')
    expect(scope).toBe('session')
  })
})
