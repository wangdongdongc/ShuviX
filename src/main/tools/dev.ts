/**
 * Dev 工具 —— 统一的 AI 开发工具
 *
 * 通过 `kind` 参数分流到不同的实现：
 * - widget        → 持久化迷你 Web 工具（~/.shuvix/widgets/<id>/，Widget tab 管理）
 * - presentation  → Spectacle 幻灯片（workingDir/.shuvix/design/，会话级临时）
 * - sketch        → 空白 React 画布（workingDir/.shuvix/design/，会话级临时）
 *
 * widget 有 id/name/description 作为库条目的元数据；
 * presentation 与 sketch 在当前会话里一次只有一个，无需 id。
 */

import { Type } from '@sinclair/typebox'
import { BaseTool, resolveProjectConfig, type ToolContext } from './types'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { DevToolDetails } from '../../shared/types/chatMessage'
import { widgetService } from '../services/widgetService'
import { projectManager, bundlerService } from '../services/bundlerRuntime'
import { t } from '../i18n'

const DevParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('init'), Type.Literal('build')], {
    description: '"init" scaffolds a new project; "build" recompiles and triggers live-reload'
  }),
  kind: Type.Union([Type.Literal('widget'), Type.Literal('presentation'), Type.Literal('sketch')], {
    description:
      '"widget" = persistent mini utility in ~/.shuvix/widgets/ (Widget tab); "presentation" = Spectacle slide deck in workingDir/.shuvix/design/; "sketch" = blank React canvas in workingDir/.shuvix/design/'
  }),
  // 仅 kind='widget' 需要：
  id: Type.Optional(
    Type.String({
      description:
        'Required when kind="widget". Widget id in kebab-case with at least one dash, matching /^[a-z0-9]+(-[a-z0-9]+)+$/.'
    })
  ),
  name: Type.Optional(
    Type.String({
      description: 'Required when kind="widget" and action="init". Title-Case display name.'
    })
  ),
  description: Type.Optional(
    Type.String({
      description: 'One-sentence description. Recommended when kind="widget" and action="init".'
    })
  )
})

type DevParams = {
  action: 'init' | 'build'
  kind: 'widget' | 'presentation' | 'sketch'
  id?: string
  name?: string
  description?: string
}

export class DevTool extends BaseTool<typeof DevParamsSchema> {
  readonly name = 'dev'
  readonly label = t('tool.devLabel')
  readonly description = [
    'Scaffold and live-preview small web projects. Pick a `kind`:',
    '- kind="widget": persistent mini utility saved under ~/.shuvix/widgets/<id>/ and surfaced in the Widget tab. Use for JSON formatters, expression playgrounds, regex testers, anything the user may want to reuse.',
    '- kind="presentation": Spectacle slide deck scaffolded in workingDir/.shuvix/design/. Session-scoped (not persisted in a library).',
    '- kind="sketch": blank React canvas in workingDir/.shuvix/design/. AI decides the full UI shape. Session-scoped.',
    'Actions: "init" creates the project skeleton, "build" compiles and returns the dev-server URL (call the `preview` tool action="open" with the URL).',
    'For kind="widget" you MUST provide id (kebab-case), plus name+description on init.'
  ].join(' ')
  readonly parameters = DevParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查：dev 写入目录由各 kind 内部校验，这里无全局约束 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: DevParams
  ): Promise<AgentToolResult<DevToolDetails>> {
    if (params.kind === 'widget') {
      return this.runWidget(params)
    }
    return this.runDesign(params)
  }

  // ────── widget kind ──────

  private async runWidget(params: DevParams): Promise<AgentToolResult<DevToolDetails>> {
    if (!params.id) {
      return this.failure(params, 'kind="widget" requires `id`')
    }
    try {
      widgetService.validateId(params.id)
    } catch (e) {
      return this.failure(params, (e as Error).message)
    }

    if (params.action === 'init') {
      if (!params.name) {
        return this.failure(params, 'widget init requires `name`')
      }
      try {
        const result = await widgetService.init({
          id: params.id,
          name: params.name,
          description: params.description ?? '',
          template: 'blank',
          sessionId: this.ctx.sessionId
        })
        const text = result.buildSuccess
          ? [
              `Widget "${params.name}" initialized.`,
              `- id: ${result.id}`,
              `- projectDir: ${result.projectDir}`,
              `- url: ${result.url}`,
              `- files: ${result.files.join(', ')}`,
              '',
              'Next steps:',
              '1. Use write/edit to implement the widget (start with index.tsx).',
              '2. Call `dev` again with action="build", kind="widget", id=same to rebuild.',
              '3. Call the `preview` tool action="open" with the url above.'
            ].join('\n')
          : [
              `Widget "${params.name}" initialized but the initial build FAILED.`,
              `- projectDir: ${result.projectDir}`,
              `- errors:`,
              ...(result.buildErrors ?? ['Unknown build error']).map((e) => `  ${e}`),
              '',
              'Fix the scaffolded code and call action="build" to retry.'
            ].join('\n')
        return {
          content: [{ type: 'text', text }],
          details: {
            type: 'dev',
            action: 'init',
            kind: 'widget',
            widgetId: result.id,
            name: params.name,
            url: result.url,
            success: result.buildSuccess,
            error: result.buildSuccess ? undefined : (result.buildErrors ?? []).join('\n')
          }
        }
      } catch (e) {
        return this.failure(params, (e as Error).message)
      }
    }

    // action === 'build'
    try {
      const result = await widgetService.build(params.id, this.ctx.sessionId)
      const text = result.buildSuccess
        ? `Widget "${params.id}" rebuilt. url: ${result.url}`
        : [
            `Widget "${params.id}" rebuild FAILED:`,
            ...(result.buildErrors ?? ['Unknown error']).map((e) => `  ${e}`)
          ].join('\n')
      return {
        content: [{ type: 'text', text }],
        details: {
          type: 'dev',
          action: 'build',
          kind: 'widget',
          widgetId: params.id,
          url: result.url,
          success: result.buildSuccess,
          error: result.buildSuccess ? undefined : (result.buildErrors ?? []).join('\n')
        }
      }
    } catch (e) {
      return this.failure(params, (e as Error).message)
    }
  }

  // ────── presentation / sketch kind ──────

  private async runDesign(params: DevParams): Promise<AgentToolResult<DevToolDetails>> {
    const config = resolveProjectConfig(this.ctx.sessionId)
    const workingDir = config.workingDirectory
    if (!workingDir) {
      return this.failure(
        params,
        'No working directory is available for this session. Select or create a project first.'
      )
    }

    // kind → esbuild 模板名
    const template = params.kind === 'presentation' ? 'presentation' : 'blank'
    const sessionId = this.ctx.sessionId

    if (params.action === 'init') {
      try {
        const designDir = await projectManager.init(sessionId, workingDir, template)
        const text = [
          `${labelForKind(params.kind)} project scaffolded (template: ${template}).`,
          `- projectDir: ${designDir}`,
          '',
          'Next steps:',
          '1. Use write/edit to modify files under the projectDir (entry is index.tsx).',
          `2. Call \`dev\` again with action="build", kind="${params.kind}" to start the dev server and get the URL.`,
          '3. Call the `preview` tool action="open" with the URL.'
        ].join('\n')
        return {
          content: [{ type: 'text', text }],
          details: {
            type: 'dev',
            action: 'init',
            kind: params.kind,
            success: true
          }
        }
      } catch (e) {
        return this.failure(params, (e as Error).message)
      }
    }

    // action === 'build' —— 首次启动 dev server，后续触发 rebuild
    try {
      const designDir = projectManager.getDesignDir(workingDir)
      const wasActive = projectManager.isActive(sessionId)
      if (!wasActive) {
        const info = await projectManager.startDev(sessionId, workingDir, template)
        // startDev 内部已完成首次构建；再 rebuild 一次拿到最新的成功/失败状态
        const result = await bundlerService.rebuild(sessionId, designDir)
        const text = result.success
          ? [
              `${labelForKind(params.kind)} build OK (${result.duration}ms).`,
              `- url: ${info.url}`,
              '',
              `Call the \`preview\` tool action="open" url="${info.url}" to see the result.`
            ].join('\n')
          : [
              `Dev server started at ${info.url} but the build failed:`,
              ...(result.errors ?? []).map((e) => `  ${e}`),
              '',
              `Fix the errors and call \`dev\` build again.`
            ].join('\n')
        return {
          content: [{ type: 'text', text }],
          details: {
            type: 'dev',
            action: 'build',
            kind: params.kind,
            url: info.url,
            success: result.success,
            error: result.success ? undefined : (result.errors ?? []).join('\n')
          }
        }
      } else {
        const info = bundlerService.getDevServerInfo(sessionId)
        const result = await bundlerService.rebuild(sessionId, designDir)
        const url = info?.url ?? ''
        const text = result.success
          ? `${labelForKind(params.kind)} rebuilt OK (${result.duration}ms)${url ? `. Preview auto-refreshed (${url}).` : '.'}`
          : [
              `Rebuild failed:`,
              ...(result.errors ?? []).map((e) => `  ${e}`),
              '',
              `Fix the errors and call \`dev\` build again.`
            ].join('\n')
        return {
          content: [{ type: 'text', text }],
          details: {
            type: 'dev',
            action: 'build',
            kind: params.kind,
            url,
            success: result.success,
            error: result.success ? undefined : (result.errors ?? []).join('\n')
          }
        }
      }
    } catch (e) {
      return this.failure(params, (e as Error).message)
    }
  }

  // ────── 辅助 ──────

  private failure(params: DevParams, error: string): AgentToolResult<DevToolDetails> {
    return {
      content: [{ type: 'text', text: `dev ${params.action} (${params.kind}) failed: ${error}` }],
      details: {
        type: 'dev',
        action: params.action,
        kind: params.kind,
        widgetId: params.id,
        name: params.name,
        success: false,
        error
      }
    }
  }
}

function labelForKind(kind: 'widget' | 'presentation' | 'sketch'): string {
  switch (kind) {
    case 'widget':
      return 'Widget'
    case 'presentation':
      return 'Presentation'
    case 'sketch':
      return 'Sketch'
  }
}

import { registerBuiltinTool } from './registry'
registerBuiltinTool({
  name: 'dev',
  group: 'general',
  defaultEnabled: false,
  factory: (ctx) => new DevTool(ctx),
  getLabel: () => t('tool.devLabel'),
  getHint: () => t('tool.devHint'),
  presentation: {
    icon: 'Wrench',
    iconColor: '#8b5cf6',
    summaryField: 'kind'
  }
})
