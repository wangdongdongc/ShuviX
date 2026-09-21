/**
 * 扩展端「LLM 工具」设置页展示的内置工具定义（getBuiltinToolDefinitions）—— 浏览器已不在这里：
 * 它是一台内置 MCP 能力服务器，出现在 MCP 设置的内置行里。这里恰好剩 ask / read / write / edit。
 *
 * `./fileTools` 只取三句描述常量（真件的 import 图带 FSA / OPFS / chrome.*），其余用真件。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../fileTools', () => ({
  READ_DESCRIPTION: 'read description',
  WRITE_DESCRIPTION: 'write description',
  EDIT_DESCRIPTION: 'edit description'
}))

import { getBuiltinToolDefinitions } from '../toolDefinitions'

describe('getBuiltinToolDefinitions', () => {
  it('TD-1 恰为 ask / read / write / edit（按这个顺序），没有 browser，也没有 browser 分组', () => {
    const defs = getBuiltinToolDefinitions()
    expect(defs.map((d) => d.name)).toEqual(['ask', 'read', 'write', 'edit'])
    expect(defs.map((d) => d.group)).toEqual(['general', 'general', 'general', 'general'])
    // 每条都带着发给模型的那份描述与参数 schema
    for (const d of defs) {
      expect(d.description.length, d.name).toBeGreaterThan(0)
      expect(d.parameters, d.name).toBeTypeOf('object')
    }
    expect(defs.find((d) => d.name === 'read')?.description).toBe('read description')
  })
})
