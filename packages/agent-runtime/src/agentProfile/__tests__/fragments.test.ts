/**
 * 提示片段（`agentProfile/fragments/`）—— `renderVisualGuide` / `renderVisualCraft` 的语言回退、
 * 三个开关（`drawingSkill` / `artifact` / `interactive`）各自带来哪一段，以及「哪些内置档案引用了
 * `{{shuvix:visualGuide}}` / `{{shuvix:visualCraft}}`」这份归属。
 *
 * **2026-09-24 契约换了形状**（用户裁决，照 Claude 自己 `show_widget` + `read_me` 的模式）：
 * ```svg 的契约、框箭头预算与范例图**只在 `builtin:drawing` 技能里**；片段只剩载体（这张图去哪儿，
 * 内嵌 adopt）、load（「本会话第一张图之前先加载技能」）与交互段（内嵌 interactive-adopt）。
 * 技能不在架 ⇒ 两个出口都是空串。所以这里从「契约常驻」反过来钉「契约不常驻」；契约 / 预算 /
 * 范例在技能里的在场由 builtinSkillsResources.test.ts 的 BS-14 / BS-15 钉，范例图守不守契约由
 * app-shell 的 builtinSkillsFigures.dom.test.ts 钉（它现在扫的是 SKILL.md）。
 *
 * 两件事分开在两处钉：
 *  - **谁引用** 在这里（档案自己的事，纯文本，不需要宿主）；
 *  - **谁供值** 在两端各自的 promptVarsWiring 用例里（宿主的事）。
 * 合成一条就会出现「一端供了值、另一端没供」照样绿的情形 —— 少供一个值不报错，
 * `substitutePromptVars` 只会把裸占位符原样发给模型。
 *
 * 刻意不测片段 md 的散文文案：那是提示词措辞，会随调优改动，钉住只会制造维护噪声。
 * 这里只钉结构（语言回退、非空、自含块、被谁引用），段落只凭**代码记号**认 —— 三种语言里
 * 一字不差的那些：
 *  - POINTER `builtin:drawing` —— 只在 load 段那句「先加载技能」里；任何一种渲染里至多一次
 *    （交互段也指向技能，但说的是「那个作图技能」，不重复点名）；
 *  - CARRIER 「```svg + 空格」—— 载体段那一句「回复里的 ```svg 围栏会内联渲染」。交互段里也有一处
 *    （「静态的仍用 ```svg 图」），所以「恰好一次」只在不开 interactive 时成立；
 *  - ADOPT `adopt` —— 只在两段「改图 / 改块走 adopt」里；
 *  - EXAMPLE 「```svg + 换行 + <svg」—— 范例图的围栏。范例如今只在技能里，片段里一张都不该有；
 *  - LEAKS —— 契约的代码记号（token、十六进制颜色、宽高、role / aria-label、被剥掉的标签、`<svg`、
 *    字号、交互块的库与桥）：任何组合下都不该出现。`viewBox` 例外：load 段要说清技能里有什么，
 *    会点它的名 —— 所以它只许出现在指路那一段里（出现在别处，就是有人把那条规矩搬回来了）；
 *  - INTERACTIVE「```interactive」/ REFERENCE `references/interactive.md` / HTML_ADOPT「`.html`」——
 *    交互段（第三个开关 `interactive`，VG-I 组）。它只属于聊天、只在回复落在能跑它的地方、而且
 *    作图技能在架时才教：craft 这一档无论如何不教。
 *
 * 一处例外只能认本地化措辞，那张表因此得手维护（同 builtinContent.test.ts 的 FACE_TERMS）：
 *  - TWO_BOX —— load 段点名的最小的图（「哪怕只是两个框的草图」）。契约不常驻之后，哪一张图都得
 *    先加载技能；指路若只说「数据图」「流程图」，模型画两个框一根箭头时就不会去加载。
 * 改了这处措辞请同步表：这里会红，但红的原因是表过期而不是片段坏了。
 *
 * 编号变动（2026-09-24）：
 *  - VG-1「两个出口 × 四种组合，契约记号一个不少」删除 —— 契约搬进了技能，在场改由 BS-14 钉；
 *    这里换成反向的 VG-10（任何组合下都不带契约）。
 *  - BG-1「预算段在每种渲染里各恰好一次」删除 —— 同上，搬到 BS-14；这里换成 BG-2（预算不常驻）。
 *  - 新增 VG-9（技能不在架 ⇒ 空串）、VG-10、VG-11（`builtin:drawing` 恰好一次，含交互段）、BG-2。
 *  - 同号改写（守的还是那件事，按新形状重算）：VG-3 / VG-4 / VG-5 / VG-6 / VG-7 / P-1 / VC-1 /
 *    NM-1 / VG-I3 / VG-I4 / VG-I5，以及「titler / knowledge-writer / explore 不含片段特征串」那条
 *    （它原先从无参渲染里取特征串，契约改了之后那里是空串，断言就空转了）。
 */
import { describe, it, expect } from 'vitest'
import { renderVisualCraft, renderVisualGuide, type VisualGuideOptions } from '../fragments'
import { buildBuiltinProfiles, BASE_PROFILE_NAMES } from '../../subagent/builtinAgents'
import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'

const LANGUAGES = ['en', 'zh', 'ja']

const POINTER = 'builtin:drawing'
const EXAMPLE = '```svg\n<svg'
/** 围栏记号 + 一个空格：载体段那句里的写法（见文件头） */
const CARRIER = '```svg '
const ADOPT = 'adopt'
const INTERACTIVE = '```interactive'
/** 交互段指向技能里的那一页 */
const REFERENCE = 'references/interactive.md'
/** 「改块走 adopt」那一句的记号（只有它提 `.html`） */
const HTML_ADOPT = '`.html`'

/** load 段点名的最小的图 —— 只能按本地化措辞认（见文件头） */
const TWO_BOX: Record<string, string> = {
  en: 'two-box sketch',
  zh: '两个框的草图',
  ja: '二つの箱のスケッチ'
}

/** 契约的代码记号：如今只在技能里，任何一种渲染里都不该有（`viewBox` 另算，见 VG-10） */
const LEAKS: Array<[what: string, pattern: RegExp]> = [
  ['颜色 token', /--(viz|theme)-/],
  ['十六进制颜色', /#[0-9a-f]{3,8}\b/i],
  ['宽高', /\b(width|height)\b/],
  ['role="img"', /role="img"/],
  ['aria-label', /aria-label/],
  ['被剥掉的标签', /<(style|foreignObject|script)\b/i],
  ['一张图', /<svg\b/i],
  ['范例围栏', /```svg\n/],
  ['字号', /font-size/],
  ['交互块的库 / 桥', /shuvix-lib:\/\/|shuvix\.sendPrompt/]
]

/** 三个开关的八种组合 */
const ALL: VisualGuideOptions[] = [false, true].flatMap((drawingSkill) =>
  [false, true].flatMap((artifact) =>
    [false, true].map((interactive) => ({ drawingSkill, artifact, interactive }))
  )
)
/** 前两个开关的四种组合（interactive 关） */
const OPTS: VisualGuideOptions[] = ALL.filter((o) => !o.interactive)
/** 只开技能 */
const ON: VisualGuideOptions = { drawingSkill: true }
/** 全开：片段的每一段都在 —— 扫「片段里有没有 X」用它 */
const FULL: VisualGuideOptions = { drawingSkill: true, artifact: true, interactive: true }
const label = (o: VisualGuideOptions | undefined): string =>
  `drawingSkill=${!!o?.drawingSkill} artifact=${!!o?.artifact} interactive=${!!o?.interactive}`

/** 两个出口；craft 只认 drawingSkill（多给的 artifact / interactive 被忽略 —— 类型上它就只收那一个键） */
const EXITS = [
  ['guide', (l: string | undefined, o?: VisualGuideOptions): string => renderVisualGuide(l, o)],
  ['craft', (l: string | undefined, o?: VisualGuideOptions): string => renderVisualCraft(l, o)]
] as const

/** 子串出现次数 */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1
/** 按空行切段（与片段 md 的段落边界一致） */
const paragraphs = (text: string): string[] =>
  text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

/** 内置 md 的读取口：测试读构建期内联的**同一批文件**（桌面运行时读随包目录） */
const readMd = createInlineMdReader()
/** 文本里引用到的 `{{shuvix:name}}` 名字（去重排序） */
const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{shuvix:([A-Za-z][\w-]*)\}\}/g)].map((m) => m[1]))].sort()

/** 引用了某个占位符的内置档案名（按名去重，跨语言取并集） */
const profilesUsing = (placeholder: string): string[] => {
  const names = new Set<string>()
  for (const language of LANGUAGES) {
    for (const profile of buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets', readMd })) {
      if (placeholdersOf(profile.systemPrompt).includes(placeholder)) names.add(profile.name)
    }
  }
  return [...names].sort()
}
const profilesUsingVisualGuide = (): string[] => profilesUsing('visualGuide')

describe('renderVisualGuide —— 语言回退', () => {
  // 技能不在架时两个出口都是空串（VG-9），语言回退只在技能在架时看得见 —— 这一组因此都全开渲染
  it.each(LANGUAGES)('%s 取到对应 md，非空且已 trim', (language) => {
    const out = renderVisualGuide(language, FULL)
    expect(out.length).toBeGreaterThan(200)
    expect(out).toBe(out.trim())
    expect(out.startsWith('#')).toBe(true) // 自含块：值自带小标题，可嵌在正文任意位置
  })

  it('三份各不相同（漏译会让某一语言静默拿到英文原文，而那看不出来）', () => {
    const [en, zh, ja] = LANGUAGES.map((l) => renderVisualGuide(l, FULL))
    expect(new Set([en, zh, ja]).size).toBe(3)
  })

  it('精确语言 → 基础语言：zh-CN 落到 zh', () => {
    expect(renderVisualGuide('zh-CN', FULL)).toBe(renderVisualGuide('zh', FULL))
    expect(renderVisualGuide('ja-JP', FULL)).toBe(renderVisualGuide('ja', FULL))
  })

  it.each([undefined, '', 'ko', 'de-DE', 'xx'])('未翻译语言与缺省都回落 en：%j', (language) => {
    expect(renderVisualGuide(language, FULL)).toBe(renderVisualGuide('en', FULL))
  })

  it('大小写不敏感（i18next.language 可能给 zh-CN / ZH）', () => {
    expect(renderVisualGuide('ZH', FULL)).toBe(renderVisualGuide('zh', FULL))
  })
})

/**
 * 开关 —— 前两个都描述**这一个 agent 手里有什么**（宿主按创建时的工具名单判定），缺省即「没有」：
 *  - `drawingSkill`：货架上有 `builtin:drawing` → 才有这份说明（载体 + 先加载技能）；没有就是空串；
 *  - `artifact`：工具表里有 `artifact` → 载体段里多一句「改图走 adopt」（只有 guide 这一档有载体）。
 */
describe('renderVisualGuide / renderVisualCraft —— 开关（VG）', () => {
  it.each(LANGUAGES)(
    'VG-9 %s：技能不在架 ⇒ 两个出口都是空串，另外两个开关怎么拨都一样',
    (language) => {
      // 契约只在技能里：指一个拿不到的技能是死路，于是整份说明不出（占位符处收敛消失）
      for (const [exit, render] of EXITS) {
        for (const opts of [undefined, {}, ...ALL.filter((o) => !o.drawingSkill)]) {
          expect(render(language, opts), `${exit} ${label(opts)}`).toBe('')
        }
        // 正控制组：同一出口开了技能就有内容 —— 否则上面那圈可能只是函数整个坏了
        expect(render(language, ON), exit).not.toBe('')
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-2 %s：drawingSkill 为真时指路恰好出现一次；缺省 / {} / false 时连 `builtin:` 都没有',
    (language) => {
      for (const [exit, render] of EXITS) {
        expect(countOf(render(language, { drawingSkill: true }), POINTER), exit).toBe(1)
        for (const opts of [undefined, {}, { drawingSkill: false }]) {
          const out = render(language, opts)
          expect(countOf(out, POINTER), `${exit} ${JSON.stringify(opts)}`).toBe(0)
          expect(out, `${exit} ${JSON.stringify(opts)}`).not.toContain('builtin:')
        }
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-3 %s：有技能时两个出口都不带范例图；craft 就是指路那一段，guide（不开 interactive）也以它收尾 —— 指路之后不再跟手艺',
    (language) => {
      const craft = renderVisualCraft(language, ON)
      expect(paragraphs(craft), 'craft 应当恰好一段').toHaveLength(1)
      expect(craft).toContain(POINTER)
      expect(craft).not.toContain(EXAMPLE)
      for (const artifact of [false, true]) {
        const what = `artifact=${artifact}`
        const guide = renderVisualGuide(language, { drawingSkill: true, artifact })
        expect(guide, what).not.toContain(EXAMPLE)
        // 从前指路后面跟着手艺段与范例；如今最后一段就是指路本身
        expect(paragraphs(guide).at(-1), what).toBe(craft)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-4 %s：技能在架时 artifact 为真 guide 才教 adopt 并点名 `artifact`；缺省 / false 不教；craft 无论如何都不教；技能不在架时 adopt 也不单独冒出来',
    (language) => {
      const taught = renderVisualGuide(language, { drawingSkill: true, artifact: true })
      expect(taught).toContain(ADOPT)
      expect(taught).toContain('`artifact`')
      expect(renderVisualGuide(language, ON)).not.toContain(ADOPT)
      expect(renderVisualGuide(language, { drawingSkill: true, artifact: false })).not.toContain(
        ADOPT
      )
      // craft 没有载体段，adopt 嵌在载体里 —— 硬塞 artifact 进去也不该冒出来
      for (const drawingSkill of [false, true]) {
        const craft = renderVisualCraft(language, { drawingSkill, artifact: true } as never)
        expect(craft, `drawingSkill=${drawingSkill}`).not.toContain(ADOPT)
      }
      // adopt 是这份说明的一部分：技能不在架，手里有 artifact 也不单独教
      expect(renderVisualGuide(language, { artifact: true })).toBe('')
    }
  )

  it.each(LANGUAGES)(
    'VG-5 %s：guide 里 POINTER 只随 drawingSkill 变，ADOPT 随 artifact 且要技能在架（两个开关互不串扰）',
    (language) => {
      for (const opts of OPTS) {
        const out = renderVisualGuide(language, opts)
        expect(out.includes(POINTER), label(opts)).toBe(!!opts.drawingSkill)
        expect(out.includes(ADOPT), label(opts)).toBe(!!opts.drawingSkill && !!opts.artifact)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-6 %s：八种输出都干净 —— 无界桩残留、无三连换行、已 trim；有技能时 guide 以小标题开头、craft 恰好一段，没技能时是空串',
    (language) => {
      for (const [exit, render] of EXITS) {
        for (const opts of OPTS) {
          const out = render(language, opts)
          const what = `${exit} ${label(opts)}`
          // 界桩是 HTML 注释，模型看得见 —— 替换不干净就是把实现细节发给它
          expect(out, what).not.toContain('<!--')
          expect(out, what).not.toContain('shuvix:')
          // 整段删掉时前后两个空行会并成三连换行
          expect(out, what).not.toMatch(/\n{3,}/)
          expect(out, what).toBe(out.trim())
          if (!opts.drawingSkill) {
            expect(out, what).toBe('')
            continue
          }
          if (exit === 'guide') {
            // 自含块：值自带小标题，可嵌在正文任意位置
            expect(out.startsWith('#'), what).toBe(true)
            expect(out.length, what).toBeGreaterThan(200)
          } else {
            // craft 嵌在档案自己的段落之间：它只是一段
            expect(paragraphs(out), what).toHaveLength(1)
          }
        }
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-7 %s：缺省即「没有」—— 缺省 / {} / 三个都 false 逐字节相同（空串）；技能在架时另两个缺省 = 显式 false',
    (language) => {
      for (const [exit, render] of EXITS) {
        const bare = render(language)
        expect(bare, exit).toBe('')
        expect(render(language, {}), exit).toBe(bare)
        expect(
          render(language, { drawingSkill: false, artifact: false, interactive: false }),
          exit
        ).toBe(bare)
        expect(render(language, ON), exit).toBe(
          render(language, { drawingSkill: true, artifact: false, interactive: false })
        )
      }
    }
  )

  it('VG-8 指路那一段三语各不相同（漏译会静默拿到英文原文）；zh-CN 落到 zh、ko 落到 en', () => {
    for (const [exit, render] of EXITS) {
      const pointerParagraph = (language: string): string => {
        const hits = paragraphs(render(language, { drawingSkill: true })).filter((p) =>
          p.includes(POINTER)
        )
        expect(hits, `${exit}.${language}`).toHaveLength(1)
        return hits[0]
      }
      const [en, zh, ja] = LANGUAGES.map(pointerParagraph)
      expect(new Set([en, zh, ja]).size, exit).toBe(3)
      expect(render('zh-CN', { drawingSkill: true }), exit).toBe(
        render('zh', { drawingSkill: true })
      )
      expect(render('ko', { drawingSkill: true }), exit).toBe(render('en', { drawingSkill: true }))
    }
  })

  it.each(LANGUAGES)(
    'P-1 %s：指路那一段点名了最小的图（两个框的草图）—— 契约不常驻之后，哪一张图都得先加载技能',
    (language) => {
      // 从前「两个框一根箭头的草图用不着技能」；如今契约只在技能里，连它也得先加载
      for (const [exit, render] of EXITS) {
        const hits = paragraphs(render(language, ON)).filter((p) => p.includes(POINTER))
        expect(hits, exit).toHaveLength(1)
        expect(hits[0], exit).toContain(TWO_BOX[language])
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-10 %s：两个出口 × 八种组合都不带契约 —— 没有 token、十六进制、宽高、role / aria-label、被剥掉的标签、图；viewBox 只在指路那一段里被点名',
    (language) => {
      // 正控制组：全开的 guide 里片段的每一段都在 —— 下面扫的确实是整份片段，不是切剩的一截
      const full = renderVisualGuide(language, FULL)
      for (const marker of [POINTER, CARRIER, ADOPT, INTERACTIVE, REFERENCE, HTML_ADOPT]) {
        expect(full, marker).toContain(marker)
      }
      let viewBoxMentions = 0
      for (const [exit, render] of EXITS) {
        for (const opts of ALL) {
          const out = render(language, opts)
          const what = `${exit} ${label(opts)}`
          for (const [name, pattern] of LEAKS) {
            expect(out, `${what} 带了${name}`).not.toMatch(pattern)
          }
          // load 段说「技能里有 viewBox、颜色 token……」是在指路；别的段落再提 viewBox，就是规矩回来了
          for (const p of paragraphs(out).filter((q) => q.includes('viewBox'))) {
            expect(p, `${what}：viewBox 出现在指路之外`).toContain(POINTER)
            viewBoxMentions++
          }
        }
      }
      // 反向正控制组：指路那段确实点了 viewBox 的名 —— 否则上面那条「只在指路里」在空集上恒真
      expect(viewBoxMentions).toBeGreaterThan(0)
    }
  )

  it.each(LANGUAGES)(
    'VG-11 %s：技能在架的每种组合里 `builtin:drawing` 恰好出现一次 —— 交互段也指向技能，但不重复点名',
    (language) => {
      for (const [exit, render] of EXITS) {
        for (const opts of ALL.filter((o) => o.drawingSkill)) {
          const out = render(language, opts)
          expect(countOf(out, POINTER), `${exit} ${label(opts)}`).toBe(1)
          expect(countOf(out, 'builtin:'), `${exit} ${label(opts)}`).toBe(1)
        }
      }
      // 正控制组：交互段真的在，而且它也叫模型去技能里读那一页
      const withInteractive = renderVisualGuide(language, { drawingSkill: true, interactive: true })
      expect(withInteractive).toContain(INTERACTIVE)
      expect(withInteractive).toContain(REFERENCE)
    }
  )
})

/**
 * `{{shuvix:visualCraft}}` —— 同一份片段去掉「载体」那一段。两个出口的差集就是载体，
 * 而载体讲的是聊天的规矩（图是回复的一部分、改图走 `artifact adopt`）；把那几段讲给一个
 * 正在编辑文件的 agent，是教它一条走不通的路。
 */
describe('{{shuvix:visualCraft}} —— 不带载体的那一档', () => {
  // 这一层只看得见占位符本身：`buildBuiltinProfiles` 出来的正文尚未代入（代入在创建期，
  // 由宿主的变量表供值）。「notebook 实际拿到的是什么」因此钉在两端的
  // promptVarsWiring 用例里 —— 与文件头说的「谁引用 / 谁供值分开钉」同一条分工。
  it('恰好 notebook 与 coedit 两个档案引用它', () => {
    // 图往**文件**里画的档案才该拿这一档。多一个引用点 = 回来改这条，顺带交代理由
    // coedit（协作编辑窗口）与 notebook 一样：图画进用户的文档，不是画在回复里
    expect(profilesUsing('visualCraft')).toEqual(['coedit', 'notebook'])
  })

  it.each(LANGUAGES)(
    'VC-1 %s：技能在架时 craft 是 guide 的后缀，前面多出的那一截恰好是载体；技能不在架时两边都是空串',
    (language) => {
      for (const opts of OPTS) {
        const guide = renderVisualGuide(language, opts)
        const craft = renderVisualCraft(language, { drawingSkill: opts.drawingSkill })
        const what = label(opts)
        if (!opts.drawingSkill) {
          expect(guide, what).toBe('')
          expect(craft, what).toBe('')
          continue
        }
        // 同一份片段的两个出口 —— 抄成两份 md 迟早只改一边，这条就是拦它的。
        // 载体在片段最前面，所以不只是「包含」：guide 去掉载体之后剩下的正好是 craft
        expect(guide.endsWith(craft), what).toBe(true)
        expect(craft.length, what).toBeLessThan(guide.length)
        const carrier = guide.slice(0, guide.length - craft.length)
        // 载体只在 guide 里：「回复里的 ```svg 围栏会内联渲染」那句是聊天的规矩，
        // adopt 是聊天独有的改图路径（只随 artifact 开关出现）
        expect(countOf(carrier, CARRIER), what).toBe(1)
        expect(carrier.includes(ADOPT), what).toBe(!!opts.artifact)
        expect(countOf(guide, CARRIER), what).toBe(1)
        expect(craft, what).not.toContain(CARRIER)
        expect(craft, what).not.toContain(ADOPT)
      }
    }
  )
})

/**
 * mermaid 退场（NM）—— 结构图也手画 ```svg 之后，mermaid 不再出现在任何一份教给模型的文本里。
 *
 * 反向断言最容易空转（名单为空时恒绿），所以每条都带正控制组：渲染出来的确实是那份片段 /
 * 档案清单里确实有那几份基座。聊天里仍能**显示** mermaid（用户自己的 agent 可能写），
 * 那是 chat-ui 的事，与这里无关 —— 这里守的是「ShuviX 不再主动教它」。
 */
describe('mermaid 不再被教给模型（NM）', () => {
  it.each(LANGUAGES)('NM-1 %s：两个出口 × 八种组合的渲染里都没有 mermaid', (language) => {
    for (const [exit, render] of EXITS) {
      for (const opts of ALL) {
        const out = render(language, opts)
        const what = `${exit} ${label(opts)}`
        // 正控制组：技能在架时确实渲染出了那份片段（指路在）；不在架时本就是空串
        if (opts.drawingSkill) expect(out, what).toContain(POINTER)
        else expect(out, what).toBe('')
        expect(out, what).not.toMatch(/mermaid/i)
      }
    }
  })

  it.each(LANGUAGES)('NM-2 %s：内置档案（含正文、描述、工具名单）里都没有 mermaid', (language) => {
    const profiles = buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets', readMd })
    // 正控制组：会画图的五份档案都在清单里 —— 清单若是空的，下面那圈恒绿
    const names = profiles.map((p) => p.name)
    for (const name of ['notebook', 'work', 'chat', 'coding', 'bot']) {
      expect(names, `${language} 缺 ${name}`).toContain(name)
    }
    for (const profile of profiles) {
      expect(JSON.stringify(profile), `${profile.name}.${language}`).not.toMatch(/mermaid/i)
    }
  })
})

/**
 * 预算（BG）—— 「框与箭头」那段预算从前是常驻的（BG-1，已删），如今和契约一起只在技能里
 * （在场由 builtinSkillsResources.test.ts 的 BS-14 钉，技能与片段之间不重复由 BS-15 钉）。
 * 这里钉它不再回到片段里。
 */
describe('「框与箭头」预算不常驻（BG）', () => {
  it.each(LANGUAGES)(
    'BG-2 %s：两个出口 × 八种组合里都没有预算的两个上限（5 个框、一行 4 个）',
    (language) => {
      // 预算段没有代码记号可认，它的两个上限是它最不会被改写掉的部分
      // 正控制组：全开的 guide 非空，下面扫的不是一圈空串
      expect(renderVisualGuide(language, FULL).length).toBeGreaterThan(200)
      for (const [exit, render] of EXITS) {
        for (const opts of ALL) {
          expect(render(language, opts), `${exit} ${label(opts)}`).not.toMatch(/\b[45]\b/)
        }
      }
    }
  )
})

/**
 * 「谁点了作图技能的名」与「谁的正文用作图说明」必须是同一批档案：档案点了名却不引用片段，
 * 技能就只是白占货架、而模型永远不会被叫去加载它；引用了片段却不点名，那个占位符就永远是
 * 空串 —— 两边对不上时都不报错。
 */
describe('作图技能的归属（OWN）', () => {
  it.each(LANGUAGES)(
    'OWN-1 %s：声明 skill:builtin:drawing 的档案集合 = 引用 visualGuide / visualCraft 的档案集合',
    (language) => {
      const profiles = buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets', readMd })
      const declaring = profiles
        .filter((p) => p.tools.includes('skill:builtin:drawing'))
        .map((p) => p.name)
        .sort()
      const referencing = profiles
        .filter((p) => {
          const used = placeholdersOf(p.systemPrompt)
          return used.includes('visualGuide') || used.includes('visualCraft')
        })
        .map((p) => p.name)
        .sort()
      expect(declaring).toEqual(['bot', 'chat', 'coding', 'coedit', 'notebook', 'tab', 'work'])
      expect(referencing).toEqual(declaring)
    }
  )
})

describe('{{shuvix:visualGuide}} 的归属', () => {
  it('恰好 work / chat / coding / bot / tab 五个档案引用它', () => {
    // 加一个引用点 = 必须回来改这条，顺带交代理由。五个之外的档案引用它通常是复制粘贴
    // 带出来的（例如从 work 抄一段到 titler），而那一段提示对那个 agent 毫无意义。
    // tab（Chrome 侧边栏会话）在列：侧边栏里的 chat-ui 同样渲染 ```svg 图，用户问「把这页的数据画出来」
    // 是它的本分，没有 artifact —— 说明里的 adopt 那节按工具表自动缺席
    expect(profilesUsingVisualGuide()).toEqual(['bot', 'chat', 'coding', 'tab', 'work'])
  })

  it('三种语言的引用集一致（翻译时漏改占位符 = 那个语言下变量失效）', () => {
    for (const name of profilesUsingVisualGuide()) {
      for (const language of LANGUAGES) {
        const profile = buildBuiltinProfiles({ language, readMd }).find((p) => p.name === name)!
        expect(placeholdersOf(profile.systemPrompt), `${name}.${language}`).toContain('visualGuide')
      }
    }
  })

  it.each(['titler', 'knowledge-writer', 'explore'])(
    '%s 不引用它，正文里也不含片段正文的特征串',
    (name) => {
      // 特征串从片段本身取（不抄文案）：全开渲染里每一行足够长的、别处不会出现的文本。
      // 必须全开渲染 —— 技能不在架时片段是空串，从空串里取特征串，下面那圈就空转了
      const marks = LANGUAGES.flatMap((l) =>
        [renderVisualGuide(l, FULL), renderVisualCraft(l, ON)].flatMap((text) =>
          text.split('\n').filter((s) => s.trim().length > 40)
        )
      )
      expect(marks.length, '一条特征串都没取到 —— 下面那圈会空转').toBeGreaterThan(0)
      for (const language of LANGUAGES) {
        const profile = buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets', readMd }).find(
          (p) => p.name === name
        )
        expect(profile, `${name}.${language} 应当存在`).toBeDefined()
        expect(placeholdersOf(profile!.systemPrompt), `${name}.${language}`).not.toContain(
          'visualGuide'
        )
        for (const mark of marks) {
          expect(profile!.systemPrompt, `${name}.${language}`).not.toContain(mark)
        }
      }
    }
  )

  it('基座名单里只有 notebook 与 coedit 不引用 visualGuide —— 它们拿的是 visualCraft（图画进文档）', () => {
    const using = new Set(profilesUsingVisualGuide())
    const basesWithout = [...BASE_PROFILE_NAMES].filter((n) => !using.has(n)).sort()
    expect(basesWithout).toEqual(['coedit', 'notebook'])
  })
})

/**
 * 第三个开关 `interactive`（VG-I）—— 交互段。与前两个不同，它不看工具名单，看**回复落在哪儿**
 * （宿主判：桌面会话的根 agent 才给；Chrome 侧栏、派生 agent 不给），另外还要作图技能在架（整份
 * 说明的前提）：这一段只有「什么时候用 + 先读技能里的 references/interactive.md」和（有 artifact 时）
 * 「改块走 adopt」，契约本身在技能里。这里只钉片段这一层：只加不改、位置固定（跟在指路之后、
 * 一直到末尾）、与另外两个开关的关系、craft 这一档永远不教、契约不常驻。
 * 注意 CARRIER 记号（```svg + 空格）在交互段里也出现，所以 VC-1 的载体计数只在不开 interactive
 * 时成立，这里不去扩它。
 */
describe('第三个开关 interactive（VG-I）', () => {
  const LIB = 'shuvix-lib://'
  const BRIDGE = 'shuvix.sendPrompt'
  /** 交互块契约的记号 —— 契约只在技能里，片段在任何组合下都不带它们 */
  const CONTRACT_MARKERS = [LIB, BRIDGE]
  const MARKERS = [INTERACTIVE, REFERENCE, HTML_ADOPT]

  it.each(LANGUAGES)(
    'VG-I1 %s：guide 开了 interactive + 技能 + artifact 三个记号都在、契约记号一个没有；缺技能 / 缺省 / {} / false 一个都没有',
    (language) => {
      const on = renderVisualGuide(language, {
        interactive: true,
        drawingSkill: true,
        artifact: true
      })
      for (const marker of MARKERS) expect(on, marker).toContain(marker)
      for (const marker of CONTRACT_MARKERS) expect(on, marker).not.toContain(marker)
      for (const opts of [
        undefined,
        {},
        { interactive: false, drawingSkill: true },
        { interactive: true, drawingSkill: false, artifact: true }
      ]) {
        const off = renderVisualGuide(language, opts)
        for (const marker of [...MARKERS, ...CONTRACT_MARKERS])
          expect(off, `${JSON.stringify(opts)} ${marker}`).not.toContain(marker)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-I2 %s：craft 硬塞 interactive 也不教（笔记本的 live preview 不渲染交互块）',
    (language) => {
      for (const drawingSkill of [false, true]) {
        const craft = renderVisualCraft(language, { drawingSkill, interactive: true } as never)
        for (const marker of [...MARKERS, ...CONTRACT_MARKERS]) {
          expect(craft, `drawingSkill=${drawingSkill} ${marker}`).not.toContain(marker)
        }
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-I3 %s：开关只加不改 —— 关时的每一段按原顺序都在开时里；多出来的几段连成一片，以小标题开头、紧跟指路段、一直到末尾；没有技能时什么都不加',
    (language) => {
      for (const artifact of [false, true]) {
        // 技能不在架：开了也仍是空串
        expect(
          renderVisualGuide(language, { artifact, interactive: true }),
          `artifact=${artifact}`
        ).toBe(renderVisualGuide(language, { artifact }))
        expect(renderVisualGuide(language, { artifact }), `artifact=${artifact}`).toBe('')
      }
      for (const artifact of [false, true]) {
        const what = `artifact=${artifact}`
        const off = paragraphs(renderVisualGuide(language, { drawingSkill: true, artifact }))
        const on = paragraphs(
          renderVisualGuide(language, { drawingSkill: true, artifact, interactive: true })
        )
        // 贪心匹配子序列：on 里依次认出 off 的每一段，认不出的就是多出来的
        const extra: number[] = []
        let j = 0
        on.forEach((p, i) => {
          if (j < off.length && p === off[j]) j++
          else extra.push(i)
        })
        expect(j, `${what}：关时的段落没有按顺序全部出现在开时里`).toBe(off.length)
        expect(extra.length, what).toBeGreaterThan(2)
        // 连成一片
        expect(extra, what).toEqual(Array.from({ length: extra.length }, (_, k) => extra[0] + k))
        const first = extra[0]
        const last = extra[extra.length - 1]
        expect(on[first].startsWith('### '), `${what}：多出来的那片应以小标题开头`).toBe(true)
        // 紧跟指路段：交互段说的「那个作图技能」就是前一段点了名的那一个
        expect(first, what).toBeGreaterThan(0)
        expect(on[first - 1], `${what}：交互段前面应当正是指路那一段`).toContain(POINTER)
        // 一直到末尾：交互段之后不再跟任何东西
        expect(last, `${what}：交互段之后还有内容`).toBe(on.length - 1)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-I4 %s：八种组合下 POINTER 只随 drawingSkill、ADOPT 随 artifact 且技能在架、INTERACTIVE 随 interactive 且技能在架、改块那句还要 artifact、契约记号从不出现',
    (language) => {
      for (const opts of ALL) {
        const out = renderVisualGuide(language, opts)
        const skill = !!opts.drawingSkill
        expect(out.includes(POINTER), label(opts)).toBe(skill)
        expect(out.includes(ADOPT), label(opts)).toBe(skill && !!opts.artifact)
        const taught = skill && !!opts.interactive
        expect(out.includes(INTERACTIVE), label(opts)).toBe(taught)
        expect(out.includes(HTML_ADOPT), label(opts)).toBe(taught && !!opts.artifact)
        for (const marker of CONTRACT_MARKERS)
          expect(out, `${label(opts)} ${marker}`).not.toContain(marker)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-I5 %s：两个出口 × 八种组合都干净；技能在架时指路恰好一次、guide 以小标题开头，不在架时是空串',
    (language) => {
      let checked = 0
      for (const [exit, render] of EXITS) {
        for (const opts of ALL) {
          const out = render(language, opts)
          const what = `${exit} ${label(opts)}`
          expect(out, what).not.toContain('<!--')
          expect(out, what).not.toContain('shuvix:')
          expect(out, what).not.toMatch(/\n{3,}/)
          expect(out, what).toBe(out.trim())
          if (opts.drawingSkill) {
            expect(countOf(out, POINTER), `${what} 指路`).toBe(1)
            if (exit === 'guide') expect(out.startsWith('#'), what).toBe(true)
          } else {
            expect(out, what).toBe('')
          }
          checked++
        }
      }
      expect(checked).toBe(16)
    }
  )
})
