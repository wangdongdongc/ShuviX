/**
 * Design 工具 — 管理设计预览项目的初始化、构建和预览（插件版）
 * AI 通过此工具创建脚手架、启动预览面板、触发构建并获取错误信息
 */

import { Type } from '@sinclair/typebox'
import type { PluginTool, PluginContext, AgentToolResult } from '../../plugin-api'
import type { DesignProjectManager } from './designProjectManager'
import type { BundlerService } from './bundlerService'

/** 构建简单文本结果 */
function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

const DesignParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('init'), Type.Literal('preview')], {
    description:
      'Action to perform: "init" scaffolds the design project at .shuvix/design/; "preview" builds and opens/refreshes the preview panel (starts dev server on first call, rebuilds on subsequent calls)'
  }),
  template: Type.Optional(
    Type.Union(
      [
        Type.Literal('blank'),
        Type.Literal('app'),
        Type.Literal('landing'),
        Type.Literal('dashboard')
      ],
      {
        description:
          'Project template (only used with "init" action, ignored if project already exists). "blank": minimal skeleton; "app": standard React app with example components (default); "landing": single-page landing with Hero/Features/Footer sections; "dashboard": multi-page app with sidebar navigation and React Router'
      }
    )
  )
})

export class DesignTool implements PluginTool<typeof DesignParamsSchema> {
  readonly name = 'design'
  readonly label = 'Design'
  readonly description = `Manage the interactive design preview project. This tool creates and previews React UI components in a sandboxed environment with Tailwind CSS.

Actions:
- "init": Scaffold the design project at .shuvix/design/ using the specified template (default: "app"). Templates: blank, app, landing, dashboard.
- "preview": Build the project and open the preview panel. On first call, starts the dev server; on subsequent calls, triggers a rebuild and refreshes the preview. Returns build errors if the build fails — use these to debug and fix the code.

The design project supports:
- React with TypeScript (.tsx/.ts)
- React Router (react-router) for multi-page navigation (used by "dashboard" template)
- Tailwind CSS v4 utility classes (available globally, no import needed)
- CSS file imports
- Images as dataurl (svg/png/jpg/gif)
- Auto-refresh on file changes via write/edit tools`

  readonly parameters = DesignParamsSchema

  constructor(
    private ctx: PluginContext,
    private designProjectManager: DesignProjectManager,
    private bundlerService: BundlerService
  ) {}

  async execute(
    _toolCallId: string,
    params: { action: 'init' | 'preview'; template?: string },
    signal?: AbortSignal,
    _onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    sessionId?: string
  ): Promise<AgentToolResult<unknown>> {
    if (signal?.aborted) throw new Error('Aborted')

    if (!sessionId) {
      return textResult('Design tool: sessionId is required but was not provided.')
    }

    const workingDir = this.ctx.getWorkingDirectory(sessionId)
    if (!workingDir) {
      return textResult(
        `Design tool: no working directory resolved for session ${sessionId}. ` +
          `Please create or select a project, or start a new conversation.`
      )
    }

    switch (params.action) {
      case 'init':
        return this.handleInit(sessionId, workingDir, params.template)
      case 'preview':
        return this.handlePreview(sessionId, workingDir, signal)
      default:
        return textResult(`Unknown action: ${params.action}`)
    }
  }

  private async handleInit(
    sessionId: string,
    workingDir: string,
    template?: string
  ): Promise<AgentToolResult<undefined>> {
    const tpl = template || 'app'
    const designDir = await this.designProjectManager.init(sessionId, workingDir, tpl)

    return textResult(
      `Design project initialized at .shuvix/design/ (template: ${tpl})\n\n` +
        `Design directory: ${designDir}\n` +
        `Use write/edit tools to modify files, then call design tool with action "preview" to build and preview.`
    )
  }

  private async handlePreview(
    sessionId: string,
    workingDir: string,
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error('Aborted')

    const isActive = this.designProjectManager.isActive(sessionId)

    if (!isActive) {
      // 首次调用：init + startDev（含首次构建）
      const serverInfo = await this.designProjectManager.startDev(sessionId, workingDir)

      // 通知 renderer 打开预览面板
      this.ctx.emitEvent(sessionId, { type: 'plugin:preview_server_started', url: serverInfo.url })

      // startDev 内部已完成首次构建，再 rebuild 一次获取结果
      const designDir = this.designProjectManager.getDesignDir(workingDir)
      const result = await this.bundlerService.rebuild(sessionId, designDir)

      if (result.success) {
        return textResult(
          `Preview started and build OK (${result.duration}ms). The preview panel is now open.`
        )
      } else {
        return textResult(
          `Preview started but build failed:\n\n${(result.errors ?? []).join('\n\n')}\n\nFix the errors and call design tool with action "preview" again.`
        )
      }
    } else {
      // 后续调用：rebuild + SSE 自动刷新
      const designDir = this.designProjectManager.getDesignDir(workingDir)
      const result = await this.bundlerService.rebuild(sessionId, designDir)

      if (result.success) {
        return textResult(`Build OK (${result.duration}ms). Preview refreshed.`)
      } else {
        return textResult(
          `Build failed:\n\n${(result.errors ?? []).join('\n\n')}\n\nFix the errors and call design tool with action "preview" again.`
        )
      }
    }
  }
}
