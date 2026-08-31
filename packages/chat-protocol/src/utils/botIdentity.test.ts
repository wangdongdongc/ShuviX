/**
 * botIdentity 单元 —— bot 视觉身份的两只纯函数（A0 · 聊天会话最小可聊面）。
 *
 * botColorFor 以 **name**（身份键）定色：同名恒同色、恒落在色板内 —— 这是
 * 「同一个 bot 在卡头 / 侧栏 / 创建对话框 / 设置页颜色一致」的全部根基；
 * botInitial 以 **displayName** 取首字：按码点切（spread），不劈代理对。
 *
 * 快照类断言（A0-4 / A0-10）钉的是**现状**：色板或散列算法一旦改动，历史会话里
 * 每个 bot 的头像都会换色 —— 这些用例红了就是在提醒「你正在改所有人的脸」。
 */
import { describe, expect, it } from 'vitest'
import { BOT_COLOR_PALETTE, botColorFor, botInitial } from './botIdentity'

describe('BOT_COLOR_PALETTE', () => {
  // A0-1 色板不变量：长度恰 8、全 #rrggbb、无重复
  it('恰 8 项、全为 #rrggbb、无重复', () => {
    expect(BOT_COLOR_PALETTE).toHaveLength(8)
    for (const color of BOT_COLOR_PALETTE) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(new Set(BOT_COLOR_PALETTE).size).toBe(BOT_COLOR_PALETTE.length)
  })
})

describe('botColorFor', () => {
  // A0-2 同名恒同色且恒在色板内（ASCII / CJK / emoji / 长名 / 含 - 名）
  it('同名两次调用恒同色，且结果恒在色板内', () => {
    const names = [
      'alice', // ASCII
      '小助手', // CJK
      '😀bot', // emoji（代理对开头）
      'a-very-long-bot-name-with-many-chars', // 长名
      'e2e-alpha' // 含 - 名
    ]
    const palette: readonly string[] = BOT_COLOR_PALETTE
    for (const name of names) {
      const first = botColorFor(name)
      const second = botColorFor(name)
      expect(second).toBe(first)
      expect(palette).toContain(first)
    }
  })

  // A0-3 空串不特判：h=0 → 色板第 0 项
  it("botColorFor('') 是色板第 0 项（h=0，不特判）", () => {
    expect(botColorFor('')).toBe(BOT_COLOR_PALETTE[0])
  })

  // A0-4 定色快照：钉住具体名字的具体色值（换色板/换散列 = 所有历史头像换色，必须显式过这一关）
  it('定色快照：具体名字的具体色值', () => {
    expect(botColorFor('alice')).toBe('#79c0ff')
    expect(botColorFor('Bob')).toBe('#f2cc60')
    expect(botColorFor('小助手')).toBe('#d2a8ff')
  })

  // A0-5 代理对名字不抛、稳定（for...of 按码点迭代，codePointAt 拿完整码点）
  it('代理对开头的名字不抛且稳定', () => {
    expect(() => botColorFor('😀bot')).not.toThrow()
    expect(botColorFor('😀bot')).toBe(botColorFor('😀bot'))
  })
})

describe('botInitial', () => {
  // A0-6 拉丁字母大写化
  it('拉丁首字大写化', () => {
    expect(botInitial('alice')).toBe('A')
    expect(botInitial('Bob')).toBe('B')
  })

  // A0-7 先 trim 再取首字
  it('先 trim：前导空白不算首字', () => {
    expect(botInitial('  bob')).toBe('B')
  })

  // A0-8 空串 / 纯空白 → '?'
  it("空串与纯空白回落 '?'", () => {
    expect(botInitial('')).toBe('?')
    expect(botInitial('   ')).toBe('?')
  })

  // A0-9 代理对不劈：spread 按码点切
  it('代理对不劈：emoji 与 CJK 首字完整', () => {
    expect(botInitial('😀 Bot')).toBe('😀')
    expect(botInitial('小助手')).toBe('小')
  })

  // A0-10 白盒特性钉住（现状，改实现前先看这里）：
  //  (a) 'ß'.toUpperCase() === 'SS' —— 首「字」可以是两个字母
  //  (b) 按码点不认 grapheme：ZWJ 家庭 emoji 只取第一个人，旗帜只取第一个区域指示符
  it("白盒钉住：'ßeta'→'SS'；ZWJ/旗帜按码点劈（不认 grapheme）", () => {
    expect(botInitial('ßeta')).toBe('SS')
    expect(botInitial('👨‍👩‍👧x')).toBe('👨')
    expect(botInitial('🇨🇳')).toBe('🇨')
  })
})
