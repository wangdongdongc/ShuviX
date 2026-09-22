/**
 * 提示片段（`agentProfile/fragments/`）—— `renderVisualGuide` / `renderVisualCraft` 的语言回退、
 * 两个开关（`drawingSkill` / `artifact`）各自切掉哪一段，以及「哪些内置档案引用了
 * `{{shuvix:visualGuide}}` / `{{shuvix:visualCraft}}`」这份归属。
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
 *  - POINTER `builtin:drawing` —— 只在「先加载技能」那句指路里；
 *  - EXAMPLE 「```svg + 换行 + <svg」—— 手艺段的范例围栏（载体段那个 ```svg 后面跟的是空格）；
 *  - CARRIER 「```svg + 空格」—— 只在载体段那一句「回复里的 ```svg 围栏会内联渲染」里：范例围栏的
 *    ```svg 后面跟的是换行，技能指路里没有围栏；
 *  - ADOPT `adopt` —— 三种语言里都只出现在「改图走 adopt」那一段；
 *  - CONTRACT —— 契约段的一组记号：无论两个开关怎么拨都必须在。
 *
 * 两处例外只能认本地化措辞，那两张表因此得手维护（同 builtinContent.test.ts 的 FACE_TERMS）：
 *  - BUDGET_HEADING —— 「框与箭头」那段预算没有任何代码记号可认，只能认它的小标题；
 *  - DIAGRAM_TERM —— 指路那句点名「流程或结构图」的说法。
 * 改了这两处的措辞请同步表：这里会红，但红的原因是表过期而不是片段坏了。
 */
import { describe, it, expect } from 'vitest'
import { renderVisualCraft, renderVisualGuide, type VisualGuideOptions } from '../fragments'
import { buildBuiltinProfiles, BASE_PROFILE_NAMES } from '../../subagent/builtinAgents'

const LANGUAGES = ['en', 'zh', 'ja']

const POINTER = 'builtin:drawing'
const EXAMPLE = '```svg\n<svg'
/** 围栏记号 + 一个空格：载体段那句里的写法（范例围栏后面是换行，见文件头） */
const CARRIER = '```svg '
const ADOPT = 'adopt'
/**
 * 「框与箭头」预算段的小标题 —— 这一段没有代码记号，只能按本地化措辞认（见文件头）。
 * 它在两个出口 × 四种开关组合的**每一种**渲染里都得在：图再小也得守预算，而它不在任何界桩里。
 */
const BUDGET_HEADING: Record<string, string> = {
  en: '### Boxes and arrows',
  zh: '### 框与箭头',
  ja: '### 箱と矢印'
}
/** 指路那句里点名「流程或结构图」的说法（技能如今也管框与箭头，指路得把它说出来） */
const DIAGRAM_TERM: Record<string, string> = {
  en: 'flow or structure diagram',
  zh: '流程或结构图',
  ja: '流れや構造の図'
}
const CONTRACT = [
  'viewBox',
  'role="img"',
  'aria-label',
  '--viz-1',
  '--theme-text-secondary',
  '<style>',
  '<foreignObject>',
  '<script>'
]

/** 两个开关的四种组合 */
const OPTS: VisualGuideOptions[] = [
  { drawingSkill: false, artifact: false },
  { drawingSkill: true, artifact: false },
  { drawingSkill: false, artifact: true },
  { drawingSkill: true, artifact: true }
]
const label = (opts: VisualGuideOptions): string =>
  `drawingSkill=${!!opts.drawingSkill} artifact=${!!opts.artifact}`

/** 两个出口；craft 只认 drawingSkill（多给的 artifact 被忽略 —— 类型上它就只收那一个键） */
const EXITS = [
  ['guide', (l: string, o?: VisualGuideOptions): string => renderVisualGuide(l, o)],
  ['craft', (l: string, o?: VisualGuideOptions): string => renderVisualCraft(l, o)]
] as const

/** 子串出现次数 */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1
/** 按空行切段（与片段 md 的段落边界一致） */
const paragraphs = (text: string): string[] =>
  text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'

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
  it.each(LANGUAGES)('%s 取到对应 md，非空且已 trim', (language) => {
    const out = renderVisualGuide(language)
    expect(out.length).toBeGreaterThan(200)
    expect(out).toBe(out.trim())
    expect(out.startsWith('#')).toBe(true) // 自含块：值自带小标题，可嵌在正文任意位置
  })

  it('三份各不相同（漏译会让某一语言静默拿到英文原文，而那看不出来）', () => {
    const [en, zh, ja] = LANGUAGES.map((l) => renderVisualGuide(l))
    expect(new Set([en, zh, ja]).size).toBe(3)
  })

  it('精确语言 → 基础语言：zh-CN 落到 zh', () => {
    expect(renderVisualGuide('zh-CN')).toBe(renderVisualGuide('zh'))
    expect(renderVisualGuide('ja-JP')).toBe(renderVisualGuide('ja'))
  })

  it.each([undefined, '', 'ko', 'de-DE', 'xx'])('未翻译语言与缺省都回落 en：%j', (language) => {
    expect(renderVisualGuide(language)).toBe(renderVisualGuide('en'))
  })

  it('大小写不敏感（i18next.language 可能给 zh-CN / ZH）', () => {
    expect(renderVisualGuide('ZH')).toBe(renderVisualGuide('zh'))
  })
})

/**
 * 两个开关 —— 都描述**这一个 agent 手里有什么**（宿主按创建时的工具名单判定），缺省即「没有」：
 *  - `drawingSkill`：货架上有 `builtin:drawing` → 手艺段换成一句「先加载技能」的指路；
 *  - `artifact`：工具表里有 `artifact` → 载体段里多一句「改图走 adopt」（只有 guide 这一档有载体）。
 * 契约段不在任何界桩里：两个开关怎么拨它都得在。
 */
describe('renderVisualGuide / renderVisualCraft —— 两个开关（VG）', () => {
  it.each(LANGUAGES)('VG-1 %s：两个出口 × 四种组合，契约记号一个不少', (language) => {
    for (const [exit, render] of EXITS) {
      for (const opts of OPTS) {
        const out = render(language, opts)
        for (const token of CONTRACT) {
          expect(out, `${exit} ${label(opts)} 缺 ${token}`).toContain(token)
        }
      }
    }
  })

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
    'VG-3 %s：没有技能时手艺段（含范例）原样在；有技能时范例没了、整体变短，除指路那一段外每段都逐字来自无技能版',
    (language) => {
      for (const [exit, render] of EXITS) {
        for (const artifact of [false, true]) {
          const without = render(language, { drawingSkill: false, artifact })
          const withSkill = render(language, { drawingSkill: true, artifact })
          const what = `${exit} artifact=${artifact}`
          expect(without, what).toContain(EXAMPLE)
          expect(withSkill, what).not.toContain(EXAMPLE)
          expect(withSkill.length, what).toBeLessThan(without.length)
          // 换掉的只有手艺段：其余每一段都是同一份片段里的原文，没有被顺手改写或截断
          const kept = paragraphs(withSkill).filter((p) => !p.includes(POINTER))
          expect(kept.length, what).toBeGreaterThan(0)
          for (const p of kept) expect(without, `${what}：${p.slice(0, 40)}`).toContain(p)
        }
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-4 %s：artifact 为真时 guide 教 adopt 并点名 `artifact`；缺省 / false 不教；craft 无论如何都不教',
    (language) => {
      const taught = renderVisualGuide(language, { artifact: true })
      expect(taught).toContain(ADOPT)
      expect(taught).toContain('`artifact`')
      expect(renderVisualGuide(language)).not.toContain(ADOPT)
      expect(renderVisualGuide(language, { artifact: false })).not.toContain(ADOPT)
      // craft 没有载体段，adopt 嵌在载体里 —— 硬塞 artifact 进去也不该冒出来
      for (const drawingSkill of [false, true]) {
        const craft = renderVisualCraft(language, { drawingSkill, artifact: true } as never)
        expect(craft, `drawingSkill=${drawingSkill}`).not.toContain(ADOPT)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-5 %s：guide 里 ADOPT 只随 artifact 变、POINTER 只随 drawingSkill 变（两个开关互不串扰）',
    (language) => {
      for (const opts of OPTS) {
        const out = renderVisualGuide(language, opts)
        expect(out.includes(ADOPT), label(opts)).toBe(!!opts.artifact)
        expect(out.includes(POINTER), label(opts)).toBe(!!opts.drawingSkill)
      }
    }
  )

  it.each(LANGUAGES)(
    'VG-6 %s：八种输出都干净 —— 无界桩残留、无三连换行、已 trim、以小标题开头、非空',
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
          // 自含块：值自带小标题，可嵌在正文任意位置
          expect(out.startsWith('#'), what).toBe(true)
          expect(out.length, what).toBeGreaterThan(200)
        }
      }
    }
  )

  it.each(LANGUAGES)('VG-7 %s：缺省 / {} / 两个都 false —— 逐字节相同', (language) => {
    for (const [exit, render] of EXITS) {
      const bare = render(language)
      expect(render(language, {}), exit).toBe(bare)
      expect(render(language, { drawingSkill: false, artifact: false }), exit).toBe(bare)
    }
  })

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
    'P-1 %s：指路那一段点名了流程或结构图 —— 画框与箭头之前也该先加载技能',
    (language) => {
      // 技能多了 diagrams 这份参考之后，指路若只说「数据图」，模型画流程图时就不会去加载它
      for (const [exit, render] of EXITS) {
        const hits = paragraphs(render(language, { drawingSkill: true })).filter((p) =>
          p.includes(POINTER)
        )
        expect(hits, exit).toHaveLength(1)
        expect(hits[0], exit).toContain(DIAGRAM_TERM[language])
      }
    }
  )
})

/**
 * `{{shuvix:visualCraft}}` —— 同一份片段去掉「载体」那一段。两个出口的差集就是载体，
 * 而载体讲的是聊天的规矩（图是回复的一部分、改图走 `artifact adopt`）；把那几段讲给一个
 * 正在编辑文件的 agent，是教它一条走不通的路。
 */
describe('{{shuvix:visualCraft}} —— 只要手艺的那一档', () => {
  // 这一层只看得见占位符本身：`buildBuiltinProfiles` 出来的正文尚未代入（代入在创建期，
  // 由宿主的变量表供值）。「notebook 实际拿到的是手艺不是载体」因此钉在两端的
  // promptVarsWiring 用例里 —— 与文件头说的「谁引用 / 谁供值分开钉」同一条分工。
  it('恰好 notebook 一个档案引用它', () => {
    // 图往**文件**里画的档案才该拿这一档。多一个引用点 = 回来改这条，顺带交代理由
    expect(profilesUsing('visualCraft')).toEqual(['notebook'])
  })

  it.each(LANGUAGES)(
    'VC-1 %s：每种组合下 craft 都是 guide 的后缀，前面多出的那一截恰好是载体',
    (language) => {
      for (const opts of OPTS) {
        const guide = renderVisualGuide(language, opts)
        const craft = renderVisualCraft(language, { drawingSkill: opts.drawingSkill })
        const what = label(opts)
        // 契约与手艺一字不差地同源 —— 抄成两份 md 迟早只改一边，这条就是拦它的。
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
  it.each(LANGUAGES)('NM-1 %s：两个出口 × 四种组合的渲染里都没有 mermaid', (language) => {
    for (const [exit, render] of EXITS) {
      for (const opts of OPTS) {
        const out = render(language, opts)
        const what = `${exit} ${label(opts)}`
        // 正控制组：确实渲染出了那份片段（契约记号在）
        expect(out, what).toContain('viewBox')
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
 * 预算（BG）—— 「框与箭头」那段是**契约的一部分**，不是手艺：图再小也得守，所以它不在任何
 * 界桩里，两个开关怎么拨都原样在（有技能时手艺换成指路，预算照旧常驻）。
 */
describe('「框与箭头」预算段常驻（BG）', () => {
  /** 从小标题到下一个以 `#` 开头的行（不含），去掉首尾空白 */
  const budgetBlock = (text: string, heading: string): string | null => {
    const start = text.indexOf(heading)
    if (start < 0) return null
    const rest = text.slice(start + heading.length)
    const next = rest.search(/^#/m)
    return (heading + (next < 0 ? rest : rest.slice(0, next))).trim()
  }

  it.each(LANGUAGES)(
    'BG-1 %s：同一段预算在八种渲染里各恰好出现一次，且写着 5 与 4 这两个上限',
    (language) => {
      // 规范版取自「无技能的 craft」：那里预算段后面紧跟手艺段的小标题，边界明确
      // （有技能时后面跟的是指路段落，没有小标题可以截）
      const canonical = budgetBlock(
        renderVisualCraft(language, { drawingSkill: false }),
        BUDGET_HEADING[language]
      )
      expect(canonical, `${language} 找不到「${BUDGET_HEADING[language]}」`).not.toBeNull()
      // 正控制组：截出来的不只是一行小标题
      expect(canonical!.split('\n').length).toBeGreaterThan(3)
      expect(canonical).toMatch(/\b5\b/)
      expect(canonical).toMatch(/\b4\b/)
      for (const [exit, render] of EXITS) {
        for (const opts of OPTS) {
          expect(countOf(render(language, opts), canonical!), `${exit} ${label(opts)}`).toBe(1)
        }
      }
    }
  )
})

/**
 * 「谁点了作图技能的名」与「谁的正文用作图说明」必须是同一批档案：档案点了名却不引用片段，
 * 技能就只是白占货架；引用了片段却不点名，那句「先加载技能」的指路就永远不会出现 —— 手艺
 * 整段常驻，技能形同虚设。
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
      expect(declaring).toEqual(['bot', 'chat', 'coding', 'notebook', 'tab', 'work'])
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
      // 特征串从片段本身取（不抄文案）：任取片段里一行足够长的、别处不会出现的文本。
      const marks = LANGUAGES.map((l) => {
        const line = renderVisualGuide(l)
          .split('\n')
          .filter((s) => s.trim().length > 40)
        return line[1] ?? line[0]
      })
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

  it('基座名单里只有 notebook 不画图 —— 另外三个基座都引用了片段', () => {
    const using = new Set(profilesUsingVisualGuide())
    const basesWithout = [...BASE_PROFILE_NAMES].filter((n) => !using.has(n)).sort()
    expect(basesWithout).toEqual(['notebook'])
  })
})
