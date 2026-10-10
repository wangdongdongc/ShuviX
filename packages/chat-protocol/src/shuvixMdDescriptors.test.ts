/**
 * 描述符 ↔ 契约/文案 的互钉。
 *
 * 描述符是纯静态数据，最容易坏的方式是「悄悄漂移」：契约改键名而描述符没跟上
 * （字段落回通用行），或 labelKey 打错（行标签显示成 i18n 键名）。两者都不会有
 * 类型错误，故在此各钉一条。
 */
import { describe, it, expect } from 'vitest'
import { AGENT_THINKING_KEY, SHUVIX_MD_DESCRIPTORS, descriptorForType } from './shuvixMdDescriptors'
import { OKF_STATUS_KEY, OKF_TYPE_KEY } from './knowledge'
import { SHUVIX_ID_KEY } from './mdMeta'
import en from './i18n/locales/en.json'
import ja from './i18n/locales/ja.json'
import zh from './i18n/locales/zh.json'

describe('okf 描述符 ↔ 知识库契约', () => {
  const byKey = (): Record<string, string> => {
    const d = descriptorForType('okf')!
    expect(d).toBeTruthy()
    return Object.fromEntries(d.fields.map((f) => [f.key, f.kind]))
  }

  it('人写的一半可编辑：两个开放枚举走下拉（键名引契约常量），标量各就各位', () => {
    const k = byKey()
    expect(k[OKF_TYPE_KEY]).toBe('select')
    expect(k[OKF_STATUS_KEY]).toBe('select')
    // description 是**一行**召回条件（设计 D6，索引里显示的就是它）——
    // 给 prose 会排成段落，诱人把它写成摘要
    expect(k['description']).toBe('text')
    expect(k['title']).toBe('text')
    expect(k['tags']).toBe('csv')
    expect(k['stale_after']).toBe('mono')
  })

  /**
   * 机器写的一半恒只读 —— 这不是排版偏好而是设计 P4：`generated` 由写钩子盖、`verified`
   * 只由 UI 的核实动作盖。卡上但凡给个输入框，用户（和读得到这张卡的 agent）就能自称已核实。
   */
  it('机器写的一半不可编辑：sources / generated / verified 都不是可编辑 kind', () => {
    const k = byKey()
    const EDITABLE = ['text', 'mono', 'boolean', 'csv', 'select']
    expect(k['sources']).toBe('sources')
    expect(k['generated']).toBe('stamp')
    expect(k['verified']).toBe('stamp')
    for (const key of ['sources', 'generated', 'verified']) {
      expect(EDITABLE, `${key} 变成了可编辑字段`).not.toContain(k[key])
    }
  })

  /** 自述行由徽章渲染，不该再占一行；未列出的键落通用行（OKF 允许未知键） */
  it('shuvix 自述行不在字段表里', () => {
    expect(byKey()['shuvix']).toBeUndefined()
  })
})

describe('skill 描述符 ↔ SKILL.md 的两个键', () => {
  it('SMD-1 只有 name / description 两行：name 走等宽、description 走单行文本', () => {
    // SKILL.md 与 Claude Code 的 skills 通用，frontmatter 只有这两个键、**没有 `shuvix:` 自述行**——
    // 这张卡不靠标记选中，而是由技能笔记本传 `frontmatterFallbackType: 'skill'` 兜底。多列一个键
    // 就是在卡上凭空造一个 ShuviX 私有字段；少列一个，那一行落回通用 key/value 行。
    // description 是**触发条件**（agent 靠它判断该不该加载这个技能），不是摘要，所以是单行 text：
    // 给 prose 会排成段落，诱人把它写成介绍
    const d = descriptorForType('skill')
    expect(d).toBeTruthy()
    expect(d!.fields.map((f) => [f.key, f.kind])).toEqual([
      ['name', 'mono'],
      ['description', 'text']
    ])
  })
})

describe('agent 描述符 ↔ shuvix-thinking', () => {
  it('SMD-3 思考档位那一行：键名就是解析器读的 shuvix-thinking，走下拉（select），标签复用「思考」文案', () => {
    // 属性卡按这个常量把槽位分派给档位下拉（FrontmatterFieldPicker）—— 常量与解析器的键名一旦
    // 不一致，卡上就是一行解析器根本不读的字段；kind 不是 select，就拿不到那几档候选
    expect(AGENT_THINKING_KEY).toBe('shuvix-thinking')
    const row = descriptorForType('agent')?.fields.find((f) => f.key === AGENT_THINKING_KEY)
    expect(row).toBeDefined()
    expect(row!.kind).toBe('select')
    expect(row!.labelKey).toBe('tool.subAgentThinking')
  })
})

describe('描述符表本身', () => {
  it('SMD-2 type 两两不重复（descriptorForType 取首个命中，撞名的那张永远选不中）', () => {
    const types = SHUVIX_MD_DESCRIPTORS.map((d) => d.type)
    expect(new Set(types).size).toBe(types.length)
    // 顺带钉住「查得到」：每个 type 都能经 descriptorForType 回到自己那张
    for (const d of SHUVIX_MD_DESCRIPTORS) expect(descriptorForType(d.type)).toBe(d)
  })
})

describe('全部描述符的 labelKey 均存在于 en 文案', () => {
  it('labelKey 逐段可解析（打错的键会把行标签显示成键名本身）', () => {
    for (const d of SHUVIX_MD_DESCRIPTORS) {
      for (const f of d.fields) {
        let node: unknown = en
        for (const seg of f.labelKey.split('.')) {
          node = (node as Record<string, unknown> | undefined)?.[seg]
        }
        expect(typeof node, `${d.type} ${f.key} → ${f.labelKey}`).toBe('string')
      }
    }
  })
})

/**
 * 对象 id 行（`shuvix-id`，md 扩展元数据只认它，见 mdMeta.ts）：能挂元数据的四类文件都列着它、
 * 且恒为 hidden —— 列进描述符只为不落通用行（一串 UUID 摆在卡上只是噪音，也不该被当普通字段随手改）。
 * 不挂元数据的那几类（知识库条目、SKILL.md、记忆）不列它：列了就是在卡上凭空认领一个它们没有的键。
 */
describe('对象 id 行（shuvix-id）', () => {
  const lookup = (tree: unknown, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>((node, seg) => (node as Record<string, unknown> | undefined)?.[seg], tree)

  it.each(['agent', 'bot', 'hook', 'policy'])(
    'SMD-ID1 %s：恰一个 shuvix-id 字段，kind hidden，标签 notebook.frontmatter.objectId 三语都有',
    (type) => {
      const fields = descriptorForType(type)!.fields.filter((f) => f.key === SHUVIX_ID_KEY)
      expect(fields).toHaveLength(1)
      expect(fields[0].kind).toBe('hidden')
      expect(fields[0].labelKey).toBe('notebook.frontmatter.objectId')
      for (const [lang, tree] of [
        ['en', en],
        ['zh', zh],
        ['ja', ja]
      ] as const) {
        const label = lookup(tree, fields[0].labelKey)
        expect(typeof label, lang).toBe('string')
        expect((label as string).trim(), lang).not.toBe('')
      }
    }
  )

  it.each(['okf', 'skill', 'memory'])('SMD-ID2 %s 不列 shuvix-id', (type) => {
    const d = descriptorForType(type)
    expect(d, type).toBeTruthy()
    expect(d!.fields.map((f) => f.key)).not.toContain('shuvix-id')
  })
})
