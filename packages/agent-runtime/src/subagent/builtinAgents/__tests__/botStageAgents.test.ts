/**
 * bot 阶段 agent（`bot-intent` / `bot-notes`）的守护测试。
 *
 * 边界先说清：它们是 **agent md**（`shuvix: agent v1`），不是 bot md —— bot 是「一个
 * 有人设的聊天参与者」，阶段 agent 是它内部的执行段。解析器不读文件类型标记，所以
 * 「别把它写成 bot」只能靠守卫（BA-8）。
 *
 * 其余四条不变式来自 docs/bot-design.md §6：dispatch-only、工具白名单一空一实
 * （门控段恒零工具；笔记段拿 read/edit，因为它就地编辑 bot 自己的那份 md）、
 * 都不钉扎模型、结构化输出的枚举词汇不能被翻译掉。
 */
import { describe, expect, it, vi } from 'vitest'
import { detectShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { BOT_INTENT_SPEC, BOT_NOTES_SPEC, BUILTIN_PROFILE_SPECS } from '../index'
import { buildBuiltinProfile } from '../spec'
import type { BuiltinProfileSpec } from '../spec'
import type { AgentProfile } from '../../types'

const LANGS = ['en', 'zh', 'ja'] as const
const SPECS: ReadonlyArray<[string, BuiltinProfileSpec]> = [
  ['bot-intent', BOT_INTENT_SPEC],
  ['bot-notes', BOT_NOTES_SPEC]
]

const build = (spec: BuiltinProfileSpec, language: string): AgentProfile =>
  buildBuiltinProfile(spec, { language }) as AgentProfile

describe('bot 阶段 agent —— 结构钉板', () => {
  it('BA-1 两个 spec × 三语言均可解析且零 console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const [name, spec] of SPECS) {
        for (const language of LANGS) {
          expect(build(spec, language), `${name}.${language}`).not.toBeNull()
        }
      }
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it.each(SPECS)('BA-2 %s：dispatch-only 且 name 恒等于 spec.name', (name, spec) => {
    // 阶段 agent 切成主会话人格毫无意义 —— 只可派发
    for (const language of LANGS) {
      const profile = build(spec, language)
      expect(profile.dispatchOnly, `${name}.${language}`).toBe(true)
      expect(profile.name, `${name}.${language}`).toBe(spec.name)
    }
  })

  it('BA-3 bot-notes 拿 read + edit（它就地编辑 bot 自己的那份 md）', () => {
    // 笔记段没有专用写入工具，也不把整段笔记交回宿主落盘：它读 bot 的 md、用 `edit` 只改
    // 变化的那几行。要的因此是普通文件工具 —— 与 BA-4 的门控段（恒零工具）成对照。
    for (const language of LANGS) {
      expect(build(BOT_NOTES_SPEC, language).tools, language).toEqual(['read', 'edit'])
    }
  })

  it('BA-4 bot-intent 的工具白名单同样为空（门控段恒零工具）', () => {
    for (const language of LANGS) {
      expect(build(BOT_INTENT_SPEC, language).tools, language).toEqual([])
    }
  })

  it.each(SPECS)('BA-5 %s：不声明 shuvix-model（模型由覆盖文件/派发链决定）', (name, spec) => {
    // 门控模型是设置页写覆盖文件的一等配置，内置不得钉扎；记忆段异步跟随会话模型
    for (const language of LANGS) {
      expect(build(spec, language).model, `${name}.${language}`).toBeUndefined()
    }
  })

  it.each(SPECS)('BA-6 %s：不带项目注入（钉住内置 md 的当前形态）', (name, spec) => {
    // 两段都跑在 bot 的内部链路上（门控更在首字节路径上），内置 md 两项皆取缺省 ——
    // 与 titler 同一取舍。要改成「记忆段带项目感知」时，本例是那次决定的落点。
    for (const language of LANGS) {
      const profile = build(spec, language)
      expect(profile.projectAwareness, `${name}.${language}`).toBe(false)
      expect(profile.instructionFiles, `${name}.${language}`).toEqual([])
    }
  })

  it.each(SPECS)('BA-7 %s：description 三语言均非空且互不相同', (name, spec) => {
    const en = build(spec, 'en').description
    expect(en.length, name).toBeGreaterThan(0)
    for (const language of ['zh', 'ja'] as const) {
      const d = build(spec, language).description
      expect(d.length, `${name}.${language}`).toBeGreaterThan(0)
      expect(d, `${name}.${language}`).not.toBe(en)
    }
  })

  it('BA-8 六份 md 都带 shuvix: agent v1 标记（解析器不读标记，只能靠守卫防误写成 bot）', () => {
    for (const [name, spec] of SPECS) {
      for (const [language, raw] of Object.entries(spec.sources)) {
        expect(detectShuvixMarker(raw), `${name}.${language}`).toEqual({
          type: 'agent',
          version: 1
        })
      }
    }
  })

  it.each(LANGS)('BA-9 bot-intent.%s：意图契约的枚举词汇在正文里都在场', (language) => {
    // 结构化输出的枚举值不能被翻译掉 —— 正文若把 `reply`/`ignore` 译成本地词，
    // 模型写出的判决就对不上结果契约。
    const prompt = build(BOT_INTENT_SPEC, language).systemPrompt
    for (const token of ['reply', 'task', 'clarify', 'ignore', 'relevance', 'memorable']) {
      expect(prompt, `bot-intent.${language} 缺 ${token}`).toContain(token)
    }
  })

  it.each(LANGS)('BA-10 bot-notes.%s：就地编辑形态下的两条纪律在场', (language) => {
    const prompt = build(BOT_NOTES_SPEC, language).systemPrompt
    // 它拿的是普通文件工具（BA-3），改得动这份 md 的每一行 —— 包括分界线以上的人设。
    // 所以正文里要在场的不是工具名，而是这个形态下最容易致命的两条纪律。
    //
    // ① 什么都不改是常态（否则每次都重写 = LangMem 点名的噪声反模式）
    const noop = { en: /changing nothing/i, zh: /什么都不改/, ja: /何も変えない/ }[language]!
    expect(prompt, `bot-notes.${language} 缺「什么都不改是常态」`).toMatch(noop)
    // ② 人设归用户所有，只在对话明确要求改角色时才动。分界线是**组织性**的、不是权限墙
    //    （botNotes 裁决 ③），所以「别顺手动人设」只能是写在提示词里的纪律 —— 少了它，
    //    一次整理笔记就能把用户写的设定改掉。钉小节标题 + 「唯一的例外」两个锚点。
    const persona = {
      en: [/persona above the line/i, /the one exception/i],
      zh: [/线以上的人设/, /唯一的例外/],
      ja: [/線より上の人格/, /唯一の例外/]
    }[language]!
    for (const re of persona) {
      expect(prompt, `bot-notes.${language} 缺「人设只在用户要求时才动」(${re})`).toMatch(re)
    }
  })

  it('BA-11 两个 spec 已注册进 BUILTIN_PROFILE_SPECS（没注册 = 派发时找不到）', () => {
    const names = BUILTIN_PROFILE_SPECS.map((s) => s.name)
    expect(names).toContain('bot-intent')
    expect(names).toContain('bot-notes')
  })
})
