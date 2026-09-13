/**
 * 描述符 ↔ 契约/文案 的互钉。
 *
 * 描述符是纯静态数据，最容易坏的方式是「悄悄漂移」：契约改键名而描述符没跟上
 * （字段落回通用行），或 labelKey 打错（行标签显示成 i18n 键名）。两者都不会有
 * 类型错误，故在此各钉一条。
 */
import { describe, it, expect } from 'vitest'
import { SHUVIX_MD_DESCRIPTORS, descriptorForType } from './shuvixMdDescriptors'
import {
  WIKI_ALLOWED_TYPES_KEY,
  WIKI_CONTENT_KEY,
  WIKI_ENTRY_TYPE_KEY,
  WIKI_SOURCES_KEY,
  WIKI_STATUS_KEY,
  WIKI_UPDATED_KEY
} from './wikiFileContract'
import { OKF_STATUS_KEY, OKF_TYPE_KEY } from './knowledge'
import en from './i18n/locales/en.json'

describe('wiki 描述符 ↔ wikiFileContract 键集', () => {
  it('wiki-entry：契约的全部 wiki 字段各有一行，横幅 description 为 hidden', () => {
    const d = descriptorForType('wiki-entry')!
    expect(d).toBeTruthy()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f.kind]))
    expect(byKey[WIKI_CONTENT_KEY]).toBe('prose')
    expect(byKey[WIKI_SOURCES_KEY]).toBe('list')
    // 封闭枚举走下拉（picker 引契约常量做候选）；updated 由写后处理盖章，卡上只展示
    expect(byKey[WIKI_STATUS_KEY]).toBe('select')
    expect(byKey[WIKI_ENTRY_TYPE_KEY]).toBe('select')
    expect(byKey[WIKI_UPDATED_KEY]).toBeTruthy()
    // 横幅是机器面所有权声明 —— 卡片必须隐藏而非落通用行
    expect(byKey['description']).toBe('hidden')
  })

  it('wiki-topic：allowed-types 有行，横幅同样隐藏', () => {
    const d = descriptorForType('wiki-topic')!
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f.kind]))
    expect(byKey[WIKI_ALLOWED_TYPES_KEY]).toBeTruthy()
    expect(byKey['description']).toBe('hidden')
  })
})

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
