/**
 * show_image 工具 —— 把本机的图片直接摆进对话给用户看（设计稿 docs/show-image-design.md）。
 *
 * 这是「给用户看」，不是「给模型看」：图快照进会话自己的目录（services/shownImages.ts），工具结果的 `details` 记下
 * 快照，chat-ui 在调用的位置画出图片块；模型只收到一句确认，要亲眼看就用 read。
 *
 * 没有权限点（用户裁决，2026-11-01）：用户看自己的图不需要权限，模型看才需要 —— 所以这里不过 securityCheck，
 * 没人在场的运行里也不会卡在询问上。不成为读文件的旁路，靠的是快照在会话权限表之外（见 shownImages.ts 文件头）。
 */
import { Type } from 'typebox'
import type { TArray, TObject, TOptional, TString } from 'typebox'
import { BaseTool, type ToolResult } from '@shuvix/agent-runtime'
import {
  SHOW_IMAGE_LIMITS,
  SHOW_IMAGE_TOOL_NAME,
  SHOWN_IMAGE_FORMAT_NAMES
} from '@shuvix/chat-protocol/shownImages'
import type { ShowImageToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { basename } from 'path'
import { presentImages } from '../services/shownImages'
import { resolveProjectConfig, type ToolContext } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { t } from '../i18n'

export const SHOW_IMAGE_DESCRIPTION =
  `Show images to the user in this conversation: ${SHOWN_IMAGE_FORMAT_NAMES} files on this machine — a chart you plotted, a screenshot you saved, a before/after pair. ` +
  'They appear where you call this, each with its caption, and the user can click one to open it at full size. ' +
  'You do not see the images through this tool; use read if you need to look at one. ' +
  'Markdown images in your reply do not render, so use this instead. ' +
  'Do not describe the images again beyond what the user needs.'

export const ShowImageParamsSchema: TObject<{
  images: TArray<TObject<{ path: TString; caption: TOptional<TString> }>>
}> = Type.Object({
  images: Type.Array(
    Type.Object({
      path: Type.String({
        description: `A ${SHOWN_IMAGE_FORMAT_NAMES} file on this machine; a relative path is resolved against the working directory`
      }),
      caption: Type.Optional(
        Type.String({
          description: `A short line shown under the image (at most ${SHOW_IMAGE_LIMITS.caption} characters)`
        })
      )
    }),
    {
      description: `The images, in the order to show them (1 to ${SHOW_IMAGE_LIMITS.maxImages})`,
      minItems: 1,
      maxItems: SHOW_IMAGE_LIMITS.maxImages
    }
  )
})

interface ShowImageParams {
  images?: unknown
}

export class ShowImageTool extends BaseTool<typeof ShowImageParamsSchema> {
  readonly name = SHOW_IMAGE_TOOL_NAME
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS.show_image.labelKey)
  readonly description = SHOW_IMAGE_DESCRIPTION
  readonly parameters = ShowImageParamsSchema
  /** 重放只是再快照一次（按内容去重，不多占盘），摆出来的东西不变 */
  readonly replay = 'safe' as const

  constructor(private readonly ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 没有权限点：用户看自己的图不需要权限（见文件头）。不成为读旁路靠的是快照的位置，不是这里 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: ShowImageParams
  ): Promise<ToolResult<ShowImageToolDetails>> {
    const list = Array.isArray(params.images) ? (params.images as unknown[]) : []
    if (list.length === 0) throw new Error('images must list at least one image')
    if (list.length > SHOW_IMAGE_LIMITS.maxImages) {
      throw new Error(
        `${list.length} images is too many; show at most ${SHOW_IMAGE_LIMITS.maxImages} at a time`
      )
    }
    const requests = list.map((item, i) => {
      const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
      if (typeof o.path !== 'string' || o.path.trim() === '') {
        throw new Error(`images[${i}].path must be a non-empty string`)
      }
      if (o.caption !== undefined) {
        if (typeof o.caption !== 'string') throw new Error(`images[${i}].caption must be a string`)
        if (o.caption.length > SHOW_IMAGE_LIMITS.caption) {
          throw new Error(
            `images[${i}].caption is ${o.caption.length} characters; keep it to at most ${SHOW_IMAGE_LIMITS.caption}`
          )
        }
      }
      return { path: o.path.trim(), label: `images[${i}].path` }
    })
    const images = await presentImages({
      sessionId: this.ctx.sessionId,
      workingDirectory: resolveProjectConfig(this.ctx.sessionId).workingDirectory,
      images: requests
    })
    const lines = images.map((image, i) => {
      const size = image.width && image.height ? ` (${image.width}×${image.height})` : ''
      return `${i + 1}. ${basename(image.source)}${size}`
    })
    const text = `Shown ${images.length} image${images.length === 1 ? '' : 's'} to the user:\n${lines.join('\n')}`
    return {
      content: [{ type: 'text' as const, text }],
      details: { type: SHOW_IMAGE_TOOL_NAME, images }
    }
  }
}

registerBuiltinTool({
  name: SHOW_IMAGE_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.show_image.labelKey),
  getHint: () => t('tool.showImageHint'),
  factory: (ctx) => new ShowImageTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.show_image.presentation,
  describe: () => ({ description: SHOW_IMAGE_DESCRIPTION, parameters: ShowImageParamsSchema })
})
