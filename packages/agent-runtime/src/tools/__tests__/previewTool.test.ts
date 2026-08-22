/**
 * preview 工具共享内核单测 —— 全 stub 依赖（无 fs），验证「分类 → 结局」映射与
 * 图表渲染验证的分支语义（失败不发事件、超时降级注记、无验证器时静默放行）。
 */
import { describe, it, expect } from 'vitest'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'
import { CHART_FILE_MARKER_KEY, CHART_FILE_MARKER } from '@shuvix/chat-protocol/chartFileContract'
import { createPreviewTool, type ChartValidation, type PreviewToolDeps } from '../previewTool'

const CHART_FRONTMATTER = `---\n${CHART_FILE_MARKER_KEY}: ${CHART_FILE_MARKER}\n---\n`
const CHART_OK = `${CHART_FRONTMATTER}\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n`
const CHART_BROKEN_CONTRACT = `${CHART_FRONTMATTER}\n没有代码块\n`

function makeTool(opts: {
  read: FileReadResult
  validate?: (p: { absPath: string; mermaid: string }) => Promise<ChartValidation>
  /** 设置后 resolvePath 直接 throw（首次调用即 securityCheck 阶段） */
  resolveError?: string
}): { tool: ReturnType<typeof createPreviewTool>; emitted: string[]; calls: string[] } {
  const emitted: string[] = []
  const calls: string[] = []
  const deps: PreviewToolDeps = {
    port: {
      stat: async () => {
        calls.push('stat')
        return { isFile: true, isDirectory: false, size: 1, mtimeMs: 0 }
      }
    },
    resolvePath: (p) => {
      calls.push('resolvePath')
      if (opts.resolveError) throw new Error(opts.resolveError)
      return { statPath: p, absPath: `/ws/${p}` }
    },
    readPreview: async () => {
      calls.push('readPreview')
      return opts.read
    },
    validateChart: opts.validate,
    emitFilePreview: (absPath) => emitted.push(absPath),
    label: 'Preview',
    abortError: 'Aborted'
  }
  return { tool: createPreviewTool(deps), emitted, calls }
}

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('\n')
}

const text = (content: string): FileReadResult => ({
  kind: 'text',
  path: '/ws/f.md',
  content,
  size: content.length,
  lines: 1,
  ext: '.md'
})

describe('分类 → 结局映射', () => {
  it('binary → isError 且不发事件', async () => {
    const { tool, emitted } = makeTool({
      read: { kind: 'binary', path: '/ws/a.zip', size: 10, ext: '.zip' }
    })
    await expect(tool.execute('c', { path: 'a.zip' })).rejects.toThrow(/Preview not supported/)
    expect(emitted).toEqual([])
  })

  it('too-large → isError 带大小与上限', async () => {
    const { tool } = makeTool({
      read: { kind: 'too-large', path: '/ws/big.txt', size: 3 * 1024 * 1024, cap: 2 * 1024 * 1024 }
    })
    await expect(tool.execute('c', { path: 'big.txt' })).rejects.toThrow(/3\.0 MB.*2\.0 MB/)
  })

  it('error / not-allowed → isError 转述原因', async () => {
    const { tool: t1 } = makeTool({
      read: { kind: 'error', path: '/ws/x', message: 'boom' }
    })
    await expect(t1.execute('c', { path: 'x' })).rejects.toThrow(/boom/)
    const { tool: t2 } = makeTool({
      read: { kind: 'not-allowed', path: '/ws/x', reason: 'outside sandbox' }
    })
    await expect(t2.execute('c', { path: 'x' })).rejects.toThrow(/outside sandbox/)
  })

  it('hex → 成功但附原始字节视图注记', async () => {
    const { tool, emitted } = makeTool({
      read: {
        kind: 'hex',
        path: '/ws/a.bin',
        size: 8,
        ext: '.bin',
        data: new Uint8Array(8),
        bytesShown: 8,
        truncated: false
      }
    })
    const r = await tool.execute('c', { path: 'a.bin' })
    expect(textOf(r)).toMatch(/raw hex byte view/)
    expect(emitted).toHaveLength(1)
  })

  it('普通文本/markdown → 成功无注记', async () => {
    const { tool, emitted } = makeTool({ read: text('# hi') })
    const r = await tool.execute('c', { path: 'f.md' })
    expect(textOf(r)).toMatch(/Preview opened/)
    expect(textOf(r)).not.toMatch(/Chart/)
    expect(emitted).toHaveLength(1)
  })
})

describe('图表契约文件的渲染验证', () => {
  it('契约违例（有标记无块）→ isError 且不发事件', async () => {
    const { tool, emitted } = makeTool({ read: text(CHART_BROKEN_CONTRACT) })
    await expect(tool.execute('c', { path: 'g.md' })).rejects.toThrow(/violates the contract/)
    expect(emitted).toEqual([])
  })

  it('mermaid 渲染失败 → isError 带解析错误原文，不发事件', async () => {
    const { tool, emitted } = makeTool({
      read: text(CHART_OK),
      validate: async () => ({ ok: false, error: 'Parse error on line 2', verified: true })
    })
    await expect(tool.execute('c', { path: 'g.md' })).rejects.toThrow(/Parse error on line 2/)
    expect(emitted).toEqual([])
  })

  it('渲染成功 → 成功 + 已验证注记，发事件', async () => {
    const { tool, emitted } = makeTool({
      read: text(CHART_OK),
      validate: async ({ mermaid }) => {
        expect(mermaid).toContain('flowchart TD')
        return { ok: true, verified: true }
      }
    })
    const r = await tool.execute('c', { path: 'g.md' })
    expect(textOf(r)).toMatch(/Chart rendered successfully/)
    expect(emitted).toEqual(['/ws/g.md'])
  })

  it('超时降级（verified=false）→ 成功 + 未验证注记', async () => {
    const { tool } = makeTool({
      read: text(CHART_OK),
      validate: async () => ({ ok: true, verified: false })
    })
    const r = await tool.execute('c', { path: 'g.md' })
    expect(textOf(r)).toMatch(/could not be verified/)
  })

  it('未注入验证器 → 静默放行（无注记）', async () => {
    const { tool, emitted } = makeTool({ read: text(CHART_OK) })
    const r = await tool.execute('c', { path: 'g.md' })
    expect(textOf(r)).toMatch(/Preview opened/)
    expect(textOf(r)).not.toMatch(/verified|rendered/)
    expect(emitted).toHaveLength(1)
  })
})
