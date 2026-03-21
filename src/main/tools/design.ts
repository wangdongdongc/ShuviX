/**
 * Design 工具 — 管理设计预览项目的初始化、构建和预览
 * AI 通过此工具创建脚手架、启动预览面板、触发构建并获取错误信息
 */

import { Type } from '@sinclair/typebox'
import { BaseTool, resolveProjectConfig, TOOL_ABORTED, type ToolContext } from './types'
import { designProjectManager } from '../services/designProjectManager'
import { bundlerService } from '../services/bundlerService'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
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

export class DesignTool extends BaseTool<typeof DesignParamsSchema> {
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

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    // 无需预初始化资源
  }

  protected async securityCheck(
    _toolCallId: string,
    _params: { action: 'init' | 'preview' },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
  }

  /** 获取当前会话的工作目录 */
  private getWorkingDir(): string {
    const config = resolveProjectConfig(this.ctx.sessionId)
    if (!config.workingDirectory) {
      throw new Error(
        `Design tool: no working directory resolved for session ${this.ctx.sessionId}. ` +
          `Please create or select a project, or start a new conversation.`
      )
    }
    return config.workingDirectory
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { action: 'init' | 'preview'; template?: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const workingDir = this.getWorkingDir()

    switch (params.action) {
      case 'init':
        return this.handleInit(workingDir, params.template)
      case 'preview':
        return this.handlePreview(workingDir, signal)
      default:
        return textResult(`Unknown action: ${params.action}`)
    }
  }

  private async handleInit(
    workingDir: string,
    template?: string
  ): Promise<AgentToolResult<undefined>> {
    const tpl = template || 'app'
    const designDir = await designProjectManager.init(this.ctx.sessionId, workingDir, tpl)

    return textResult(
      `Design project initialized at .shuvix/design/ (template: ${tpl})\n\n` +
        `Design directory: ${designDir}\n` +
        `Use write/edit tools to modify files, then call design tool with action "preview" to build and preview.`
    )
  }

  private async handlePreview(
    workingDir: string,
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const isActive = designProjectManager.isActive(this.ctx.sessionId)

    if (!isActive) {
      // 首次调用：init + startDev（含首次构建）
      const serverInfo = await designProjectManager.startDev(this.ctx.sessionId, workingDir)

      // 通知 renderer 打开预览面板
      this.ctx.onDesignServerStarted?.(serverInfo.url)

      // startDev 内部已完成首次构建，再 rebuild 一次获取结果
      const designDir = designProjectManager.getDesignDir(workingDir)
      const result = await bundlerService.rebuild(this.ctx.sessionId, designDir)

      if (result.success) {
        return textResult(`Preview started and build OK (${result.duration}ms). The preview panel is now open.`)
      } else {
        return textResult(
          `Preview started but build failed:\n\n${(result.errors ?? []).join('\n\n')}\n\nFix the errors and call design tool with action "preview" again.`
        )
      }
    } else {
      // 后续调用：rebuild + SSE 自动刷新
      const designDir = designProjectManager.getDesignDir(workingDir)
      const result = await bundlerService.rebuild(this.ctx.sessionId, designDir)

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
