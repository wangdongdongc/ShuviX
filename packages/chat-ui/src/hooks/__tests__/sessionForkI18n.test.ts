/**
 * 会话 fork 的文案守卫（CP-2）：`forkRefusalKey` 给每一种拒绝原因交回的 key、说明框标题与关闭按钮、
 * 侧栏菜单项、回复上的按钮、fork 标题模板，在 en / zh / ja 三份语言包里都是非空字符串 —— 缺一个界面上
 * 就会直接露出 key。fork 标题模板必须带 `{{title}}`（宿主拿它拼「<标题> · fork」）。
 *
 * CP-3 `not_forkable` 的说明（`chat.forkNotForkable`）不能再说「只有项目会话能分支」—— 临时会话也能 fork 了：
 * en 里没有 project、zh 里没有「项目」、ja 里没有「プロジェクト」；它点名笔记本（形态不给的头一种）。
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

  const NOT_FORKABLE: Record<string, { project: RegExp; notebook: RegExp }> = {
    en: { project: /project/i, notebook: /notebook/i },
    zh: { project: /项目/, notebook: /笔记本/ },
    ja: { project: /プロジェクト/, notebook: /ノートブック/ }
  }

  for (const [name, words] of Object.entries(NOT_FORKABLE)) {
    it(`CP-3 ${name}: the not-forkable copy does not limit forking to project sessions and names notebooks`, () => {
      const key = forkRefusalKey('not_forkable')
      expect(key).toBe('chat.forkNotForkable')
      const value = lookup(LOCALES[name], key)
      expect(typeof value, `${name} ${key}`).toBe('string')
      expect(value as string).not.toMatch(words.project)
      expect(value as string).toMatch(words.notebook)
    })
  }
})
