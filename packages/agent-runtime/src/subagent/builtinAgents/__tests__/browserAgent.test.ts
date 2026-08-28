/**
 * browser 内置档案的守护测试。
 *
 * 这个 agent 的价值全部押在**回报形态**上，而形态写在 md 正文里 —— 一段谁都能改、
 * 改坏了又不会有任何编译或运行期报错的散文。所以这里钉的不是「它能不能跑」，
 * 而是那几段实测证明有决定性作用的文字还在不在。
 *
 * 实测依据（Kimi API，每格 N=20，同一批事实换不同形态给主 agent，看它是否回头自己再验）：
 *
 *   形态                  确认发现问题   否定结论
 *   自己做（原始输出）        0% 重验      47% 重验
 *   结构化断言报告            0%           30%
 *   散文式摘要               40%          50%
 *
 * 散文式摘要会让一半的收益被重验吃掉 —— assertions 模板不是排版偏好，是这个 agent
 * 成立的前提。另一条反直觉的实测：报告里明确罗列「没查什么」会把重验率推到 30%，
 * 因为那读起来像是在邀请对方补查，所以 md 里明写了不要那么做。
 *
 * 另外「先 list_tabs」那条铁律也实测过：拿 md 正文当系统提示、派发提示里故意给出
 * 登录凭据（最容易诱发「开新 tab 重走登录」的场景），20/20 仍然先查已有标签页。
 */
import { describe, it, expect } from 'vitest'
import { buildBuiltinProfile } from '../spec'
import { BROWSER_SPEC } from '../index'
import type { AgentProfile } from '../../types'

const LANGS = ['en', 'zh', 'ja'] as const
const build = (language: string): AgentProfile =>
  buildBuiltinProfile(BROWSER_SPEC, { language }) as AgentProfile

describe('browser 档案的结构', () => {
  it.each(LANGS)('%s：解析成合法档案，工具面收窄到 browser + read', (language) => {
    const p = build(language)
    expect(p).not.toBeNull()
    expect(p.name).toBe('browser')
    expect(p.tools).toEqual(['browser', 'read'])
    expect(p.description.length).toBeGreaterThan(0)
    expect(p.systemPrompt.length).toBeGreaterThan(500)
  })

  it.each(LANGS)('%s：没有写入类工具 —— 它只负责看和报，不改任何东西', (language) => {
    const p = build(language)
    for (const forbidden of ['write', 'edit', 'bash', 'agent']) {
      expect(p.tools, `${language} 不该有 ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('决定成败的三段文字（改 md 时别删）', () => {
  it.each(LANGS)('%s：报告模板里的 assertions 结构还在', (language) => {
    // 散文式摘要实测让重验率从 0% 涨到 40%~50%
    const s = build(language).systemPrompt
    for (const key of ['assertions:', 'CONFIRMED', 'console_errors', 'unexpected']) {
      expect(s, `${language} 缺 ${key}`).toContain(key)
    }
  })

  it.each(LANGS)('%s：「先 list_tabs、复用已有 tab」的铁律还在', (language) => {
    // 挡的是「外包之后新 agent 重开 tab、重走登录」这条真实浪费
    const s = build(language).systemPrompt
    expect(s, `${language} 缺 list_tabs`).toContain('list_tabs')
  })

  it.each(LANGS)('%s：仍然告诫「不要罗列没查什么」', (language) => {
    // 反直觉的实测结论：列出 not_checked 会把重验率推到 30%
    const s = build(language).systemPrompt.toLowerCase()
    const hints = ['did not check', '没查', '調べなかった']
    expect(
      hints.some((h) => s.includes(h.toLowerCase())),
      `${language} 缺该告诫`
    ).toBe(true)
  })

  it.each(LANGS)('%s：仍然要求给出测量值而不只是判定', (language) => {
    const s = build(language).systemPrompt
    // 三份文案都用同一个例子（侧边栏/表格的像素边界）说明「值 vs 结论」的区别
    expect(s).toMatch(/190px|190 px/)
  })
})

describe('三份语言文件的一致性', () => {
  it('结构化键名不翻译 —— 否则调用方要按语言分别解析', () => {
    // 正文可以本地化，报告模板的键必须是同一套：主 agent 读到的是键，不是散文
    const keys = [
      'task:',
      'steps:',
      'assertions:',
      'console_errors:',
      'network_failures:',
      'unexpected:'
    ]
    for (const language of LANGS) {
      const s = build(language).systemPrompt
      for (const k of keys) expect(s, `${language} 缺 ${k}`).toContain(k)
    }
  })

  it('工具白名单与注入声明三语一致', () => {
    const built = LANGS.map((l) => build(l))
    for (const p of built.slice(1)) {
      expect(p.tools).toEqual(built[0].tools)
      expect(p.instructionFiles).toEqual(built[0].instructionFiles)
      expect(p.projectPrompt).toBe(built[0].projectPrompt)
    }
  })
})
