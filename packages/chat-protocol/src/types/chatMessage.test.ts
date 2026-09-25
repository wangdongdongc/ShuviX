import { describe, it, expect } from 'vitest'
import {
  isBackgroundCall,
  isShellCommandDetails,
  toolResultImage,
  type ToolResultDetails,
  type ToolResultImage
} from './chatMessage'

const IMAGE: ToolResultImage = { path: '/tmp/shot.jpg', width: 800, height: 600, bytes: 4096 }

/**
 * 「模型收到的那张图」的判别 —— UI 各处都经这一个函数取图，别再各自
 * `details.type === 'read' && details.image`（以后别的工具也交图时只改这里）。
 */
describe('toolResultImage', () => {
  it('read 详情带 image：原样返回该对象', () => {
    const details: ToolResultDetails = { type: 'read', truncated: false, image: IMAGE }
    expect(toolResultImage(details)).toBe(IMAGE)
  })

  it('read 详情没读到图：undefined', () => {
    expect(toolResultImage({ type: 'read', truncated: false, totalLines: 12 })).toBeUndefined()
  })

  it('别的工具即使硬塞 image 字段也不认', () => {
    // 三条各自代表一类：命令 / 文件改动 / 远端 —— 都不在判别列表里
    const bash = { type: 'bash', exitCode: 0, truncated: false, image: IMAGE }
    const edit = { type: 'edit', diff: '@@', image: IMAGE }
    const ssh = { type: 'ssh', action: 'exec', image: IMAGE }
    for (const details of [bash, edit, ssh]) {
      expect(toolResultImage(details as ToolResultDetails)).toBeUndefined()
    }
  })

  it('没有 details：undefined', () => {
    expect(toolResultImage(undefined)).toBeUndefined()
  })
})

/**
 * 本地命令工具有两个 —— `bash`（macOS / Linux）与 `powershell`（Windows），details 同形、`type` 就是
 * 工具名。UI 判「是不是本地命令」「是不是后台形态」都经这两个函数，别再各自只比 'bash'。
 */
describe('isShellCommandDetails / isBackgroundCall —— 两个命令工具同一种判别', () => {
  const shell = (type: 'bash' | 'powershell', extra: object = {}): ToolResultDetails =>
    ({ type, exitCode: 0, truncated: false, cwd: '/w', ...extra }) as ToolResultDetails

  it('F1 — isShellCommandDetails：bash 与 powershell 为真；ssh / session / mcp / 没有 details 为假', () => {
    expect(isShellCommandDetails(shell('bash'))).toBe(true)
    expect(isShellCommandDetails(shell('powershell'))).toBe(true)
    const others = [
      { type: 'ssh', action: 'exec', exitCode: 0 },
      { type: 'session', background: true },
      { type: 'mcp', server: 'ssh', tool: 'exec' }
    ]
    for (const details of others) {
      expect(isShellCommandDetails(details as ToolResultDetails), details.type).toBe(false)
    }
    expect(isShellCommandDetails(undefined)).toBe(false)
  })

  it('F1 — isBackgroundCall：powershell 带 background 为真、不带为假；bash 与 session 维持原判', () => {
    expect(isBackgroundCall(shell('powershell', { background: true }))).toBe(true)
    expect(isBackgroundCall(shell('powershell'))).toBe(false)
    expect(isBackgroundCall(shell('powershell', { background: false }))).toBe(false)

    expect(isBackgroundCall(shell('bash', { background: true }))).toBe(true)
    expect(isBackgroundCall(shell('bash'))).toBe(false)
    expect(isBackgroundCall({ type: 'session', background: true } as ToolResultDetails)).toBe(true)
    expect(isBackgroundCall({ type: 'session' } as ToolResultDetails)).toBe(false)

    // 别的工具硬塞 background 也不算（后台形态只有这两个来源）
    expect(
      isBackgroundCall({ type: 'ssh', background: true } as unknown as ToolResultDetails)
    ).toBe(false)
    expect(isBackgroundCall(undefined)).toBe(false)
  })
})
