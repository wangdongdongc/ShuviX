/**
 * Wiki 契约的判别与取值。重点钉两件事：
 *   - 判别只认文件开头的 frontmatter 标记（正文里的 `---` 分隔线不误判）；
 *   - 取值只认规范形态，非规范一律 null —— 调用方据此降级为原文显示，永不空屏。
 */
import { describe, it, expect } from 'vitest'
import {
  isWikiEntryFile,
  isWikiTopicFile,
  parseWikiEntryHead,
  WIKI_ENTRY_BANNER,
  WIKI_ENTRY_MARKER,
  WIKI_TOPIC_MARKER
} from './wikiFileContract'

/** 按契约拼一份合法条目：frontmatter 是条目本身，其下是用户笔记 */
const entry = (fields: string, notes = '# 我的笔记\n\n随手记的东西。\n'): string =>
  `---\nshuvix: ${WIKI_ENTRY_MARKER}\n${fields}\n---\n\n${notes}`

const CONTENT_BLOCK = [
  'shuvix-wiki-content: |-',
  '  会话令牌校验统一走 validateToken，对时钟偏移留 30s 容忍窗口。',
  '  刷新令牌另走 refreshToken 分支，见 [[refresh-token-flow]]。'
].join('\n')

describe('判别', () => {
  it('识别条目与章程标记，两者互不误判', () => {
    const e = entry(`name: 会话令牌校验\n${CONTENT_BLOCK}`)
    expect(isWikiEntryFile(e)).toBe(true)
    expect(isWikiTopicFile(e)).toBe(false)

    const topic = `---\nshuvix: ${WIKI_TOPIC_MARKER}\nname: acme-auth\n---\n\n# 章程\n`
    expect(isWikiTopicFile(topic)).toBe(true)
    expect(isWikiEntryFile(topic)).toBe(false)
  })

  it('标记不必是 frontmatter 首行，且容忍引号与版本号缺省', () => {
    expect(isWikiEntryFile(`---\nname: x\nshuvix: 'wiki-entry'\n---\n\n正文\n`)).toBe(true)
  })

  it('普通 markdown 与正文里的伪标记不误判', () => {
    expect(isWikiEntryFile('# 只是笔记\n\n没有 frontmatter。\n')).toBe(false)
    // frontmatter 只认文件开头：正文中的 `---` 分隔线后跟标记行不算
    expect(isWikiEntryFile(`# 标题\n\n---\nshuvix: ${WIKI_ENTRY_MARKER}\n---\n`)).toBe(false)
    // agent / chart 契约文件不会被认成 wiki 条目
    expect(isWikiEntryFile('---\nshuvix: agent v1\nname: wiki\n---\n\n正文\n')).toBe(false)
    expect(isWikiEntryFile('---\nshuvix: chart v1\n---\n\n```mermaid\nflowchart TD\n```\n')).toBe(
      false
    )
  })

  it('容忍 BOM、前导空白与 CRLF', () => {
    const e = entry(`name: x\n${CONTENT_BLOCK}`).replace(/\n/g, '\r\n')
    expect(isWikiEntryFile(`\uFEFF\n${e}`)).toBe(true)
  })
})

describe('parseWikiEntryHead —— name', () => {
  it('取顶层 name，剥引号', () => {
    expect(parseWikiEntryHead(entry("name: '2026 路线图'"))?.name).toBe('2026 路线图')
    expect(parseWikiEntryHead(entry('name: 会话令牌校验'))?.name).toBe('会话令牌校验')
  })

  it('缺省或空值 → null（调用方回退文件名 stem）', () => {
    expect(parseWikiEntryHead(entry('shuvix-wiki-status: draft'))?.name).toBeNull()
    expect(parseWikiEntryHead(entry('name:'))?.name).toBeNull()
  })

  it('条目正文里的缩进 name: 行不会被误取', () => {
    const e = entry(
      ['shuvix-wiki-content: |-', '  name: 这是正文里的一行', '  第二行。'].join('\n')
    )
    expect(parseWikiEntryHead(e)?.name).toBeNull()
  })

  it('非条目文件 → null', () => {
    expect(parseWikiEntryHead('# 普通笔记\n')).toBeNull()
    expect(parseWikiEntryHead(`---\nshuvix: ${WIKI_TOPIC_MARKER}\nname: t\n---\n`)).toBeNull()
  })
})

describe('parseWikiEntryHead —— 条目正文', () => {
  it('`|-` 块：去缩进、保留换行、丢弃尾部空行', () => {
    const e = entry(`name: x\n${CONTENT_BLOCK}\nshuvix-wiki-status: draft`)
    expect(parseWikiEntryHead(e)?.content).toBe(
      '会话令牌校验统一走 validateToken，对时钟偏移留 30s 容忍窗口。\n' +
        '刷新令牌另走 refreshToken 分支，见 [[refresh-token-flow]]。'
    )
  })

  it('块在末位时不吞掉 frontmatter 之下的用户笔记', () => {
    const e = entry(`name: x\n${CONTENT_BLOCK}`, '# 我的笔记\n\n用户随手写的。\n')
    expect(parseWikiEntryHead(e)?.content).not.toContain('用户随手写的')
  })

  it('`>` 折叠块：行内以空格相接，空行还原为换行', () => {
    const e = entry(['shuvix-wiki-content: >-', '  第一行', '  第二行', '', '  另一段'].join('\n'))
    expect(parseWikiEntryHead(e)?.content).toBe('第一行 第二行\n另一段')
  })

  it('单行纯标量与带引号标量', () => {
    expect(parseWikiEntryHead(entry('shuvix-wiki-content: 一句话就够了。'))?.content).toBe(
      '一句话就够了。'
    )
    expect(parseWikiEntryHead(entry("shuvix-wiki-content: '带引号'"))?.content).toBe('带引号')
  })

  it('字段缺失或块为空 → null（调用方降级显示原文）', () => {
    expect(parseWikiEntryHead(entry('name: x'))?.content).toBeNull()
    expect(
      parseWikiEntryHead(entry('shuvix-wiki-content: |-\nshuvix-wiki-status: draft'))?.content
    ).toBeNull()
  })

  it('CRLF 文件的块标量不残留 \\r', () => {
    const e = entry(`name: x\n${CONTENT_BLOCK}`).replace(/\n/g, '\r\n')
    expect(parseWikiEntryHead(e)?.content).not.toContain('\r')
  })
})

describe('横幅常量', () => {
  it('条目横幅同时声明两侧所有权 —— 这是格式的核心约定，措辞不可退化', () => {
    expect(WIKI_ENTRY_BANNER).toContain('This frontmatter is the entry itself')
    expect(WIKI_ENTRY_BANNER).toContain('never edits them')
  })

  it('横幅作为 description 值时不破坏判别与取值', () => {
    const e = entry(`name: x\ndescription: ${WIKI_ENTRY_BANNER}\n${CONTENT_BLOCK}`)
    expect(isWikiEntryFile(e)).toBe(true)
    expect(parseWikiEntryHead(e)?.name).toBe('x')
    expect(parseWikiEntryHead(e)?.content).toContain('validateToken')
  })
})
