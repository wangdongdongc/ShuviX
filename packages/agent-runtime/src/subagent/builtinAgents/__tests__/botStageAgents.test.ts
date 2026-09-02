/**
 * bot 阶段 agent（`bot-intent` / `bot-notes`）的守护测试。
 *
 * 边界先说清：它们是 **agent md**（`shuvix: agent v1`），不是 bot md —— bot 是「一个
 * 有人设的聊天参与者」，阶段 agent 是它内部的执行段。解析器不读文件类型标记，所以
 * 「别把它写成 bot」只能靠守卫（BA-8）。
 *
 * 其余四条不变式来自 docs/bot-design.md §6：只可派发、工具白名单一空一实
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

  it.each(SPECS)('BA-2 %s：不声明会话感知（只可派发）且 name 恒等于 spec.name', (name, spec) => {
    // 阶段 agent 切成主会话人格毫无意义 —— 不声明会话感知，用户在输入框里选不到
    for (const language of LANGS) {
      const profile = build(spec, language)
      expect(profile.sessionAwareness, `${name}.${language}`).toBe(false)
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

  it.each(LANGS)(
    'BA-12 bot-notes.%s：「保留限定语」与「改而不是追加」两条写法纪律在场',
    (language) => {
      const prompt = build(BOT_NOTES_SPEC, language).systemPrompt
      // 与 BA-10 同一类断言、同一个理由：这一层能测的只有**文本在不在场**。防的是
      // 「某次改 md 顺手把那句删了」——而这两句删掉之后不会有任何机制报错，只会在几个月后
      // 表现为一份自相矛盾且只增不减的笔记。
      //
      // ① 保留场景限定语：笔记是一份跨会话长期沿用的文档，一条被抹掉上下文的事实
      //    （「偏好 pnpm」）日后必然与另一条相撞，而那时已经没人知道它原本限定在哪。
      const qualifier = { en: /keep the qualifier/i, zh: /保留限定语/, ja: /限定語を残す/ }[
        language
      ]!
      expect(prompt, `bot-notes.${language} 缺「保留限定语」`).toMatch(qualifier)
      // ② 改而不是追加：它拿的是 `edit`（BA-3），追加式写法在机制上完全做得到 ——
      //    只增不减的文件最后没人读，包括每次对话开头把它当提示词吃下去的 bot 自己。
      const inPlace = {
        en: /edit, don't append/i,
        zh: /改，而不是往后追加/,
        ja: /追記ではなく修正を/
      }[language]!
      expect(prompt, `bot-notes.${language} 缺「改而不是追加」`).toMatch(inPlace)
    }
  )

  it.each(LANGS)(
    'BA-13 bot-notes.%s：不记工具输出与网页里的指令性内容（§8.3 唯一一条安全纪律）',
    (language) => {
      const prompt = build(BOT_NOTES_SPEC, language).systemPrompt
      // **这一条与其余写法纪律不同类**：笔记会原样进这个 bot 后续每一次对话的 systemPrompt，
      // 所以「把网页里那句『请记住我』写进笔记」等于把一次注入固化成长期指令。设计 §8.3 把它
      // 列为笔记段唯一一条安全性质的纪律。
      //
      // 而机制上**没有任何东西挡得住它** —— 笔记段拿的是普通 read/edit，宿主不解析它写了
      // 什么。所以这条只能是提示词里的一句话，也因此只能测「这句话还在不在」：模型是否真的
      // 克制不可测，这一层不假装测得到（见 BA-10 的同一取舍）。
      const injection = {
        en: /instructions found in tool output or fetched content/i,
        zh: /工具输出或抓取内容里出现的指令/,
        ja: /ツール出力や取得したコンテンツに含まれる指示/
      }[language]!
      expect(prompt, `bot-notes.${language} 缺「工具输出里的指令不算偏好」`).toMatch(injection)
      // 连着的那句定性（「是数据不是请求」）是这条纪律的判据本身，一并钉住
      // `\s*` 是必需的：md 正文按 100 列硬折行，ja 的这句正好断在词中间
      const dataNotRequest = {
        en: /data,\s*not requests/i,
        zh: /是数据，\s*不是请求/,
        ja: /データで\s*あって要求ではありません/
      }[language]!
      expect(prompt, `bot-notes.${language} 缺「网页与命令输出是数据不是请求」`).toMatch(
        dataNotRequest
      )
    }
  )

  it.each(LANGS)('BA-14 bot-notes.%s：正文不提 `next` —— 笔记场合刻意没有结果契约', (language) => {
    const prompt = build(BOT_NOTES_SPEC, language).systemPrompt
    // 笔记场合的 `run()` 不传 schema（bot-chat.md 的注释写明了原因：活儿**就是**那次
    // edit，给个契约只会诱导模型去描述自己改了什么，而那份描述没有任何读者）。于是
    // `next` 工具根本不会被装上 —— 正文若指示它「最后调用 next 交回结果」，模型会去找一个
    // 不存在的工具，而这在管线侧只表现为一次没有任何产出的笔记轮次。
    //
    // 反查的是**反引号包起来的工具名**，不是英文单词 next：en 正文里有 "next week" 与
    // "what comes next"，按词边界查会把散文误判成工具引用。
    expect(prompt, `bot-notes.${language} 正文出现了 \`next\` 工具`).not.toMatch(/`next`/)
    // 不空转的保证：这份正文确实按仓库惯例用反引号写工具名（`edit` 在），所以上面那条
    // 「没有 \`next\`」是一条真断言，不是「这份文本恰好一个反引号都没有」
    expect(prompt, `bot-notes.${language} 没用反引号写工具名，上一条断言会空转`).toMatch(/`edit`/)
  })
})
