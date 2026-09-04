/**
 * bot 门控段 agent（`bot-intent`）的守护测试。
 *
 * 边界先说清：它是 **agent md**（`shuvix: agent v1`），不是 bot md —— bot 是「一份绑定」
 * （身份 + 管线 + 槽位 + 正文），门控段是内置 bot-chat 管线 `intent` 槽位（与 `recheck`
 * 槽位）的缺省人选。`task` 槽位没有内置专属档案：bot md 自己指定任意一份 agent md。
 * 曾经的 `bot-notes` 段已随「bot 自己维护自己的正文」一起退役 —— 那几条写法纪律现在住在
 * renderBotContext 的前言里（botContext.test.ts），不再是某个 agent 的人格。
 *
 * 解析器不读文件类型标记，所以「别把它写成 bot」只能靠守卫（BA-8）。其余不变式来自
 * docs/bot-design.md §6：只可派发、恒零工具、不钉扎模型、不带项目注入、结构化输出的
 * 枚举词汇不能被翻译掉，以及「bot 的完整档案在系统提示词里」这句话三语言都得在场 ——
 * 门控提示词里不再有笔记块，模型知道去哪找档案全靠这一句。
 */
import { describe, expect, it, vi } from 'vitest'
import { detectShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { BOT_INTENT_SPEC, BUILTIN_PROFILE_SPECS } from '../index'
import { buildBuiltinProfile } from '../spec'
import type { BuiltinProfileSpec } from '../spec'
import type { AgentProfile } from '../../types'

const LANGS = ['en', 'zh', 'ja'] as const

const build = (spec: BuiltinProfileSpec, language: string): AgentProfile =>
  buildBuiltinProfile(spec, { language }) as AgentProfile

describe('bot 门控段 agent —— 结构钉板', () => {
  it('BA-1 三语言均可解析且零 console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const language of LANGS) {
        expect(build(BOT_INTENT_SPEC, language), `bot-intent.${language}`).not.toBeNull()
      }
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('BA-2 不声明会话感知（只可派发）且 name 恒等于 spec.name', () => {
    // 门控段切成主会话人格毫无意义 —— 不声明会话感知，用户在输入框里选不到
    for (const language of LANGS) {
      const profile = build(BOT_INTENT_SPEC, language)
      expect(profile.sessionAwareness, language).toBe(false)
      expect(profile.name, language).toBe(BOT_INTENT_SPEC.name)
    }
  })

  it('BA-4 工具白名单为空（门控段恒零工具）', () => {
    // 它经 next 契约把结果交回管线脚本，由脚本调注入的能力落地（say）；自己不持有任何
    // 工具。管线脚本另有一行 `tools: []` 把用户覆盖它之后长出的工具再收窄一次 —— 两道都要
    for (const language of LANGS) {
      expect(build(BOT_INTENT_SPEC, language).tools, language).toEqual([])
    }
  })

  it('BA-5 不声明 shuvix-model（模型由覆盖文件 / 派发链决定）', () => {
    // 门控模型是设置页写覆盖文件的一等配置，内置不得钉扎
    for (const language of LANGS) {
      expect(build(BOT_INTENT_SPEC, language).model, language).toBeUndefined()
    }
  })

  it('BA-6 不带项目注入（钉住内置 md 的当前形态）', () => {
    // 门控段跑在每条消息的首字节路径上，两项注入皆取缺省 —— 与 titler 同一取舍；
    // bot 自己的档案另经 systemContext 追加，不走这两个开关
    for (const language of LANGS) {
      const profile = build(BOT_INTENT_SPEC, language)
      expect(profile.projectAwareness, language).toBe(false)
      expect(profile.instructionFiles, language).toEqual([])
    }
  })

  it('BA-7 description 三语言均非空且互不相同', () => {
    const en = build(BOT_INTENT_SPEC, 'en').description
    expect(en.length).toBeGreaterThan(0)
    for (const language of ['zh', 'ja'] as const) {
      const d = build(BOT_INTENT_SPEC, language).description
      expect(d.length, language).toBeGreaterThan(0)
      expect(d, language).not.toBe(en)
    }
  })

  it('BA-8 三份 md 都带 shuvix: agent v1 标记（解析器不读标记，只能靠守卫防误写成 bot）', () => {
    expect(Object.keys(BOT_INTENT_SPEC.sources).sort()).toEqual(['en', 'ja', 'zh'])
    for (const [language, raw] of Object.entries(BOT_INTENT_SPEC.sources)) {
      expect(detectShuvixMarker(raw), `bot-intent.${language}`).toEqual({
        type: 'agent',
        version: 1
      })
    }
  })

  it.each(LANGS)(
    'BA-9 bot-intent.%s：意图契约的枚举词汇在正文里都在场，退役字段一个不剩',
    (language) => {
      // 结构化输出的枚举值不能被翻译掉 —— 正文若把 `reply`/`ignore` 译成本地词，
      // 模型写出的判决就对不上结果契约。
      const prompt = build(BOT_INTENT_SPEC, language).systemPrompt
      for (const token of ['reply', 'task', 'clarify', 'ignore']) {
        expect(prompt, `bot-intent.${language} 缺 ${token}`).toContain(token)
      }
      // 反向：`relevance` 评分与 `memorable` 标记已从 intent / intentSolo 契约里删掉
      // （笔记场合没了，「值不值得记」不再是门控要答的问题）。正文若还教模型填它们，
      // 模型会在契约里找一个不存在的字段 —— 轻则被 typebox 纠错一轮，重则整段判决作废
      for (const gone of ['memorable', 'relevance']) {
        expect(prompt, `bot-intent.${language} 仍提到退役字段 ${gone}`).not.toContain(gone)
      }
    }
  )

  it.each(LANGS)('BA-10 bot-intent.%s：正文说明「bot 的完整档案在系统提示词里」', (language) => {
    // 门控提示词里不再有笔记块（bot-chat 的 gate prompt 只给名字 + 描述 + 窗口 + 新消息）；
    // 人设与记忆经 systemContext 追加在系统提示词末尾。模型要拿它判「这条与我相关吗」，
    // 得先知道往哪看 —— 这一句是唯一的路标，三语言都不能少
    const prompt = build(BOT_INTENT_SPEC, language).systemPrompt
    const pointer = { en: /system prompt/i, zh: /系统提示词/, ja: /システムプロンプト/ }[language]!
    expect(prompt, `bot-intent.${language} 没说档案在系统提示词里`).toMatch(pointer)
  })

  it('BA-11 已注册进 BUILTIN_PROFILE_SPECS；退役的 bot-notes 不得再出现', () => {
    // 没注册 = 派发时找不到；bot-notes 若被谁「顺手加回来」，宿主没有任何路径会派发它，
    // 只会在设置页多出一个没人用的 agent
    const names = BUILTIN_PROFILE_SPECS.map((s) => s.name)
    expect(names).toContain('bot-intent')
    expect(names).not.toContain('bot-notes')
  })

  it.each(LANGS)('BA-12 bot-intent.%s：复核契约的词汇（proceed / skip）同样在场', (language) => {
    // 同一份档案缺省也演 recheck 槽位（bot-chat 里 `input.agents.recheck || input.agents.intent`），
    // 出队复核走的是另一份契约 —— 正文得告诉它「有时问你的是另一个问题」，否则它会拿
    // reply/task 去答一个只认 proceed/skip 的契约
    const prompt = build(BOT_INTENT_SPEC, language).systemPrompt
    for (const token of ['proceed', 'skip']) {
      expect(prompt, `bot-intent.${language} 缺 ${token}`).toContain(token)
    }
  })
})
