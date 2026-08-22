import { describe, it, expect } from 'vitest'
import {
  SHUVIX_MARKER_KEY,
  frontmatterOf,
  readShuvixMarker,
  detectShuvixMarker
} from './shuvixMdContract'
import { CHART_FILE_MARKER_KEY, CHART_FILE_MARKER } from './chartFileContract'
import { WIKI_FILE_MARKER_KEY, WIKI_ENTRY_MARKER, WIKI_TOPIC_MARKER } from './wikiFileContract'

/** 按最小结构拼一个带 frontmatter 的 markdown 文件 */
function fmFile(yaml: string): string {
  return `---\n${yaml}\n---\n`
}

describe('frontmatterOf', () => {
  it('提取文件开头 frontmatter 的 YAML 原文（不含定界线、尾换行与正文）', () => {
    expect(frontmatterOf('---\na: 1\nshuvix: chart v1\n---\nbody\n')).toBe('a: 1\nshuvix: chart v1')
  })

  it('正文中段的 --- 块不误认（frontmatter 只认文件开头）', () => {
    expect(frontmatterOf('# doc\n\n---\nshuvix: chart v1\n---\n')).toBeNull()
  })

  it('拒绝空 frontmatter（--- 紧跟 ---）', () => {
    // 与 agent-runtime 侧 markdownFrontmatter.ts 的 splitFrontmatter 刻意分歧：
    // 那侧空 frontmatter 合法（全字段走缺省），契约判别侧拒绝 —— 两侧语义各自钉住。
    expect(frontmatterOf('---\n---\n')).toBeNull()
    expect(frontmatterOf('---\n---')).toBeNull()
  })

  it('容忍 BOM / 前导空白 / 两者叠加（剥离后按文件开头识别）', () => {
    const yaml = 'shuvix: agent v1'
    expect(frontmatterOf('﻿---\nshuvix: agent v1\n---\n')).toBe(yaml)
    expect(frontmatterOf('\n  ---\nshuvix: agent v1\n---\n')).toBe(yaml)
    expect(frontmatterOf('﻿\n---\nshuvix: agent v1\n---\n')).toBe(yaml)
  })

  it('容忍 CRLF', () => {
    expect(frontmatterOf('---\r\nshuvix: agent v1\r\n---\r\n')).toBe('shuvix: agent v1')
  })

  it('无闭合定界线或定界线非三连线 → null', () => {
    expect(frontmatterOf('---\nshuvix: agent v1\n')).toBeNull()
    expect(frontmatterOf('----\nshuvix: agent v1\n----\n')).toBeNull()
  })

  it('闭合定界线容忍 EOF 无尾换行与尾随空白', () => {
    expect(frontmatterOf('---\nshuvix: agent v1\n---')).toBe('shuvix: agent v1')
    expect(frontmatterOf('---\nshuvix: agent v1\n--- \t\n')).toBe('shuvix: agent v1')
  })

  it('空串与普通 markdown → null', () => {
    expect(frontmatterOf('')).toBeNull()
    expect(frontmatterOf('# hello\n\n普通 markdown 正文\n')).toBeNull()
  })
})

describe('readShuvixMarker', () => {
  it('解析标准标记行', () => {
    expect(readShuvixMarker('shuvix: agent v1')).toEqual({ type: 'agent', version: 1 })
  })

  it('容忍缩进 / 引号 / 冒号后无空格；版本缺省为 null', () => {
    expect(readShuvixMarker('  shuvix: chart v1')).toEqual({ type: 'chart', version: 1 })
    expect(readShuvixMarker('shuvix:chart v1')).toEqual({ type: 'chart', version: 1 })
    expect(readShuvixMarker("shuvix: 'wiki-entry v1'")).toEqual({ type: 'wiki-entry', version: 1 })
    expect(readShuvixMarker('shuvix: "chart v1"')).toEqual({ type: 'chart', version: 1 })
    expect(readShuvixMarker('shuvix: agent')).toEqual({ type: 'agent', version: null })
    expect(readShuvixMarker("shuvix: 'agent'")).toEqual({ type: 'agent', version: null })
  })

  it('多位版本号解析为数字', () => {
    const marker = readShuvixMarker('shuvix: agent v12')
    expect(marker).toEqual({ type: 'agent', version: 12 })
    expect(marker?.version).toBe(12)
  })

  it('标记不必是首行', () => {
    expect(readShuvixMarker('name: x\ndescription: d\nshuvix: wiki-topic v1')).toEqual({
      type: 'wiki-topic',
      version: 1
    })
  })

  it('多个 shuvix 键以首行为准', () => {
    expect(readShuvixMarker('shuvix: chart v1\nshuvix: agent v2')).toEqual({
      type: 'chart',
      version: 1
    })
  })

  it('带连字符的类型完整捕获', () => {
    expect(readShuvixMarker('shuvix: wiki-entry v1')).toEqual({ type: 'wiki-entry', version: 1 })
  })

  it('完整 token 捕获：charter 不截成 chart（消费方全等比较不误认）', () => {
    expect(readShuvixMarker('shuvix: charter v1')).toEqual({ type: 'charter', version: 1 })
  })

  it('键的词法边界：shuvix- 前缀键与 xshuvix 不误认', () => {
    expect(readShuvixMarker('shuvix-tools: bash, read')).toBeNull()
    expect(readShuvixMarker('xshuvix: agent v1')).toBeNull()
    expect(readShuvixMarker('shuvix-instruction-files: true\nshuvix: agent v1')).toEqual({
      type: 'agent',
      version: 1
    })
  })

  it('非法值 → null', () => {
    expect(readShuvixMarker('shuvix:')).toBeNull()
    expect(readShuvixMarker('shuvix:  ')).toBeNull()
    expect(readShuvixMarker("shuvix: ''")).toBeNull()
    expect(readShuvixMarker('shuvix: 1st v1')).toBeNull()
    expect(readShuvixMarker('')).toBeNull()
  })

  it('容忍冒号前空白', () => {
    expect(readShuvixMarker('shuvix : chart v1')).toEqual({ type: 'chart', version: 1 })
    expect(readShuvixMarker('shuvix\t: chart v1')).toEqual({ type: 'chart', version: 1 })
  })

  it('注释行不误认', () => {
    expect(readShuvixMarker('# shuvix: agent v1')).toBeNull()
  })
})

describe('detectShuvixMarker', () => {
  it('识别全部五种现役标记', () => {
    // 防漂移链：chart / wiki 用同包常量拼文件；agent / policy 用字面量 —— 叶子包不跨包
    // 引常量，agent-runtime 侧 definitionFile.test.ts / policyFile.test.ts 已钉住序列化
    // 写出的字面值（'shuvix: agent v1' / 'shuvix: policy v1'），本侧钉「该字面值可解析」。
    expect(detectShuvixMarker(fmFile(`${CHART_FILE_MARKER_KEY}: ${CHART_FILE_MARKER}`))).toEqual({
      type: 'chart',
      version: 1
    })
    expect(detectShuvixMarker(fmFile(`${WIKI_FILE_MARKER_KEY}: ${WIKI_ENTRY_MARKER}`))).toEqual({
      type: 'wiki-entry',
      version: 1
    })
    expect(detectShuvixMarker(fmFile(`${WIKI_FILE_MARKER_KEY}: ${WIKI_TOPIC_MARKER}`))).toEqual({
      type: 'wiki-topic',
      version: 1
    })
    expect(detectShuvixMarker(fmFile('shuvix: agent v1'))).toEqual({ type: 'agent', version: 1 })
    expect(detectShuvixMarker(fmFile('shuvix: policy v1'))).toEqual({ type: 'policy', version: 1 })
  })

  it('真实 agent md 全链路（含正文中的 --- 分隔线）', () => {
    const agentMd = [
      '---',
      'shuvix: agent v1',
      'name: explore',
      'description: 只读探索代理',
      'shuvix-tools: read, grep, glob',
      'shuvix-instruction-files: true',
      'shuvix-project-prompt: false',
      '---',
      '',
      '# 角色',
      '',
      '正文第一段。',
      '',
      '---',
      '',
      '正文分隔线之后的第二段。',
      ''
    ].join('\n')
    expect(detectShuvixMarker(agentMd)).toEqual({ type: 'agent', version: 1 })
  })

  it('非契约文件组合降级为 null', () => {
    expect(detectShuvixMarker('# doc\n\n普通 markdown\n')).toBeNull()
    expect(detectShuvixMarker('')).toBeNull()
    expect(detectShuvixMarker('---\ntitle: 笔记\n---\n')).toBeNull()
    expect(detectShuvixMarker('---\n---\n')).toBeNull()
    // '---\n\n---\n'：frontmatterOf 取出的是空行 YAML（''），标记读取为 null —— 只钉 detect 层
    expect(detectShuvixMarker('---\n\n---\n')).toBeNull()
  })

  it('各契约的 MARKER_KEY 常量同值', () => {
    expect(CHART_FILE_MARKER_KEY).toBe(SHUVIX_MARKER_KEY)
    expect(WIKI_FILE_MARKER_KEY).toBe(SHUVIX_MARKER_KEY)
  })
})
