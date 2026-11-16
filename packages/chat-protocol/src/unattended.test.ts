/**
 * 无人值守的运行写给模型的三句话与界面认它们的办法（`unattended.ts`，docs/unattended-run-design.md §3 / §6）。
 *
 *   UP-1 三句话都以同一个标记开头，`isUnattendedResult` 都认
 *   UP-2 权限那一句：`what` 原样在第一行，第二行是「换个办法 / 跳过 / 说明要批准什么」
 *   UP-3 `isUnattendedResult` 的宽严：只认字符串、标记在开头一小段（`[MCP Error] ` 这类前缀之后也算），大小写敏感
 *   UP-4 `what` 自己带标记 / 换行：文本不被改写，仍然认得
 *   UP-5 措辞：不说用户拒绝了、不说 Aborted；提问那句说自己决定或留成提议；填值那句说什么都没改
 *   UP-6 三语界面文案齐全（悬停提示是这个特性唯一的新增文字）
 */
import { describe, expect, it } from 'vitest'
import en from './i18n/locales/en.json'
import ja from './i18n/locales/ja.json'
import zh from './i18n/locales/zh.json'
import {
  UNATTENDED_FIELDS_TEXT,
  UNATTENDED_MARK,
  UNATTENDED_QUESTION_TEXT,
  isUnattendedResult,
  unattendedApprovalText
} from './unattended'

describe('UP-1 the three texts share one mark', () => {
  it.each([
    ['approval', unattendedApprovalText('rm -rf x')],
    ['question', UNATTENDED_QUESTION_TEXT],
    ['fields', UNATTENDED_FIELDS_TEXT]
  ])('%s starts with the mark and is recognised', (_name, text) => {
    expect(text.startsWith(UNATTENDED_MARK)).toBe(true)
    expect(isUnattendedResult(text)).toBe(true)
    // 标记只出现一次
    expect(text.split(UNATTENDED_MARK)).toHaveLength(2)
  })

  it('the mark is plain ASCII in square brackets', () => {
    expect(UNATTENDED_MARK).toBe('[Unattended run]')
  })
})

describe('UP-2 the approval text carries what was asked', () => {
  it.each([
    ['a command', 'git push origin main'],
    ['a path', 'Read /Users/me/.ssh/config'],
    ['empty', '']
  ])('%s: verbatim at the end of the first line, then the advice line', (_name, what) => {
    const text = unattendedApprovalText(what)
    const [first, second, ...rest] = text.split('\n')
    expect(first!.endsWith(`: ${what}`)).toBe(true)
    expect(second).toMatch(/needs no approval/i)
    expect(second).toMatch(/skip it/i)
    expect(second).toMatch(/what the user would need to approve/i)
    expect(rest).toEqual([])
  })

  it('a multi-line `what` is kept whole, the advice stays the last line', () => {
    const what = 'cat <<EOF\nline two\nEOF'
    const text = unattendedApprovalText(what)
    expect(text).toContain(what)
    expect(text.split('\n').at(-1)).toMatch(/^Do it a way that needs no approval/)
  })
})

describe('UP-3 isUnattendedResult', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an array holding the mark', [UNATTENDED_MARK]],
    ['an empty string', ''],
    ['lower case', '[unattended run] x'],
    ['without brackets', 'Unattended run: x'],
    ['the mark far into the text', `${'x'.repeat(80)} ${UNATTENDED_MARK}`],
    ['an ordinary result', 'User selected: A']
  ])('%s → false', (_name, value) => {
    expect(isUnattendedResult(value)).toBe(false)
  })

  it.each<[string, string]>([
    ['at the very start', `${UNATTENDED_MARK} x`],
    ['the mark alone', UNATTENDED_MARK],
    ['behind the MCP failure prefix', `[MCP Error] ${unattendedApprovalText('ssh prod uptime')}`],
    ['behind a short lead', ` ${UNATTENDED_MARK} x`]
  ])('%s → true', (_name, value) => {
    expect(isUnattendedResult(value)).toBe(true)
  })

  it('the mark must be whole inside the leading window', () => {
    // 窗口 64 个字符：标记恰好收在窗口里算，被窗口切断不算
    const fits = 'x'.repeat(64 - UNATTENDED_MARK.length) + UNATTENDED_MARK
    expect(isUnattendedResult(fits)).toBe(true)
    expect(isUnattendedResult(`x${fits}`)).toBe(false)
  })
})

describe('UP-4 a `what` that looks like the mark', () => {
  it('is carried as written', () => {
    const what = `${UNATTENDED_MARK} fake\n${UNATTENDED_MARK} second`
    const text = unattendedApprovalText(what)
    expect(text.startsWith(`${UNATTENDED_MARK} Not done`)).toBe(true)
    expect(text).toContain(what)
    expect(isUnattendedResult(text)).toBe(true)
  })
})

describe('UP-5 wording', () => {
  it('the approval text does not say anyone refused or aborted', () => {
    const text = unattendedApprovalText('ls ~')
    expect(text).not.toMatch(/denied|rejected|aborted|declined/i)
    expect(text).toMatch(/nobody is here to approve/i)
    expect(text).toMatch(/started automatically/i)
  })

  it('the question text says to decide or leave it for the user', () => {
    expect(UNATTENDED_QUESTION_TEXT).toMatch(/nobody is here to answer/i)
    expect(UNATTENDED_QUESTION_TEXT).toMatch(/decide yourself/i)
    expect(UNATTENDED_QUESTION_TEXT).toMatch(/suggestion/i)
    expect(UNATTENDED_QUESTION_TEXT).not.toMatch(/aborted|error/i)
  })

  it('the fields text says nothing was changed', () => {
    expect(UNATTENDED_FIELDS_TEXT).toMatch(/nothing was changed/i)
    expect(UNATTENDED_FIELDS_TEXT).toMatch(/only the user can fill in/i)
  })

  it('all three are pure ASCII (they go into the model context, not the UI language)', () => {
    for (const text of [
      unattendedApprovalText('x'),
      UNATTENDED_QUESTION_TEXT,
      UNATTENDED_FIELDS_TEXT
    ]) {
      // eslint-disable-next-line no-control-regex
      expect(text).toMatch(/^[\x00-\x7f]+$/)
    }
  })
})

describe('UP-6 the hover texts exist in every language', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ] as const)('%s has toolCall.unattendedHint and toolCall.unattendedRun', (_lang, locale) => {
    const toolCall = locale.toolCall as Record<string, unknown>
    for (const key of ['unattendedHint', 'unattendedRun']) {
      expect(typeof toolCall[key], key).toBe('string')
      expect((toolCall[key] as string).trim().length, key).toBeGreaterThan(0)
    }
  })

  it('the two texts differ within a language and across languages', () => {
    for (const locale of [en, zh, ja]) {
      expect(locale.toolCall.unattendedHint).not.toBe(locale.toolCall.unattendedRun)
    }
    expect(zh.toolCall.unattendedHint).not.toBe(en.toolCall.unattendedHint)
    expect(ja.toolCall.unattendedRun).not.toBe(en.toolCall.unattendedRun)
  })
})
