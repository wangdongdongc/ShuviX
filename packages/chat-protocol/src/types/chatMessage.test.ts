import { describe, it, expect } from 'vitest'
import { toolResultImage, type ToolResultDetails, type ToolResultImage } from './chatMessage'

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
