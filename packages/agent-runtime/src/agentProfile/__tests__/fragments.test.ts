/**
 * 提示片段（`agentProfile/fragments/`）—— `renderVisualGuide` 的语言回退，以及
 * 「哪些内置档案引用了 `{{shuvix:visualGuide}}`」这份归属。
 *
 * 两件事分开在两处钉：
 *  - **谁引用** 在这里（档案自己的事，纯文本，不需要宿主）；
 *  - **谁供值** 在两端各自的 promptVarsWiring 用例里（宿主的事）。
 * 合成一条就会出现「一端供了值、另一端没供」照样绿的情形 —— 少供一个值不报错，
 * `substitutePromptVars` 只会把裸占位符原样发给模型。
 *
 * 刻意不测片段 md 的散文文案：那是提示词措辞，会随调优改动，钉住只会制造维护噪声。
 * 这里只钉结构（语言回退、非空、自含块、被谁引用）。
 */
import { describe, it, expect } from 'vitest'
import { renderVisualGuide } from '../fragments'
import { buildBuiltinProfiles, BASE_PROFILE_NAMES } from '../../subagent/builtinAgents'

const LANGUAGES = ['en', 'zh', 'ja']

/** 文本里引用到的 `{{shuvix:name}}` 名字（去重排序） */
const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{shuvix:([A-Za-z][\w-]*)\}\}/g)].map((m) => m[1]))].sort()

/** 引用了 visualGuide 的内置档案名（按名去重，跨语言取并集） */
const profilesUsingVisualGuide = (): string[] => {
  const names = new Set<string>()
  for (const language of LANGUAGES) {
    for (const profile of buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets' })) {
      if (placeholdersOf(profile.systemPrompt).includes('visualGuide')) names.add(profile.name)
    }
  }
  return [...names].sort()
}

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

describe('renderVisualGuide —— skillShelf：唯一的宿主分支', () => {
  // 分的不是围栏（渲染在共用的 chat-ui 里，两端都成立），是那句「动笔前先加载
  // `builtin:drawing`」：内置技能货架只有桌面端有（扩展端的 resolveTools 直接丢弃 `skill:` 名，
  // 那边没有 SkillTool）。少了这个分支，扩展端每个 root agent 的系统提示都会指挥模型去加载
  // 一个那里根本不存在的技能 —— 一条永远走不通的指路比没有指路更糟。
  const BUILTIN_SKILL = 'builtin:drawing'

  it.each(LANGUAGES)('%s：带 skillShelf 才有那句指路，不带时整行消失', (language) => {
    expect(renderVisualGuide(language, { skillShelf: true })).toContain(BUILTIN_SKILL)
    expect(renderVisualGuide(language)).not.toContain(BUILTIN_SKILL)
    expect(renderVisualGuide(language, { skillShelf: false })).not.toContain(BUILTIN_SKILL)
  })

  it.each(LANGUAGES)('%s：两种取值下都不残留标记，也不留出空行豁口', (language) => {
    for (const shelf of [true, false]) {
      const out = renderVisualGuide(language, { skillShelf: shelf })
      // 标记是 HTML 注释，模型看得见 —— 替换不干净就是把实现细节发给它
      expect(out, `skillShelf=${shelf}`).not.toContain('shuvix:skill-hint')
      // 不带指路时那一行被替成空串，前后两个空行会并成一个三连换行
      expect(out, `skillShelf=${shelf}`).not.toMatch(/\n{3,}/)
    }
  })

  it.each(LANGUAGES)('%s：两种取值下都仍是完整的自含块（小标题 + 调色板）', (language) => {
    for (const shelf of [true, false]) {
      const out = renderVisualGuide(language, { skillShelf: shelf })
      expect(out.startsWith('#'), `skillShelf=${shelf}`).toBe(true)
      expect(out, `skillShelf=${shelf}`).toBe(out.trim())
      // 拆坏 `.replace` 很容易把整块截断；调色板在片段尾部，它还在就说明没被腰斩
      expect(out, `skillShelf=${shelf}`).toContain('--viz-1')
      expect(out.length, `skillShelf=${shelf}`).toBeGreaterThan(200)
    }
  })
})

describe('{{shuvix:visualGuide}} 的归属', () => {
  it('恰好 work / chat / coding / bot 四个档案引用它', () => {
    // 加一个引用点 = 必须回来改这条，顺带交代理由。四个之外的档案引用它通常是复制粘贴
    // 带出来的（例如从 work 抄一段到 titler），而那一段提示对那个 agent 毫无意义。
    expect(profilesUsingVisualGuide()).toEqual(['bot', 'chat', 'coding', 'work'])
  })

  it('三种语言的引用集一致（翻译时漏改占位符 = 那个语言下变量失效）', () => {
    for (const name of profilesUsingVisualGuide()) {
      for (const language of LANGUAGES) {
        const profile = buildBuiltinProfiles({ language }).find((p) => p.name === name)!
        expect(placeholdersOf(profile.systemPrompt), `${name}.${language}`).toContain('visualGuide')
      }
    }
  })

  it.each(['notebook', 'titler', 'knowledge-writer', 'explore', 'browser', 'visualization'])(
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
        const profile = buildBuiltinProfiles({ language, widgetsRoot: '/w/widgets' }).find(
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
