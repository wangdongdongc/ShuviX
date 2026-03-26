/**
 * Preview 工具 — 通用预览面板控制
 * AI 通过此工具打开或关闭预览面板，配合 esbuild 等工具使用。
 */

import { Type } from '@sinclair/typebox'
import { BaseTool, type ToolContext } from './types'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { t } from '../i18n'
import { registerBuiltinTool } from './registry'

const PreviewParamsSchema = Type.Object({
  action: Type.Unsafe<'open' | 'close'>({
    type: 'string',
    enum: ['open', 'close'],
    description:
      'Action to perform: "open" opens the preview panel at the given URL; "close" closes/hides the preview panel'
  }),
  url: Type.Optional(
    Type.String({
      description: 'URL to display in the preview panel. Required when action is "open".'
    })
  )
})

export class PreviewTool extends BaseTool<typeof PreviewParamsSchema> {
  readonly name = 'preview'
  get label(): string {
    return t('tool.previewLabel')
  }
  get hint(): string {
    return t('tool.previewHint')
  }
  readonly description =
    'Control the preview panel. Use "open" with a URL to display a web page or local dev server in the preview panel. Use "close" to hide the panel. Typically used after the `esbuild` tool returns a dev server URL.'
  readonly parameters = PreviewParamsSchema
  readonly presentation = {
    icon: 'Monitor',
    iconColor: '#60a5fa',
    summaryField: 'action'
  }

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { action: 'open' | 'close'; url?: string }
  ): Promise<AgentToolResult<undefined>> {
    if (params.action === 'open') {
      if (!params.url) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Preview tool: "url" is required when action is "open".'
            }
          ],
          details: undefined
        }
      }
      if (this.ctx.emitPreviewEvent) {
        this.ctx.emitPreviewEvent('open', params.url)
      }
      return {
        content: [{ type: 'text' as const, text: `Preview panel opened at ${params.url}.` }],
        details: undefined
      }
    } else {
      if (this.ctx.emitPreviewEvent) {
        this.ctx.emitPreviewEvent('close')
      }
      return {
        content: [{ type: 'text' as const, text: 'Preview panel closed.' }],
        details: undefined
      }
    }
  }
}

registerBuiltinTool({
  name: 'preview',
  group: 'general',
  defaultEnabled: false,
  getLabel: () => t('tool.previewLabel'),
  getHint: () => t('tool.previewHint'),
  factory: (ctx) => new PreviewTool(ctx)
})
