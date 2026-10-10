/**
 * ensureObjectId —— ShuviX 新建的 agent / bot / hook / policy 文件「一出生就带 `shuvix-id`」
 * （设计 docs/md-metadata-design.md）。
 *
 * uuid 换成可数的桩（v7 恒回 U）：「原样返回时根本没去造 id」与「造出来的就是写进去的那个」都靠它看。
 * 解析器用真的（agent 的那一个），只有 EO-6 / EO-7b 用桩去造「解析器怎么答」的场合。
 *
 *   EO-1  已有合法 UUID（含大写写法）→ 原样（不归一、不替换），不造 id
 *   EO-2  已有内置 id —— 哪怕是别类的 → 原样
 *   EO-3  没有 id → 等于 setShuvixIdLine(text, 新 id)
 *   EO-4  写坏的 id → 原位换成新的
 *   EO-5  CRLF 文件 → 新行也是 CRLF
 *   EO-6  没有 frontmatter（桩解析器答 {}）→ 原样、不抛
 *   EO-7  插不进去（整块 flow 风格的 frontmatter）/ 插完复核不过 → 原样
 *   EO-8  id 的值带锚点、别处引用了它：换掉之后整份解析失败 → 原样（已知不支持，退回原文）
 *   EO-9  原文本来就解析不过 → 原样、不抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAgentDefinitionFile } from '@shuvix/agent-runtime'
import { setShuvixIdLine } from '@shuvix/chat-protocol/mdMeta'

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

const mocks = vi.hoisted(() => ({ v7: vi.fn() }))
vi.mock('uuid', () => ({ v7: mocks.v7 }))

import { ensureObjectId } from '../mdObjectId'

const parseAgent = (text: string): { objectId?: string } | null =>
  parseAgentDefinitionFile(text, 'agent')

/** 最小 agent 文件；idLine 插在标记之后（省略 = 不写 id） */
const agentMd = (idLine?: string): string =>
  [
    '---',
    'shuvix: agent v1',
    ...(idLine === undefined ? [] : [idLine]),
    'name: a1',
    'description: d',
    '---',
    '',
    'Body.',
    ''
  ].join('\n')

beforeEach(() => {
  mocks.v7.mockReset().mockReturnValue(U)
})

describe('ensureObjectId', () => {
  it('EO-1 已有合法 UUID（含大写写法）→ 原样返回（不归一为小写），不造 id', () => {
    for (const id of ['0199d3a2-0000-7000-8000-000000000000', U.toUpperCase()]) {
      const text = agentMd(`shuvix-id: ${id}`)
      expect(ensureObjectId(text, parseAgent), id).toBe(text)
    }
    expect(mocks.v7).not.toHaveBeenCalled()
  })

  it('EO-2 已有内置 id —— 本类或别类 → 原样返回，不造 id', () => {
    for (const id of ['agent:builtin:explore', 'hook:builtin:auto-title']) {
      const text = agentMd(`shuvix-id: ${id}`)
      expect(ensureObjectId(text, parseAgent), id).toBe(text)
    }
    expect(mocks.v7).not.toHaveBeenCalled()
  })

  it('EO-3 没有 id → 等于 setShuvixIdLine(text, 新 id)：标记之后多一行，其余逐字节不变', () => {
    const text = agentMd()
    const out = ensureObjectId(text, parseAgent)
    expect(out).toBe(setShuvixIdLine(text, U))
    expect(out).toBe(agentMd(`shuvix-id: ${U}`))
    expect(mocks.v7).toHaveBeenCalledTimes(1)
    expect(parseAgent(out)?.objectId).toBe(U)
  })

  it.each(['shuvix-id: nope', "shuvix-id: ''", 'shuvix-id:', 'shuvix-id: 123'])(
    'EO-4 写坏的 `%s` → 原位换成新 id（不多出第二行）',
    (line) => {
      const out = ensureObjectId(agentMd(line), parseAgent)
      expect(out).toBe(agentMd(`shuvix-id: ${U}`))
      expect(out.match(/^shuvix-id:/gm)).toHaveLength(1)
    }
  )

  it('EO-5 CRLF 文件 → 新行以 \\r\\n 结尾，没有落单的 \\n', () => {
    const text = agentMd().replace(/\n/g, '\r\n')
    const out = ensureObjectId(text, parseAgent)
    expect(out).toBe(agentMd(`shuvix-id: ${U}`).replace(/\n/g, '\r\n'))
    expect(/(?<!\r)\n/.test(out)).toBe(false)
  })

  it('EO-6 没有 frontmatter（桩解析器答 {}）→ 原样、不抛', () => {
    const text = 'just a plain markdown body'
    expect(() => ensureObjectId(text, () => ({}))).not.toThrow()
    expect(ensureObjectId(text, () => ({}))).toBe(text)
  })

  it('EO-7 整块 flow 风格的 frontmatter（真解析器认它）：插不进去 → 原样', () => {
    const text = '---\n{shuvix: agent v1, name: flowy, description: d}\n---\n\nBody.\n'
    expect(parseAgent(text)).not.toBeNull()
    expect(ensureObjectId(text, parseAgent)).toBe(text)
  })

  it('EO-7b 插完之后复核不过（桩解析器拒绝带 id 的文本）→ 原样', () => {
    const text = agentMd()
    const strict = (t: string): { objectId?: string } | null =>
      t.includes('shuvix-id') ? null : {}
    expect(ensureObjectId(text, strict)).toBe(text)
    expect(mocks.v7).toHaveBeenCalledTimes(1)
  })

  it('EO-8 id 的值带锚点、别处又引用了它：换掉会让整份解析失败 → 原样返回（已知不支持）', () => {
    const text = [
      '---',
      'shuvix: agent v1',
      'shuvix-id: &a nope',
      'name: a1',
      'description: *a',
      '---',
      '',
      'Body.',
      ''
    ].join('\n')
    expect(parseAgent(text)).not.toBeNull()
    expect(parseAgent(text)?.objectId).toBeUndefined()
    expect(ensureObjectId(text, parseAgent)).toBe(text)
  })

  it('EO-9 原文本来就解析不过 → 原样、不抛', () => {
    const text = agentMd().replace('description: d', 'shuvix-tools: [read]')
    expect(parseAgent(text)).toBeNull()
    expect(() => ensureObjectId(text, parseAgent)).not.toThrow()
    expect(ensureObjectId(text, parseAgent)).toBe(text)
  })
})
