/**
 * widget 工具（桌面注册）—— agent 用组件、造组件的**唯一入口**（设计稿 docs/widget-tool-design.md §5、D12–D15）。
 *
 * 两组动作：
 *   - 用（有这个工具的 agent 都有）：`list` / `describe` / `call`。`call` 走与组件界面同一个分发器
 *     （api/widgetApi.ts 的 callWidgetOp），效果与用户在组件界面里点一样。
 *   - 造（只在 agent 同时持有 `skill:builtin:widget` 时出现，D13）：`create` / `build` / `preview` / `sql` /
 *     `export` / `open`，加上 `call` 的 `dry_run`。怎么造写在技能里，不持有技能的 agent 看不到这几个动作。
 *     从前它们是 `shuvix widget …` 这组 CLI 命令；CLI 不知道是哪条会话在用（令牌只认组件），删掉了。
 *
 * 内置工具是会话级的（同一会话的每个 agent 共用一份），描述只能按**根 agent** 的技能货架定（ctx.rootSkills）；
 * 造的那组动作在调用时再按发起调用的 agent 自己的货架核对一次（派生 agent、或重配之后取消了技能）。
 *
 * 授权（§7）：`list` / `describe` / `open` 不要授权；`call` 读操作要读、写操作要读写；`build` / `sql` 要读写；
 * `preview` / `export` 要读（`export` 另过目标路径的写门）；`create` 不问，造它的会话自动得到读写（来源 widget）。
 * 读写授权派生出组件源码目录的可写行（services/acl），改组件的文件与写它的数据是同一道授权。门在
 * toolContext.assertWidgetAccess（出厂的 ask-on-widget-access，只由用户回答）。
 */
import { readFileSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { Type } from 'typebox'
import type { ToolCallScope, ToolResult } from '@shuvix/agent-runtime'
import { BaseTool, callOwnerOf } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
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
  callWidgetOp,
  exportWidget,
  hasLegacyWidgetData,
  readApiSnapshot,
  resolveExportZipPath,
  runWidgetDbQuery,
  WidgetApiError,
  WidgetExportError,
  widgetService,
  widgetStorageOf
} from '../services/widget'
import { WIDGET_ID_REGEX } from '../services/widget/widgetRegistry'
import * as widgetWindowService from '../services/widgetWindowService'
import {
  parsePreviewSizes,
  parsePreviewTheme,
  previewWidget
} from '../services/widgetPreviewService'
import { t } from '../i18n'

export const WIDGET_TOOL_NAME = 'widget'

/** 造组件的那组动作跟着这个技能走（D13） */
export const WIDGET_SKILL = 'builtin:widget'

const USE_ACTIONS = ['list', 'describe', 'call'] as const
const BUILD_ACTIONS = ['create', 'build', 'preview', 'sql', 'export', 'open'] as const
type WidgetAction = (typeof USE_ACTIONS)[number] | (typeof BUILD_ACTIONS)[number]

const PREVIEW_SIZES = ['panel', 'window', 'phone'] as const

const useFields = {
  widget: Type.Optional(Type.String({ description: 'The widget id (every action but "list").' })),
  op: Type.Optional(Type.String({ description: 'For "call": the operation name.' })),
  args: Type.Optional(
    Type.Unknown({
      description: `For "call": the operation's input, as its input schema says (default {}).`
    })
  )
}

const buildFields = {
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        'For "call": roll back everything the operation wrote, to test it. Also reaches operations meant for the screen only.'
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
}

export const WidgetUseParamsSchema = Type.Object({
  action: Type.Unsafe<(typeof USE_ACTIONS)[number]>({
    type: 'string',
    enum: [...USE_ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  ...useFields
})

export const WidgetParamsSchema = Type.Object({
  action: Type.Unsafe<WidgetAction>({
    type: 'string',
    enum: [...USE_ACTIONS, ...BUILD_ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  ...useFields,
  ...buildFields
})

export const WIDGET_USE_DESCRIPTION = `Use the user's widgets: small apps the user works in, each with its own records and an API. Calling an operation does exactly what the same action in the widget's own screen does, and the user sees the result there.

Actions:
- "list": every widget that has an API, with its operations and whether this session may use it (none / read / read-write).
- "describe": one widget's operations (\`widget\`) with their input and output schemas. Call it before you first use a widget in this conversation.
- "call": run one operation (\`widget\`, \`op\`, \`args\`). The first call to a widget asks the user to let this session use it — read operations and writes separately. If the user declines, do not look for another way in.`

export const WIDGET_DESCRIPTION = `${WIDGET_USE_DESCRIPTION}

Building widgets (the widget skill says how):
- "create": scaffold a new widget (\`widget\` = its id, kebab-case with at least one dash; \`name\`, \`description\`) and build it once. This session may then use and change it, and edit its folder.
- "build": build its screen and API after you edited its files; \`message\` says what changed (the build is committed).
- "preview": screenshots of its screen at \`sizes\` in \`theme\`, plus the errors the page logged. The page's own calls run as this session.
- "sql": run \`sql\` on its database — create tables, look at rows, fix data. \`legacy: true\` runs it on an older widget's data in the shared PostgreSQL database.
- "export": package it as a standalone Vite project zip at \`path\`.
- "open": open it in its own window, only when the user asks.
- "call" with \`dry_run: true\` rolls back what the operation wrote and also reaches the screen-only operations.
Changing a widget (build, sql, calls that write) needs this session's read-write permission for it; preview and export need read.`

type WidgetToolParams = {
  action: WidgetAction
  widget?: string
  op?: string
  args?: unknown
  dry_run?: boolean
  name?: string
  description?: string
  message?: string
  sizes?: string[]
  theme?: string
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
  readonly description: string
  readonly parameters: typeof WidgetParamsSchema
  // 不能重跑：一个工具兼管只读的 list / describe 与会写数据、会构建提交的动作，durable 的重跑策略按工具定死，
  // 只能取最保守的那个（同 knowledge）
  readonly replay = 'unsafe' as const
  /** 描述里讲不讲造组件的那组动作：按根 agent 的技能货架定 */
  private readonly building: boolean

  constructor(private readonly ctx: ToolContext) {
    super()
    this.label = t(BUILTIN_TOOL_PRESENTATIONS[WIDGET_TOOL_NAME].labelKey)
    this.building = ctx.rootSkills?.includes(WIDGET_SKILL) === true
    this.description = this.building ? WIDGET_DESCRIPTION : WIDGET_USE_DESCRIPTION
    // 不持有技能的那一份只收用的那组动作：schema 本身就不让它点名造的动作
    this.parameters = (
      this.building ? WidgetParamsSchema : WidgetUseParamsSchema
    ) as typeof WidgetParamsSchema
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
    const buildAction = (BUILD_ACTIONS as readonly string[]).includes(action)
    if (buildAction || params.dry_run === true) {
      if (!(await this.callerBuilds(call))) {
        throw new Error(
          `"${action}"${params.dry_run ? ' with dry_run' : ''} is for building widgets, which needs the ${WIDGET_SKILL} skill. Use "list", "describe" and "call".`
        )
      }
    }
    switch (action) {
      case 'list':
        return this.list(call)
      case 'describe':
        return this.describe(params, call)
      case 'call':
        return this.call(toolCallId, params, signal, call)
      case 'create':
        return this.create(params)
      case 'build':
        return this.build(toolCallId, params, signal, call)
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
   * 按会话级的那一份（根 agent 的货架）；有调用但读不到它的工具表 → 按不能（宁可少给）
   */
  private async callerBuilds(call: ToolCallScope | undefined): Promise<boolean> {
    if (!call) return this.building
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

  /** 过组件的门（ask-on-widget-access）；`operation` = 操作名（call）或动作名 */
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

  private async list(call: ToolCallScope | undefined): Promise<Result> {
    const building = await this.callerBuilds(call)
    const lines: string[] = []
    for (const widget of widgetService.listActive()) {
      const snapshot = widgetStorageOf(widget.id) === 'sqlite' ? readApiSnapshot(widget.id) : null
      // 用组件的 agent 只看见有 API 的；造组件的还看见没有 API 的（老组件、还没写 api.ts 的）与源码目录
      if (!snapshot && !building) continue
      const access = ACCESS_LABEL[sessionAcl.widgetAccess(this.ctx.sessionId, widget.id)]
      const extra = building ? ` dir="${attr(widgetService.getWidgetDir(widget.id))}"` : ''
      // 造组件的看得见存储：还在共用 PostgreSQL 上的老组件；换成了 SQLite、旧数据还留着的（`sql` 的 legacy 读得到）
      const legacyStorage = widgetStorageOf(widget.id) !== 'sqlite'
      const storage = !building
        ? ''
        : legacyStorage
          ? ' storage="legacy-postgres"'
          : hasLegacyWidgetData(widget.id)
            ? ' old-data="legacy-postgres"'
            : ''
      lines.push(
        `<widget id="${widget.id}" name="${attr(widget.name)}" access="${access}"${storage}${extra}>`
      )
      if (widget.description) lines.push(widget.description)
      if (snapshot) {
        for (const op of snapshot.ops) {
          if (op.agent === false && !building) continue
          const tag = op.agent === false ? ', screen only' : ''
          lines.push(`- ${op.name} (${op.mode}${tag}): ${firstSentence(op.description)}`)
        }
      } else {
        lines.push('(no API)')
      }
      lines.push('</widget>')
    }
    if (lines.length === 0) {
      return textResult(
        'list',
        building ? 'There are no widgets yet.' : 'No widget has operations you can call yet.'
      )
    }
    return textResult('list', `<widgets>\n${lines.join('\n')}\n</widgets>`)
  }

  private async describe(
    params: WidgetToolParams,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    const snapshot = widgetStorageOf(widget.id) === 'sqlite' ? readApiSnapshot(widget.id) : null
    if (!snapshot) {
      throw new Error(`Widget "${widget.id}" has no API, so it has no operations to call.`)
    }
    const building = await this.callerBuilds(call)
    const ops = snapshot.ops
      .filter((op) => op.agent !== false || building)
      .map((op) => ({
        name: op.name,
        mode: op.mode,
        ...(op.agent === false ? { screenOnly: true } : {}),
        description: op.description,
        input: op.input,
        ...(op.output !== undefined ? { output: op.output } : {})
      }))
    const access = ACCESS_LABEL[sessionAcl.widgetAccess(this.ctx.sessionId, widget.id)]
    const body = JSON.stringify(
      { id: widget.id, name: widget.name, access, operations: ops },
      null,
      2
    )
    return textResult('describe', body, widget.id)
  }

  private async call(
    toolCallId: string,
    params: WidgetToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    const widget = requireWidget(params.widget)
    const opName = params.op?.trim()
    if (!opName) throw new Error('`op` is required: the operation to call (see "describe").')
    const snapshot = widgetStorageOf(widget.id) === 'sqlite' ? readApiSnapshot(widget.id) : null
    if (!snapshot) {
      throw new Error(`Widget "${widget.id}" has no API, so it has no operations to call.`)
    }
    const dryRun = params.dry_run === true
    const entry = snapshot.ops.find((o) => o.name === opName && (o.agent !== false || dryRun))
    if (!entry) {
      const names = snapshot.ops
        .filter((o) => o.agent !== false || dryRun)
        .map((o) => o.name)
        .join(', ')
      throw new Error(
        `Widget "${widget.id}" has no operation "${opName}". Its operations: ${names}.`
      )
    }
    await this.authorize(entry.mode, widget, 'call', opName, toolCallId, call, signal)
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const actor = agentActorOf(withCallAgent(this.ctx, call))
    let outcome
    let logs: string[]
    try {
      const { result } = await callWidgetOp(
        widget.id,
        opName,
        params.args ?? {},
        { kind: 'agent', sessionId: this.ctx.sessionId, actor, label: actor },
        // 授权按这次读到的读 / 写判的：其间有人重新构建、把它改成了写操作，分发器拒绝而不是照跑
        { dryRun, allowUiOnly: dryRun, expectedMode: entry.mode }
      )
      outcome = result.outcome
      logs = result.logs
    } catch (e) {
      if (e instanceof WidgetApiError) throw new Error(`[${e.code}] ${e.message}`)
      throw e
    }
    const tail = [
      dryRun ? '(dry run: everything it wrote was rolled back)' : '',
      logs.length > 0 ? `<logs>\n${logs.join('\n')}\n</logs>` : ''
    ].filter(Boolean)
    if (!outcome.ok) {
      const { code, message } = outcome.error
      // 参数不对：附上这个操作的 input schema，省一次 describe
      const schema = code === 'invalid_args' ? `\nInput schema: ${JSON.stringify(entry.input)}` : ''
      // handler 意外抛错（不是 ctx.fail 的业务失败）：说清楚是组件的代码出了错
      const head =
        code === 'internal' ? `Widget operation failed: ${message}` : `[${code}] ${message}`
      throw new Error([`${head}${schema}`, ...tail].join('\n'))
    }
    const value = outcome.value === undefined ? 'null' : JSON.stringify(outcome.value, null, 2)
    return textResult('call', [value, ...tail].join('\n'), widget.id)
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
    const result = await previewWidget(widget.id, {
      sizes,
      ...(theme ? { theme } : {}),
      sessionId: this.ctx.sessionId
    })
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
