/**
 * widget 工具（桌面注册）—— agent **造**组件的入口：`list` / `create` / `build` / `test` / `preview` / `sql` / `export` /
 * `open`（设计稿 docs/widget-tool-design.md）。怎么造写在技能 `builtin:widget` 里，货架上没有它的 agent 拿不到这个工具
 * （agentHost 的 omitBuiltin）。
 *
 * **用**组件不在这里（2026-11-04）：每个有 API 的组件是一台 MCP 服务器，经 `tool_search` 或选择器开启，操作是普通工具
 * （services/builtinMcp/widgetMcpServer.ts）。`test` 是造组件时的试跑：同一个分发器，但写的东西全部回滚，也够得到纯界面的操作。
 *
 * 内置工具是会话级的（同一会话的每个 agent 共用一份）；调用时再按发起调用的 agent 自己的货架核对一次：
 * 一个早先创建、名单里还有这个工具的 agent 不该因此能造组件。
 *
 * 授权（§7）：`list` / `open` 不要授权；`test` 读操作要读、写操作要读写；`build` / `sql` 要读写；
 * `preview` / `export` 要读（`export` 另过目标路径的写门）；`create` 不问，造它的会话自动得到读写（来源 widget）。
 * 读写授权派生出组件源码目录的可写行（services/acl），改组件的文件与写它的数据是同一道授权。门在
 * toolContext.assertWidgetAccess（出厂的 ask-on-widget-access，只由用户回答）。
 *
 * 关联：针对一个组件的动作过了门就记一笔「这条会话、它的项目用过这个组件」（noteWidgetUse，
 * Widget 面板的卡片据此显示项目标签）；`list` 只是看，不记。
 */
import { readFileSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { Type } from 'typebox'
import type { ToolCallScope, ToolResult } from '@shuvix/agent-runtime'
import { BaseTool, callOwnerOf } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { WIDGET_SKILL, WIDGET_TOOL_NAME } from '@shuvix/chat-protocol/widgetServers'
import { registerBuiltinTool } from '../services/toolRegistry'
import {
  assertWidgetAccess,
  assertWriteAllowed,
  resolveProjectConfig,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import { agentActorOf, withCallAgent } from '../services/toolAgent'
import { sessionAcl } from '../services/acl'
import {
  exportWidget,
  hasLegacyWidgetData,
  readApiSnapshot,
  resolveAgentOp,
  resolveExportZipPath,
  runWidgetDbQuery,
  runWidgetOpForAgent,
  WidgetExportError,
  widgetService,
  widgetStorageOf
} from '../services/widget'
import { noteWidgetUse } from '../services/widget/noteUse'
import { WIDGET_ID_REGEX } from '../services/widget/widgetRegistry'
import * as widgetWindowService from '../services/widgetWindowService'
import {
  parsePreviewSizes,
  parsePreviewTheme,
  previewWidget
} from '../services/widgetPreviewService'
import { t } from '../i18n'

export { WIDGET_SKILL, WIDGET_TOOL_NAME }

const WIDGET_ACTIONS = [
  'list',
  'create',
  'build',
  'test',
  'preview',
  'sql',
  'export',
  'open'
] as const
type WidgetAction = (typeof WIDGET_ACTIONS)[number]

const PREVIEW_SIZES = ['panel', 'window', 'phone'] as const

export const WidgetParamsSchema = Type.Object({
  action: Type.Unsafe<WidgetAction>({
    type: 'string',
    enum: [...WIDGET_ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  widget: Type.Optional(Type.String({ description: 'The widget id (every action but "list").' })),
  op: Type.Optional(Type.String({ description: 'For "test": the operation name.' })),
  args: Type.Optional(
    Type.Unknown({
      description: `For "test": the operation's input, as its input schema says (default {}).`
    })
  ),
  name: Type.Optional(Type.String({ description: 'For "create": the name the user sees.' })),
  description: Type.Optional(
    Type.String({ description: 'For "create": one sentence on what the widget is for.' })
  ),
  message: Type.Optional(
    Type.String({ description: 'For "build": what changed (the build is committed with it).' })
  ),
  sizes: Type.Optional(
    Type.Array(
      Type.Unsafe<(typeof PREVIEW_SIZES)[number]>({ type: 'string', enum: [...PREVIEW_SIZES] }),
      { description: 'For "preview": which sizes to capture (default all three).' }
    )
  ),
  theme: Type.Optional(
    Type.Unsafe<'light' | 'dark'>({
      type: 'string',
      enum: ['light', 'dark'],
      description: 'For "preview": the color scheme (default the app\'s).'
    })
  ),
  wait_for: Type.Optional(
    Type.String({
      description:
        'For "preview": a CSS selector to wait for (up to 30s) before each screenshot. Have the page add it once slow content, such as a 3D model, has drawn.'
    })
  ),
  sql: Type.Optional(Type.String({ description: 'For "sql": the SQL to run.' })),
  legacy: Type.Optional(
    Type.Boolean({
      description:
        'For "sql": run it on an older widget\'s data that is still in the shared PostgreSQL database (to move it over).'
    })
  ),
  path: Type.Optional(
    Type.String({
      description:
        'For "export": where to write the zip (a folder or a .zip path; relative paths are inside the working directory).'
    })
  )
})

export const WIDGET_DESCRIPTION = `Build and change the user's widgets: small apps the user works in, each with its own records, a screen and an API. The widget skill says how.

Actions:
- "list": every widget, with its folder, storage, operations and whether this session may use it (none / read / read-write).
- "create": scaffold a new widget (\`widget\` = its id, kebab-case with at least one dash; \`name\`, \`description\`) and build it once. This session may then use and change it, and edit its folder.
- "build": build its screen and API after you edited its files; \`message\` says what changed (the build is committed).
- "test": try one operation (\`widget\`, \`op\`, \`args\`). Everything it wrote is rolled back, and screen-only operations can be tried too. Wrong \`args\` show the operation's input schema.
- "preview": screenshots of its screen at \`sizes\` in \`theme\`, plus the errors the page logged. It waits for the page's requests to finish, and for \`wait_for\` if given. The page's own calls run as this session.
- "sql": run \`sql\` on its database — create tables, look at rows, fix data. \`legacy: true\` runs it on an older widget's data in the shared PostgreSQL database.
- "export": package it as a standalone Vite project zip at \`path\`.
- "open": open it in its own window, only when the user asks.
Changing a widget (build, sql, testing a writing operation) needs this session's read-write permission for it; preview, export and testing a reading operation need read. The first use asks the user. If the user declines, do not look for another way in.

This tool does not use a widget for real. Once a widget is turned on for a session (in the extensions picker, or with \`tool_search\`), its operations are ordinary tools named mcp__widget-<id>__<operation>.`

type WidgetToolParams = {
  action: WidgetAction
  widget?: string
  op?: string
  args?: unknown
  name?: string
  description?: string
  message?: string
  sizes?: string[]
  theme?: string
  wait_for?: string
  sql?: string
  legacy?: boolean
  path?: string
}

type Result = ToolResult<{ action: WidgetAction; widget?: string } | undefined>

/** 这次调用要的组件：id 合法、存在（没归档） */
function requireWidget(id: string | undefined): { id: string; name: string } {
  const widgetId = id?.trim()
  if (!widgetId) throw new Error('`widget` is required: the widget id (see "list").')
  if (!WIDGET_ID_REGEX.test(widgetId)) {
    throw new Error(`"${widgetId}" is not a widget id (kebab-case with at least one dash).`)
  }
  const widget = widgetService.getById(widgetId)
  if (!widget || widget.archivedAt) {
    throw new Error(`There is no widget "${widgetId}". Call "list" to see the widgets.`)
  }
  return { id: widget.id, name: widget.name }
}

/**
 * 说明的第一句（`list` 里一行放得下）：西文句号后要跟空白才算断（`1.5` 不断），中文 / 日文的句号本身就断
 * （句子之间没有空白）
 */
function firstSentence(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  const match = /^.*?(?:[.!?](?:\s|$)|[。！？])/.exec(line)
  return (match ? match[0] : line).trim()
}

const ACCESS_LABEL = { none: 'none', read: 'read', write: 'read-write' } as const

/** XML 属性值转义 */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function textResult(action: WidgetAction, text: string, widget?: string): Result {
  return {
    content: [{ type: 'text', text }],
    details: widget === undefined ? { action } : { action, widget }
  }
}

export class WidgetTool extends BaseTool<typeof WidgetParamsSchema> {
  readonly name = WIDGET_TOOL_NAME
  readonly label: string
  readonly description = WIDGET_DESCRIPTION
  readonly parameters = WidgetParamsSchema
  // 不能重跑：一个工具兼管只读的 list 与会写数据、会构建提交的动作，durable 的重跑策略按工具定死，
  // 只能取最保守的那个（同 knowledge）
  readonly replay = 'unsafe' as const

  constructor(private readonly ctx: ToolContext) {
    super()
    this.label = t(BUILTIN_TOOL_PRESENTATIONS[WIDGET_TOOL_NAME].labelKey)
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* 门在 executeInternal 里：客体（哪个组件、读还是写）解析出来之后才知道，见 authorize */
  }

  protected async executeInternal(
    toolCallId: string,
    params: WidgetToolParams,
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<Result> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    const action = params.action
    if (!(await this.callerBuilds(call))) {
      throw new Error(`"${action}" is for building widgets, which needs the ${WIDGET_SKILL} skill.`)
    }
    switch (action) {
      case 'list':
        return this.list()
      case 'create':
        return this.create(params)
      case 'build':
        return this.build(toolCallId, params, signal, call)
      case 'test':
        return this.test(toolCallId, params, signal, call)
      case 'preview':
        return this.preview(toolCallId, params, signal, call)
      case 'sql':
        return this.sql(toolCallId, params, signal, call)
      case 'export':
        return this.export(toolCallId, params, signal, call)
      case 'open':
        return this.open(params)
      default:
        throw new Error(`Unknown action "${String(action)}".`)
    }
  }

  /**
   * 发起这次调用的 agent 能不能造组件：它自己的技能货架上有没有 widget 技能。没有 durable 调用（单测直接调钩子）
   * 按根 agent 的货架；有调用但读不到它的工具表 → 按不能（宁可少给）
   */
  private async callerBuilds(call: ToolCallScope | undefined): Promise<boolean> {
    if (!call) return this.ctx.rootSkills?.includes(WIDGET_SKILL) === true
    try {
      const agent = await call.api.agent(call.context)
      const skill = agent.tools.find((tool) => tool.name === 'skill') as
        | { skillNames?: unknown }
        | undefined
      const names = skill?.skillNames
      return Array.isArray(names) && names.includes(WIDGET_SKILL)
    } catch {
      return false
    }
  }

  /** 过组件的门（ask-on-widget-access）；`operation` = 操作名（test）或动作名 */
  private async authorize(
    access: 'read' | 'write',
    widget: { id: string; name: string },
    action: WidgetAction,
    operation: string,
    toolCallId: string,
    call: ToolCallScope | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> {
    await assertWidgetAccess(
      withCallAgent(this.ctx, call),
      access,
      { widgetId: widget.id, name: widget.name, operation },
      {
        toolCallId,
        toolName: WIDGET_TOOL_NAME,
        operation: action,
        owner: callOwnerOf(call),
        ...(signal ? { signal } : {})
      }
    )
  }

  private noteUse(widgetId: string): void {
    noteWidgetUse(widgetId, this.ctx.sessionId)
  }

  private list(): Result {
    const lines: string[] = []
    for (const widget of widgetService.listActive()) {
      const snapshot = widgetStorageOf(widget.id) === 'sqlite' ? readApiSnapshot(widget.id) : null
      const access = ACCESS_LABEL[sessionAcl.widgetAccess(this.ctx.sessionId, widget.id)]
      const dir = attr(widgetService.getWidgetDir(widget.id))
      // 存储：还在共用 PostgreSQL 上的老组件；换成了 SQLite、旧数据还留着的（`sql` 的 legacy 读得到）
      const storage =
        widgetStorageOf(widget.id) !== 'sqlite'
          ? ' storage="legacy-postgres"'
          : hasLegacyWidgetData(widget.id)
            ? ' old-data="legacy-postgres"'
            : ''
      lines.push(
        `<widget id="${widget.id}" name="${attr(widget.name)}" access="${access}"${storage} dir="${dir}">`
      )
      if (widget.description) lines.push(widget.description)
      if (snapshot) {
        for (const op of snapshot.ops) {
          const tag = op.agent === false ? ', screen only' : ''
          lines.push(`- ${op.name} (${op.mode}${tag}): ${firstSentence(op.description)}`)
        }
      } else {
        lines.push('(no API)')
      }
      lines.push('</widget>')
    }
    if (lines.length === 0) return textResult('list', 'There are no widgets yet.')
    return textResult('list', `<widgets>\n${lines.join('\n')}\n</widgets>`)
  }

  /** 试跑一个操作：同一个分发器，写的东西全部回滚 */
  private async test(
    toolCallId: string,
    params: WidgetToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    const opName = params.op?.trim()
    if (!opName) throw new Error('`op` is required: the operation to test.')
    const entry = resolveAgentOp(widget.id, opName, { screenOnly: true })
    await this.authorize(entry.mode, widget, 'test', opName, toolCallId, call, signal)
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    this.noteUse(widget.id)
    const actor = agentActorOf(withCallAgent(this.ctx, call))
    const { text, isError } = await runWidgetOpForAgent(
      widget.id,
      entry,
      params.args ?? {},
      { kind: 'agent', sessionId: this.ctx.sessionId, actor, label: actor },
      { dryRun: true }
    )
    if (isError) throw new Error(text)
    return textResult('test', text, widget.id)
  }

  private async create(params: WidgetToolParams): Promise<Result> {
    const id = params.widget?.trim() ?? ''
    if (!id) throw new Error("`widget` is required: the new widget's id (kebab-case with a dash).")
    const name = params.name?.trim()
    if (!name) throw new Error('`name` is required for "create".')
    const result = await widgetService.init({
      id,
      name,
      description: params.description?.trim() ?? '',
      template: 'blank'
    })
    // 造它的会话可以用它、改它（含源码目录的写权限，派生自这一行）
    sessionAcl.grantWidget(this.ctx.sessionId, id, 'write', 'widget')
    this.noteUse(id)
    const lines = [
      `Created widget "${id}" in ${result.projectDir}.`,
      `Files: ${result.files.join(', ')}`,
      result.buildSuccess ? 'First build: OK.' : 'First build failed:',
      ...(result.buildErrors ?? []).map((e) => `- ${e}`)
    ]
    return textResult('create', lines.join('\n'), id)
  }

  private async build(
    toolCallId: string,
    params: WidgetToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    await this.authorize('write', widget, 'build', 'build', toolCallId, call, signal)
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    this.noteUse(widget.id)
    const message = params.message?.trim()
    const built = await widgetService.build(widget.id, message ? { message } : {})
    const lines: string[] = []
    if (built.buildSuccess) {
      lines.push(`Built "${widget.id}".${built.commit ? ` Committed ${built.commit}.` : ''}`)
    } else {
      lines.push(`The build of "${widget.id}" failed:`)
      for (const error of built.buildErrors ?? []) lines.push(`- ${error}`)
    }
    if (built.api?.length) {
      lines.push(
        `Operations: ${built.api
          .map((o) => `${o.op} (${o.mode}${o.agent ? '' : ', screen only'})`)
          .join(', ')}`
      )
    }
    for (const warning of built.warnings ?? []) lines.push(`Warning: ${warning}`)
    const result = textResult('build', lines.join('\n'), widget.id)
    return built.buildSuccess ? result : { ...result, isError: true }
  }

  private async preview(
    toolCallId: string,
    params: WidgetToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    const sizes = parsePreviewSizes(params.sizes)
    const theme = parsePreviewTheme(params.theme)
    await this.authorize('read', widget, 'preview', 'preview', toolCallId, call, signal)
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    this.noteUse(widget.id)
    const result = await previewWidget(widget.id, {
      sizes,
      ...(theme ? { theme } : {}),
      ...(params.wait_for ? { waitFor: params.wait_for } : {}),
      sessionId: this.ctx.sessionId,
      ...(signal ? { signal } : {})
    })
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    const content: Result['content'] = []
    for (const image of result.images) {
      content.push({
        type: 'text',
        text: `${image.size} (${image.width}×${image.height}, ${result.theme} theme):`
      })
      content.push({
        type: 'image',
        data: readFileSync(image.path).toString('base64'),
        mimeType: 'image/png'
      })
    }
    if (result.errors.length > 0) {
      content.push({ type: 'text', text: `<errors>\n${result.errors.join('\n')}\n</errors>` })
    }
    if (content.length === 0) content.push({ type: 'text', text: 'Nothing was captured.' })
    return { content, details: { action: 'preview', widget: widget.id } }
  }

  private async sql(
    toolCallId: string,
    params: WidgetToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    const sql = params.sql ?? ''
    if (!sql.trim()) throw new Error('`sql` is required for "sql".')
    await this.authorize('write', widget, 'sql', 'sql', toolCallId, call, signal)
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    // `legacy`：老组件留在共用 PGlite 里的数据（换成 SQLite 之后照样读得到，搬数据用）
    if (params.legacy === true && !hasLegacyWidgetData(widget.id)) {
      throw new Error(`Widget "${widget.id}" has no data in the older shared database.`)
    }
    this.noteUse(widget.id)
    const out =
      params.legacy === true
        ? await runWidgetDbQuery(widget.id, sql)
        : await widgetService.dbQuery(widget.id, sql)
    if (out.error) throw new Error(out.error)
    return textResult('sql', out.output || 'OK', widget.id)
  }

  private async export(
    toolCallId: string,
    params: WidgetToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    const raw = params.path?.trim()
    if (!raw) throw new Error('`path` is required for "export": a folder or a .zip path.')
    const config = resolveProjectConfig(this.ctx.sessionId)
    // 先归一化成最终 zip 路径再过门 —— 门判的必须是真正写入的那个文件
    const zipPath = resolveExportZipPath(
      widget.id,
      isAbsolute(raw) ? raw : resolve(config.workingDirectory, raw)
    )
    await this.authorize('read', widget, 'export', 'export', toolCallId, call, signal)
    await assertWriteAllowed(
      withCallAgent(this.ctx, call),
      config,
      toolCallId,
      WIDGET_TOOL_NAME,
      zipPath,
      undefined,
      callOwnerOf(call)
    )
    if (signal?.aborted) throw new Error(TOOL_ABORTED)
    this.noteUse(widget.id)
    try {
      const result = await exportWidget({ id: widget.id, targetPath: zipPath })
      return textResult('export', `Exported "${widget.id}" to ${result.zipPath}.`, widget.id)
    } catch (e) {
      if (e instanceof WidgetExportError) throw new Error(`[${e.code}] ${e.message}`)
      throw e
    }
  }

  private async open(params: WidgetToolParams): Promise<Result> {
    const widget = requireWidget(params.widget)
    // 窗口自己完成构建与地址；不走 widgetService.open，免得与窗口重复计一次打开
    widgetWindowService.open(widget.id)
    this.noteUse(widget.id)
    return textResult('open', `Opened "${widget.name}" in its own window.`, widget.id)
  }
}

registerBuiltinTool({
  name: WIDGET_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[WIDGET_TOOL_NAME].labelKey),
  getHint: () => t('tool.widgetHint'),
  factory: (ctx: ToolContext) => new WidgetTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[WIDGET_TOOL_NAME].presentation,
  describe: () => ({ description: WIDGET_DESCRIPTION, parameters: WidgetParamsSchema })
})
