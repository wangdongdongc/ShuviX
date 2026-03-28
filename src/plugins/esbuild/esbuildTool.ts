/**
 * EsbuildTool — 管理设计预览项目的初始化与构建（esbuild 插件版）
 * AI 通过此工具创建脚手架、触发构建并获取 dev server URL 和错误信息。
 * 预览面板的打开/关闭由独立的 `preview` 内置工具负责。
 */

import { Type } from '@sinclair/typebox'
import { t } from '../../shared/node/i18n'
import type { PluginTool, PluginContext, AgentToolResult, ToolPresentation } from '../../plugin-api'
import type { ProjectManager } from './projectManager'
import type { BundlerService } from './bundlerService'

/** 构建简单文本结果 */
function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

const EsbuildParamsSchema = Type.Object({
  action: Type.Unsafe<'init' | 'build'>({
    type: 'string',
    enum: ['init', 'build'],
    description:
      'Action to perform: "init" scaffolds the design project at .shuvix/design/; "build" starts the dev server (first call) or rebuilds (subsequent calls) and returns the local URL — use the `preview` tool to open the preview panel with that URL'
  }),
  template: Type.Optional(
    Type.String({
      description:
        'Project template (only used with "init" action, ignored if project already exists). Valid values: "blank" (minimal skeleton, default), "app" (standard React app with example components), "landing" (single-page landing with Hero/Features/Footer sections), "dashboard" (multi-page app with sidebar navigation and React Router). Unknown values fall back to "blank".'
    })
  )
})

export class EsbuildTool implements PluginTool<typeof EsbuildParamsSchema> {
  readonly name = 'esbuild'
  get label(): string {
    return t('tool.esbuildLabel')
  }
  get hint(): string {
    return t('tool.esbuildHint')
  }
  readonly description = `Manage the React design project: scaffold and build with esbuild-wasm. Returns the dev server URL on build — use the \`preview\` tool to open the preview panel.

Actions:
- "init": Scaffold the design project at .shuvix/design/ using the specified template (default: "blank"). Templates: blank, app, landing, dashboard.
- "build": Start the dev server (first call) or rebuild (subsequent calls). Returns the local URL and build result. If the build fails, detailed error messages are returned — fix the code and call "build" again.

The design project supports:
- React with TypeScript (.tsx/.ts)
- React Router (react-router) for multi-page navigation (used by "dashboard" template)
- Tailwind CSS v4 utility classes (available globally, no import needed)
- CSS file imports
- Images as dataurl (svg/png/jpg/gif)
- Auto-refresh on file changes via write/edit tools`

  readonly parameters = EsbuildParamsSchema
  readonly presentation: ToolPresentation = {
    icon: 'Palette',
    iconColor: '#f472b6',
    summaryField: 'action'
  }

  constructor(
    private ctx: PluginContext,
    private projectManager: ProjectManager,
    private bundlerService: BundlerService
  ) {}

  async execute(
    _toolCallId: string,
    params: { action: 'init' | 'build'; template?: string },
    signal?: AbortSignal,
    _onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    sessionId?: string
  ): Promise<AgentToolResult<unknown>> {
    if (signal?.aborted) throw new Error('Aborted')

    if (!sessionId) {
      return textResult('Esbuild tool: sessionId is required but was not provided.')
    }

    const workingDir = this.ctx.getSessionPaths(sessionId).workingDirectory
    if (!workingDir) {
      return textResult(
        `Esbuild tool: no working directory resolved for session ${sessionId}. ` +
          `Please create or select a project, or start a new conversation.`
      )
    }

    switch (params.action) {
      case 'init':
        return this.handleInit(sessionId, workingDir, params.template)
      case 'build':
        return this.handleBuild(sessionId, workingDir, signal)
      default:
        return textResult(`Unknown action: ${params.action}`)
    }
  }

  private async handleInit(
    sessionId: string,
    workingDir: string,
    template?: string
  ): Promise<AgentToolResult<undefined>> {
    const tpl = template || 'blank'
    const designDir = await this.projectManager.init(sessionId, workingDir, tpl)

    return textResult(
      `Design project initialized at .shuvix/design/ (template: ${tpl})\n\n` +
        `Design directory: ${designDir}\n` +
        `Use write/edit tools to modify files, then call esbuild tool with action "build" to build and get the preview URL.`
    )
  }

  private async handleBuild(
    sessionId: string,
    workingDir: string,
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error('Aborted')

    const isActive = this.projectManager.isActive(sessionId)

    if (!isActive) {
      // 首次调用：startDev（含首次构建）
      const serverInfo = await this.projectManager.startDev(sessionId, workingDir)

      // 通知 renderer 更新 server 状态（不打开面板，由 preview 工具负责）
      this.ctx.emitEvent(sessionId, { type: 'plugin:preview_server_started', url: serverInfo.url })

      // startDev 内部已完成首次构建，再 rebuild 一次获取结果
      const designDir = this.projectManager.getDesignDir(workingDir)
      const result = await this.bundlerService.rebuild(sessionId, designDir)

      if (result.success) {
        return textResult(
          `Build OK (${result.duration}ms). Dev server running at ${serverInfo.url}\n\n` +
            `Use the \`preview\` tool with action "open" and url="${serverInfo.url}" to open the preview panel.`
        )
      } else {
        return textResult(
          `Dev server started at ${serverInfo.url} but build failed:\n\n${(result.errors ?? []).join('\n\n')}\n\nFix the errors and call esbuild tool with action "build" again.`
        )
      }
    } else {
      // 后续调用：rebuild + SSE 自动刷新
      const designDir = this.projectManager.getDesignDir(workingDir)
      const serverInfo = this.bundlerService.getDevServerInfo(sessionId)
      const result = await this.bundlerService.rebuild(sessionId, designDir)

      if (result.success) {
        const urlHint = serverInfo ? ` (${serverInfo.url})` : ''
        return textResult(`Build OK (${result.duration}ms). Preview refreshed${urlHint}.`)
      } else {
        return textResult(
          `Build failed:\n\n${(result.errors ?? []).join('\n\n')}\n\nFix the errors and call esbuild tool with action "build" again.`
        )
      }
    }
  }
}
