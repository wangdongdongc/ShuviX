/**
 * 界面一侧的占位符工具（utils/redactionPlaceholders.ts）：
 *   RP-1 切开：文字与占位符交替；只认标准写法；没有占位符时整段原样
 *   RP-2 去重列出、取类别、整段判断
 *   RP-3 换回真值：查不到的原样留着
 *   RP-4 流式结尾半个占位符先截掉；写完的、不像占位符的不截
 *   RP-5 第一个读者（§15.2）：readerKey 拆得回去，别的形状不认；会话的模型与每个读者都照发才算模型收到真值
 */
import { describe, expect, it } from 'vitest'
import {
  categoryOfPlaceholder,
  disclosedFor,
  hasPlaceholder,
  isPlaceholder,
  parseReaderKey,
  placeholdersIn,
  readerKey,
  restorePlaceholders,
  splitPlaceholders,
  trimPartialPlaceholder
} from './redactionPlaceholders'

const KEY = '{{API_KEY_k3v7x2mq}}'
const MAIL = '{{EMAIL_b5puzbfv}}'

describe('占位符（界面）', () => {
  it('RP-1 切开', () => {
    expect(splitPlaceholders(`use ${KEY} and ${MAIL}.`)).toEqual([
      'use ',
      { placeholder: KEY, category: 'API_KEY' },
      ' and ',
      { placeholder: MAIL, category: 'EMAIL' },
      '.'
    ])
    expect(splitPlaceholders(KEY)).toEqual([{ placeholder: KEY, category: 'API_KEY' }])
    // 写坏的、大小写不对的、{{shuvixInlineToken:x}} 都不算
    for (const text of [
      '{{ API_KEY_k3v7x2mq }}',
      '{{api_key_k3v7x2mq}}',
      '{{shuvixInlineToken:a1}}',
      'plain'
    ]) {
      expect(splitPlaceholders(text)).toEqual([text])
    }
  })

  it('RP-2 列出、类别、判断', () => {
    expect(placeholdersIn(`${KEY} ${MAIL} ${KEY}`)).toEqual([KEY, MAIL])
    expect(categoryOfPlaceholder('{{REDACTED_PRIVATE_KEY_aaaaaaaa}}')).toBe('PRIVATE_KEY')
    // v0.2.30 / v0.2.31 的旧写法
    expect(categoryOfPlaceholder('{{PRIVATE_KEY_aaaaaaaa}}')).toBe('PRIVATE_KEY')
    expect(isPlaceholder('{{REDACTED_PRIVATE_KEY_aaaaaaaa}}')).toBe(true)
    expect(isPlaceholder(KEY)).toBe(true)
    expect(isPlaceholder(` ${KEY}`)).toBe(false)
    expect(hasPlaceholder(`x ${KEY}`)).toBe(true)
    expect(hasPlaceholder('{{x}}')).toBe(false)
  })

  it('RP-3 换回真值', () => {
    const values: Record<string, string> = { [KEY]: 'sk-real' }
    expect(restorePlaceholders(`a ${KEY} b ${MAIL}`, (p) => values[p])).toBe(`a sk-real b ${MAIL}`)
  })

  it('RP-4 流式结尾', () => {
    for (const tail of [
      '{{',
      '{{A',
      '{{API_KE',
      '{{API_KEY_',
      '{{API_KEY_k3v7',
      '{{API_KEY_k3v7x2mq}'
    ]) {
      expect(trimPartialPlaceholder(`text ${tail}`), tail).toBe('text ')
    }
    expect(trimPartialPlaceholder(`text ${KEY}`)).toBe(`text ${KEY}`)
    expect(trimPartialPlaceholder('text {{ x')).toBe('text {{ x')
    expect(trimPartialPlaceholder('a {{b}} c')).toBe('a {{b}} c')
  })

  it('RP-5 第一个读者', () => {
    const home = readerKey('home', 'qwen:32b')
    expect(parseReaderKey(home)).toEqual({ provider: 'home', model: 'qwen:32b' })
    for (const bad of ['', 'home', '\u0000m', 'p\u0000', 'a\u0000b\u0000c']) {
      expect(parseReaderKey(bad), JSON.stringify(bad)).toBeUndefined()
    }
    const cloud = readerKey('cloud', 'c1')
    const info = {
      category: 'EMAIL',
      value: 'a@b.cn',
      disclosed: true,
      disclosedTo: { [home]: true }
    }
    expect(disclosedFor(info, [])).toBe(true)
    expect(disclosedFor(info, [home])).toBe(true)
    expect(disclosedFor(info, [home, cloud])).toBe(false)
    expect(disclosedFor({ ...info, disclosed: false }, [home])).toBe(false)
    expect(disclosedFor(undefined, [])).toBe(false)
  })
})
