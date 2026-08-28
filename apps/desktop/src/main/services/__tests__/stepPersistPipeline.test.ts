/**
 * 工具结果广播瘦身管线 —— 只瘦 content，不动 details。
 *
 * 内置 transformer 是模块加载时注册的，故**不要**调 `_clearStepPersistTransformersForTest()`：
 * 那会把被测对象本身清掉，断言随即变成空转。
 */
import { describe, it, expect } from 'vitest'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { ReadToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { transformToolResultForPersist } from '../stepPersistPipeline'

/** 一段够长、够特征的假 base64 —— 断言「它没出现在输出里」 */
const BASE64 = 'iVBORw0KGgoAAAANSUhEUg' + 'QUJDRUZH'.repeat(200)

const readImageDetails: ReadToolDetails = {
  type: 'read',
  truncated: true,
  format: 'JPEG',
  fileSize: 320_000,
  image: {
    path: '/data/tool_results/sid/read-image-1.jpg',
    width: 1600,
    height: 800,
    bytes: 320_000
  }
}

const ctxOf = (
  content: Array<TextContent | ImageContent>,
  details?: ReadToolDetails
): Parameters<typeof transformToolResultForPersist>[0] => ({
  toolName: 'read',
  toolCallId: 'call_1',
  sessionId: 'sid',
  isError: false,
  content,
  details
})

describe('transformToolResultForPersist', () => {
  it('图片块换成占位文本，base64 不进输出', () => {
    const out = transformToolResultForPersist(
      ctxOf(
        [
          { type: 'image', data: BASE64, mimeType: 'image/jpeg' },
          { type: 'text', text: 'Image: shot.png\nAuto-compressed …' }
        ],
        readImageDetails
      )
    )
    expect(out.content).not.toContain(BASE64)
    expect(out.content).not.toContain(BASE64.slice(0, 200))
    expect(out.content).toContain('image/jpeg')
    // 原有的文字块一字不少
    expect(out.content).toContain('Image: shot.png')
    expect(out.content).toContain('Auto-compressed')
  })

  it('details.image 原样保留 —— 瘦身只瘦 content，别顺手把路径洗掉', () => {
    const out = transformToolResultForPersist(
      ctxOf([{ type: 'image', data: BASE64, mimeType: 'image/jpeg' }], readImageDetails)
    )
    expect(out.details).toBe(readImageDetails)
    expect((out.details as ReadToolDetails).image).toEqual(readImageDetails.image)
  })

  it('没有图片块时原样透传', () => {
    const details: ReadToolDetails = { type: 'read', truncated: false, totalLines: 3 }
    const out = transformToolResultForPersist(
      ctxOf([{ type: 'text', text: 'plain text result' }], details)
    )
    expect(out.content).toBe('plain text result')
    expect(out.details).toBe(details)
  })
})
