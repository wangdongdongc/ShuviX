/**
 * 派发可发现性 + explore 回报设计的守护测试。
 *
 * ## 为什么要钉「派发清单里有没有它」
 *
 * 派发工具的 description 是**静态的**，不枚举可用 agent —— 一个 agent 能不能被用到，
 * 完全取决于调用方的系统提示里有没有点名它。而实测反复证明：agent 系统性地不用
 * 需要额外推理才会想起的东西（5 个真实会话里 `help` 调用 0 次、`evaluate` 对
 * `screenshot` 是 1:8；`Agent` 只派发过 3 次且全部省略了 name，explore 按名字派发 0 次）。
 *
 * 更直接的证据：那个 210 次浏览器调用的会话，`Agent` 派发 0 次 —— 最该外包的会话
 * 完全没外包，因为没人告诉它有这个选项。所以「名字在不在清单里」是这些 agent 是否
 * 存在的实际判据，值得单独钉住。
 *
 * ## 为什么要钉 explore 的回报措辞
 *
 * 同一套仪器测过 explore 的报告形态（Kimi API，N=20，看主 agent 是否回头自己重搜）：
 *
 *   散文摘要（无路径无行号）                100% 重搜
 *   改前的 explore 设计（转述 + 罗列没找到的）  30%
 *   去掉「罗列没找到的」                      15~20%
 *   引用真实代码行                            10%
 *   引用 + 明确完备性声明                      5%
 *   主 agent 自己 grep                         0%
 *
 * 归纳出的原则：**收口搜索空间有效，罗列缺口有害**。两者都是在讲范围，一个把问题
 * 关上，一个把问题打开。改前的 md 恰好写反了（"Say what you looked for and did NOT
 * find"），实测代价约 10~15 个百分点。
 */
import { describe, it, expect } from 'vitest'
import { buildBuiltinProfile } from '../spec'
import { BROWSER_SPEC, CODING_SPEC, DEFAULT_SPEC, EXPLORE_SPEC } from '../index'
import type { BuiltinProfileSpec } from '../spec'
import type { AgentProfile } from '../../types'

const LANGS = ['en', 'zh', 'ja'] as const
const build = (spec: BuiltinProfileSpec, language: string): AgentProfile =>
  buildBuiltinProfile(spec, { language, widgetsRoot: '/w', wikiRoot: '/k' }) as AgentProfile

describe('派发清单点名了哪些 agent', () => {
  it.each(LANGS)('%s：coding 点名 browser / explore / visualization', (language) => {
    const s = build(CODING_SPEC, language).systemPrompt
    for (const name of ['**browser**', '**explore**', '**visualization**']) {
      expect(s, `coding.${language} 缺 ${name}`).toContain(name)
    }
  })

  it.each(LANGS)('%s：default 点名 browser', (language) => {
    // default 手里有 browser 工具，浏览器密集的活儿正是它最该外包的
    expect(build(DEFAULT_SPEC, language).systemPrompt).toContain('**browser**')
  })

  it.each(LANGS)('%s：派发 browser 时提示带上浏览器现状', (language) => {
    // 挡的是「新 agent 不知道已登录，重开 tab 重走一遍登录」这条真实浪费。
    // browser 自己的 md 有「先 list_tabs」兜底，这里是调用方一侧的第二道。
    const s = build(CODING_SPEC, language).systemPrompt.toLowerCase()
    const hints = ['already signed in', '是否已登录', 'ログイン済み']
    expect(
      hints.some((h) => s.includes(h.toLowerCase())),
      `coding.${language} 缺现状提示`
    ).toBe(true)
  })

  it('browser 档案本身可被构建 —— 点名了却建不出来等于没有', () => {
    for (const language of LANGS) expect(build(BROWSER_SPEC, language).name).toBe('browser')
  })
})

describe('explore 的回报设计（实测驱动，改 md 时别写回去）', () => {
  it.each(LANGS)('%s：要求引用代码，而不是转述', (language) => {
    // 转述实测 15~20% 重搜，引用降到 10%
    const s = build(EXPLORE_SPEC, language).systemPrompt.toLowerCase()
    const hints = [
      "quote the code, don't describe",
      '引用代码，不要描述代码',
      'コードを説明せず、引用する'
    ]
    expect(
      hints.some((h) => s.includes(h.toLowerCase())),
      `explore.${language} 缺该要求`
    ).toBe(true)
  })

  it.each(LANGS)('%s：要求收口搜索空间（完备性声明）', (language) => {
    // 明确「这就是全部」把重搜率压到 5%
    const s = build(EXPLORE_SPEC, language).systemPrompt.toLowerCase()
    const hints = ['close the search space', '把搜索空间收口', '検索空間を閉じる']
    expect(
      hints.some((h) => s.includes(h.toLowerCase())),
      `explore.${language} 缺该要求`
    ).toBe(true)
  })

  it.each(LANGS)('%s：不再要求罗列「查过但没找到的地方」', (language) => {
    // 改前那条指令实测让重搜率涨 10~15pp —— 读起来像是在邀请对方补查。
    // 保留的只是「被问的东西确实不存在时明说」，那是收口不是开口。
    const s = build(EXPLORE_SPEC, language).systemPrompt
    const removed = [
      'Say what you looked for and did NOT find',
      '说明你找过但**没有**找到什么、在哪些地方找过',
      '探したが**見つからなかった**もの、そしてどこを探したかを明記する'
    ]
    for (const r of removed) expect(s, `explore.${language} 又出现了 ${r}`).not.toContain(r)
  })

  it.each(LANGS)('%s：仍保留「不要报告没读过的路径」这条', (language) => {
    const s = build(EXPLORE_SPEC, language).systemPrompt.toLowerCase()
    const hints = ['did not actually read', '没有真正读过', '実際に読んでいない']
    expect(
      hints.some((h) => s.includes(h.toLowerCase())),
      `explore.${language} 缺该约束`
    ).toBe(true)
  })
})
