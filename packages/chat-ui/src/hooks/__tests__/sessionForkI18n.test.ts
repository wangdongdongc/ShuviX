/**
 * 会话 fork 的文案守卫（CP-2）：`forkRefusalKey` 给每一种拒绝原因交回的 key、说明框标题与关闭按钮、
 * 侧栏菜单项、回复上的按钮、fork 标题模板，在 en / zh / ja 三份语言包里都是非空字符串 —— 缺一个界面上
 * 就会直接露出 key。fork 标题模板必须带 `{{title}}`（宿主拿它拼「<标题> · fork」）。
 */
import { describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { SessionForkRefusal } from '@shuvix/chat-protocol/sessionFork'
import { forkRefusalKey } from '../useSessionFork'

const LOCALES: Record<string, unknown> = { en, zh, ja }

const REASONS: SessionForkRefusal[] = [
  'no_session',
  'not_forkable',
  'busy',
  'invalid_target',
  'failed'
]

function lookup(locale: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale
    )
}

describe('session fork i18n (CP-2)', () => {
  it('CP-2 forkRefusalKey maps the five reasons to five distinct keys', () => {
    const keys = REASONS.map(forkRefusalKey)
    expect(new Set(keys).size).toBe(REASONS.length)
    for (const key of keys) expect(typeof key).toBe('string')
  })

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`CP-2 ${name}: every refusal key and fork string exists and is non-empty`, () => {
      const keys = [
        ...REASONS.map(forkRefusalKey),
        'chat.forkFailedTitle',
        'common.close',
        'sidebar.forkSession',
        'message.fork',
        'agent.forkTitle'
      ]
      for (const key of keys) {
        const value = lookup(locale, key)
        expect(typeof value, `${name} ${key}`).toBe('string')
        expect((value as string).trim().length, `${name} ${key}`).toBeGreaterThan(0)
      }
      expect(lookup(locale, 'agent.forkTitle')).toContain('{{title}}')
    })
  }
})
