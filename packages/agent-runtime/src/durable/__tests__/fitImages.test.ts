/**
 * SessionHost / DurableSession 的 `fit-images` 图片适配接线：
 *
 *   F-01 注入 imageProcessor：工具返回图片自动适配，落库 ToolResultEntry 含适配后图片与 { severity: 'info', code: 'image' } 诊断
 *   F-02 坏图 / prepare 返回 undefined 或抛错：省略图片块（保留文本块）并附 image 诊断，下轮模型请求不携带坏图
 *   F-03 纯文本工具结果：prepare 零调用、无 image 诊断
 *   F-04 未注入 imageProcessor：图片原样落库、无 image 诊断
 *   F-05 与自动脱敏 hook 共存：同一工具结果同时完成文本脱敏与图片适配，互不覆盖
 *   F-06 派生 sub-agent 对话调用返回图片的工具：子对话 ToolResultEntry 同样受 fit-images 保护
 */
import { createHmac } from 'node:crypto'
import { obj } from '@earendil-works/pi-schema'
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  type Conversation,
  type ToolDiagnostic,
  type ToolRegistration,
  type TypedEntry
} from '@earendil-works/pi-durable'
import type { ImageProcessor, PreparedImage } from '@earendil-works/pi-durable/tools'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import type { RedactionHost } from '../sessionRedaction'
import { answer, callTool } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { callAgent, conversationIds, hostD, PROFILES } from './support/spawn'
import { allEntries, requestTexts } from './support/transcript'

registerHostCleanup()

const RAW_IMAGE_B64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3
]).toString('base64')
const FITTED_IMAGE_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]).toString('base64')
const SECRET_KEY = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'

const REDACTION_HOST: RedactionHost = {
  signer: { sign: (data) => createHmac('sha256', 'fit-images-test-key').update(data).digest() },
  vault: {
    seal: (v) => `SEALED:${Buffer.from(v).toString('base64')}`,
    open: (s) => {
      if (!s.startsWith('SEALED:')) throw new Error('cannot open')
      return Buffer.from(s.slice(7), 'base64').toString()
    }
  }
}

const FITTED_PREPARED: PreparedImage = {
  data: FITTED_IMAGE_B64,
  mimeType: 'image/jpeg',
  convertedFrom: 'image/png',
  resized: {
    from: { width: 4000, height: 3000 },
    to: { width: 2000, height: 1500 }
  }
}

const screenshotTool = (text = 'captured screenshot'): ToolRegistration =>
  defineTool({
    name: 'screenshot',
    description: 'returns a screenshot image',
    parameters: obj({}),
    execute: async () => ({
      output: [
        { type: 'text', text },
        { type: 'image', data: RAW_IMAGE_B64, mimeType: 'image/png' }
      ]
    })
  })

const textOnlyTool = (): ToolRegistration =>
  defineTool({
    name: 'echo_text',
    description: 'returns plain text',
    parameters: obj({}),
    execute: async () => ({
      output: [{ type: 'text', text: 'plain text output' }]
    })
  })

async function toolResultEntries(
  conversation: Conversation
): Promise<TypedEntry<{ diagnostics: ToolDiagnostic[] }>[]> {
  const entries = await allEntries(conversation)
  return entries.filter(ToolResultEntry.is)
}

describe('SessionHost / DurableSession · fit-images wiring', () => {
  it('F-01 injected imageProcessor fits tool images and attaches info/image diagnostic', async () => {
    const prepare = vi.fn<ImageProcessor['prepare']>(async () => FITTED_PREPARED)
    const t = await makeHost({
      ephemeral: ['f1'],
      tools: [screenshotTool()],
      imageProcessor: { prepare }
    })
    const session = await t.open('f1')
    t.kit.queue(callTool('screenshot'), answer('done'))

    expect(await session.submitUser('take a screenshot')).toEqual({})
    expect(prepare).toHaveBeenCalledTimes(1)

    const results = await toolResultEntries(await session.currentConversation())
    expect(results).toHaveLength(1)
    const entry = results[0]!
    expect(entry.data?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'info', code: 'image' })])
    )
    const modelMsg = entry.model?.[0]
    expect(modelMsg?.role).toBe('toolResult')
    if (modelMsg?.role === 'toolResult') {
      const images = modelMsg.content.filter((part) => part.type === 'image')
      expect(images).toEqual([{ type: 'image', data: FITTED_IMAGE_B64, mimeType: 'image/jpeg' }])
    }

    // 下一轮请求看到的也是适配后的图片
    const secondReqToolResult = t.kit.requests[1]!.messages.find((m) => m.role === 'toolResult')
    expect(secondReqToolResult?.role).toBe('toolResult')
    if (secondReqToolResult?.role === 'toolResult') {
      expect(secondReqToolResult.content.filter((p) => p.type === 'image')).toEqual([
        { type: 'image', data: FITTED_IMAGE_B64, mimeType: 'image/jpeg' }
      ])
    }
  })

  it('F-02 prepare returning undefined or throwing omits the bad image, keeps text, attaches image diagnostic, and keeps next request clean', async () => {
    // 情况 1：prepare 返回 undefined
    const tUndef = await makeHost({
      ephemeral: ['f2a'],
      tools: [screenshotTool('keep this text')],
      imageProcessor: { prepare: async () => undefined }
    })
    const sUndef = await tUndef.open('f2a')
    tUndef.kit.queue(callTool('screenshot'), answer('done'))
    expect(await sUndef.submitUser('take a screenshot')).toEqual({})

    const undefResults = await toolResultEntries(await sUndef.currentConversation())
    expect(undefResults).toHaveLength(1)
    expect(undefResults[0]!.data?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'info', code: 'image' })])
    )
    const undefMsg = undefResults[0]!.model?.[0]
    expect(undefMsg?.role).toBe('toolResult')
    if (undefMsg?.role === 'toolResult') {
      expect(undefMsg.content.filter((p) => p.type === 'image')).toEqual([])
      expect(
        undefMsg.content.some((p) => p.type === 'text' && p.text.includes('keep this text'))
      ).toBe(true)
    }
    const nextUndefToolMsg = tUndef.kit.requests[1]!.messages.find((m) => m.role === 'toolResult')
    if (nextUndefToolMsg?.role === 'toolResult') {
      expect(nextUndefToolMsg.content.filter((p) => p.type === 'image')).toEqual([])
    }

    // 情况 2：prepare 抛错
    const tThrow = await makeHost({
      ephemeral: ['f2b'],
      tools: [screenshotTool('still keep text')],
      imageProcessor: {
        prepare: async () => {
          throw new Error('corrupt png header')
        }
      }
    })
    const sThrow = await tThrow.open('f2b')
    tThrow.kit.queue(callTool('screenshot'), answer('done'))
    expect(await sThrow.submitUser('take a screenshot')).toEqual({})

    const throwResults = await toolResultEntries(await sThrow.currentConversation())
    expect(throwResults).toHaveLength(1)
    expect(throwResults[0]!.data?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'info',
          code: 'image',
          message: expect.stringContaining('corrupt png header')
        })
      ])
    )
    const throwMsg = throwResults[0]!.model?.[0]
    expect(throwMsg?.role).toBe('toolResult')
    if (throwMsg?.role === 'toolResult') {
      expect(throwMsg.content.filter((p) => p.type === 'image')).toEqual([])
      expect(
        throwMsg.content.some((p) => p.type === 'text' && p.text.includes('still keep text'))
      ).toBe(true)
    }
    const nextThrowToolMsg = tThrow.kit.requests[1]!.messages.find((m) => m.role === 'toolResult')
    if (nextThrowToolMsg?.role === 'toolResult') {
      expect(nextThrowToolMsg.content.filter((p) => p.type === 'image')).toEqual([])
    }
  })

  it('F-03 text-only tool result never invokes prepare and adds no image diagnostic', async () => {
    const prepare = vi.fn<ImageProcessor['prepare']>(async () => FITTED_PREPARED)
    const t = await makeHost({
      ephemeral: ['f3'],
      tools: [textOnlyTool()],
      imageProcessor: { prepare }
    })
    const session = await t.open('f3')
    t.kit.queue(callTool('echo_text'), answer('done'))

    expect(await session.submitUser('echo')).toEqual({})
    expect(prepare).not.toHaveBeenCalled()

    const results = await toolResultEntries(await session.currentConversation())
    expect(results).toHaveLength(1)
    expect(results[0]!.data?.diagnostics ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'image' })])
    )
  })

  it('F-04 without imageProcessor, images are stored verbatim with no image diagnostic', async () => {
    const t = await makeHost({
      ephemeral: ['f4'],
      tools: [screenshotTool()]
    })
    const session = await t.open('f4')
    t.kit.queue(callTool('screenshot'), answer('done'))

    expect(await session.submitUser('take a screenshot')).toEqual({})

    const results = await toolResultEntries(await session.currentConversation())
    expect(results).toHaveLength(1)
    expect(results[0]!.data?.diagnostics ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'image' })])
    )
    const modelMsg = results[0]!.model?.[0]
    expect(modelMsg?.role).toBe('toolResult')
    if (modelMsg?.role === 'toolResult') {
      expect(modelMsg.content.filter((p) => p.type === 'image')).toEqual([
        { type: 'image', data: RAW_IMAGE_B64, mimeType: 'image/png' }
      ])
    }
  })

  it('F-05 coexists with auto-redaction hook: same tool result is both text-redacted and image-fitted', async () => {
    const prepare = vi.fn<ImageProcessor['prepare']>(async () => FITTED_PREPARED)
    const t = await makeHost({
      ephemeral: ['f5'],
      tools: [screenshotTool(`OPENAI_API_KEY=${SECRET_KEY}`)],
      redaction: REDACTION_HOST,
      imageProcessor: { prepare }
    })
    const session = await t.open('f5')
    t.kit.queue(callTool('screenshot'), answer('done'))

    expect(await session.submitUser('capture with secret')).toEqual({})
    expect(prepare).toHaveBeenCalledTimes(1)

    const results = await toolResultEntries(await session.currentConversation())
    expect(results).toHaveLength(1)
    const entry = results[0]!
    expect(entry.data?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'info', code: 'image' })])
    )

    const modelMsg = entry.model?.[0]
    expect(modelMsg?.role).toBe('toolResult')
    if (modelMsg?.role === 'toolResult') {
      const text = modelMsg.content
        .filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n')
      expect(text).not.toContain(SECRET_KEY)
      expect(text).toMatch(/OPENAI_API_KEY=\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/)
      expect(modelMsg.content.filter((p) => p.type === 'image')).toEqual([
        { type: 'image', data: FITTED_IMAGE_B64, mimeType: 'image/jpeg' }
      ])
    }

    const nextSeen = requestTexts(t.kit, 1).join('\n')
    expect(nextSeen).not.toContain(SECRET_KEY)
    expect(nextSeen).toMatch(/OPENAI_API_KEY=\{\{REDACTED_API_KEY_[a-z2-7]{8}\}\}/)
  })

  it('F-06 spawned sub-agent conversation tool result is also protected by fit-images', async () => {
    const prepare = vi.fn<ImageProcessor['prepare']>(async () => FITTED_PREPARED)
    const d = await hostD({
      host: { imageProcessor: { prepare } },
      tools: () => [screenshotTool('child screenshot')],
      dispatch: {
        profiles: {
          ...PROFILES,
          explore: {
            ...PROFILES.explore,
            tools: ['screenshot']
          }
        }
      }
    })

    d.t.kit.queue(
      callAgent('explore', 'capture screenshot'),
      callTool('screenshot'),
      answer('captured'),
      answer('all done')
    )
    expect(await d.session.submitUser('delegate screenshot')).toEqual({})
    expect(prepare).toHaveBeenCalledTimes(1)

    const ids = await conversationIds(d.session)
    const childId = ids.find((id) => id !== ROOT_CONVERSATION_ID)
    expect(childId).toBeDefined()

    const childConv = (await d.session.harness.conversation(childId!, BG))!
    const childResults = await toolResultEntries(childConv)
    expect(childResults).toHaveLength(1)
    expect(childResults[0]!.data?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'info', code: 'image' })])
    )
    const childMsg = childResults[0]!.model?.[0]
    expect(childMsg?.role).toBe('toolResult')
    if (childMsg?.role === 'toolResult') {
      expect(childMsg.content.filter((p) => p.type === 'image')).toEqual([
        { type: 'image', data: FITTED_IMAGE_B64, mimeType: 'image/jpeg' }
      ])
    }
  })
})
