/**
 * MCP 服务器：第一批开放给 agent 的设置通道（docs/mcp-config-compat-design.md §3）。
 *
 * agent 拿到的是用户贴来的任何写法（README 片段、别家的 mcp.json、TOML、`claude mcp add` 一行命令），由它自己翻成这里的字段；
 * ShuviX 不解析别家的格式（用户裁定 2026-11-08）。
 *
 * 秘密：env / headers 的值多半是 key。agent 手里的占位符在工具参数里已经换回真值（wrapToolOutput），留空的由用户在卡上填；
 * 给模型看的结果里一律只说有没有值。远程服务器的认证头照旧用 `{{VAR}}` 模板引用 env（McpManager 现成的替换），
 * 这样卡上要填的只是那串 token 本身。
 */
import { Type, type TSchema } from 'typebox'
import type { AskField } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  McpServer,
  McpServerAddParams,
  McpServerUpdateParams
} from '@shuvix/chat-protocol/types/mcp'
import { safeExtensionName } from '@shuvix/chat-protocol/toolSelection'
import { mcpDao } from '../dao/mcpDao'
import { mcpService } from './mcpService'
import { t } from '../i18n'
import type { AgentChannel, AgentChannelCard } from './agentChannels'

/** 回执里连一次的上限：第一次 `npx` / `uvx` 要下载，可以慢一些（同 tool_search） */
const RECEIPT_CONNECT_TIMEOUT_MS = 30_000

const ENV_FIELD_PREFIX = 'env.'
const HEADER_FIELD_PREFIX = 'header.'

// ─── 参数结构（给模型看的，英文） ───

const stringMap = (description: string): TSchema =>
  Type.Record(Type.String(), Type.String(), { description })
const nullableStringMap = (description: string): TSchema =>
  Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), { description })

const NAME_DESCRIPTION =
  'Server name. It becomes the prefix of its tool names (mcp__<name>__<tool>), so keep it short: letters, digits, - and _. It must be unique, must not contain "__" and must not start with "widget-".'

const ENV_DESCRIPTION =
  'Environment variables. Put secrets here, as the placeholder you hold or as an empty string: the user types empty ones on the approval card, and you never see them.'

const HEADERS_DESCRIPTION =
  'HTTP headers (type http). To put a secret in a header, reference an env entry, e.g. {"Authorization": "Bearer {{GITHUB_TOKEN}}"} with env {"GITHUB_TOKEN": ""}.'

const AddParams = Type.Object(
  {
    name: Type.String({ description: NAME_DESCRIPTION }),
    type: Type.Union([Type.Literal('stdio'), Type.Literal('http')], {
      description:
        'stdio: ShuviX starts a local command. http: a remote server URL (Streamable HTTP; servers that only speak the older SSE transport are found automatically).'
    }),
    command: Type.Optional(Type.String({ description: 'stdio: the executable, e.g. "npx".' })),
    args: Type.Optional(Type.Array(Type.String(), { description: 'stdio: its arguments.' })),
    cwd: Type.Optional(Type.String({ description: 'stdio: absolute working folder (optional).' })),
    env: Type.Optional(stringMap(ENV_DESCRIPTION)),
    url: Type.Optional(Type.String({ description: 'http: the server URL.' })),
    headers: Type.Optional(stringMap(HEADERS_DESCRIPTION))
  },
  { additionalProperties: false }
)

const UpdateParams = Type.Object(
  {
    name: Type.String({ description: 'The server to change (its current name).' }),
    newName: Type.Optional(Type.String({ description: 'Rename it. ' + NAME_DESCRIPTION })),
    type: Type.Optional(Type.Union([Type.Literal('stdio'), Type.Literal('http')])),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String(), { description: 'Replaces all arguments.' })),
    cwd: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: 'null removes it.' })
    ),
    env: Type.Optional(
      nullableStringMap(
        'Merged by key into what is there: a value replaces that key, null removes it, keys you leave out stay as they are (you cannot see their values). An empty string is typed by the user on the card.'
      )
    ),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(nullableStringMap('Merged by key, like env.')),
    enabled: Type.Optional(
      Type.Boolean({ description: 'false keeps the server but no session can turn it on.' })
    )
  },
  { additionalProperties: false }
)

const NameParams = Type.Object({ name: Type.String() }, { additionalProperties: false })

type AddArgs = {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

type UpdateArgs = {
  name: string
  newName?: string
  type?: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string | null
  env?: Record<string, string | null>
  url?: string
  headers?: Record<string, string | null>
  enabled?: boolean
}

type NameArgs = { name: string }

// ─── 小工具 ───

function parseObject(json: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function stringRecord(json: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseObject(json))) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function stringArray(json: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json || '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 地址里的账号密码与 query 的值打码：远程服务器的地址里常带 token */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, '***')
    // URLSearchParams 会把 *** 编码成 %2A%2A%2A：给人看、给模型看都换回来
    return parsed.toString().replace(/%2A%2A%2A/g, '***')
  } catch {
    return url.replace(/([?&][^=&#]+=)[^&#]*/g, '$1***')
  }
}

/** 键 → 有没有值（给模型看的 env / headers） */
function presence(record: Record<string, string>): Record<string, 'set' | 'empty'> {
  const out: Record<string, 'set' | 'empty'> = {}
  for (const [key, value] of Object.entries(record)) out[key] = value.trim() ? 'set' : 'empty'
  return out
}

function findByName(name: string): McpServer {
  const server = mcpDao.findByName(name.trim())
  if (!server) {
    throw new Error(
      `No MCP server named "${safeExtensionName(name)}". Call action "call" on mcp:list to see the names.`
    )
  }
  return server
}

function cwdOf(server: McpServer): string | undefined {
  const cwd = parseObject(server.metadata).cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/** 卡上一行 env / headers：键名，有值的写「已填」，空的写「你来填」；值从不上卡 */
function keysRow(record: Record<string, string | null>): string {
  return Object.entries(record)
    .map(([key, value]) =>
      value === null
        ? t('agentApi.cardRemoved', { key })
        : value.trim()
          ? t('agentApi.cardKeySet', { key })
          : t('agentApi.cardKeyToFill', { key })
    )
    .join(', ')
}

/** env / headers 里留空的那些 → 卡上要填的项 */
function emptyFields(
  record: Record<string, string | null> | undefined,
  prefix: string,
  label: (key: string) => string
): AskField[] {
  return Object.entries(record ?? {})
    .filter(([, value]) => value !== null && value.trim() === '')
    .map(([key]) => ({ key: `${prefix}${key}`, label: label(key), secret: true, required: true }))
}

function fillValues<R extends Record<string, string | null>>(
  record: R | undefined,
  prefix: string,
  values: Record<string, string>
): R | undefined {
  if (!record) return record
  const out: Record<string, string | null> = { ...record }
  for (const key of Object.keys(out)) {
    const value = values[`${prefix}${key}`]
    if (typeof value === 'string' && out[key] !== null) out[key] = value.trim()
  }
  return out as R
}

function fieldsOfRecords(
  env: Record<string, string | null> | undefined,
  headers: Record<string, string | null> | undefined
): AskField[] {
  return [
    ...emptyFields(env, ENV_FIELD_PREFIX, (key) => key),
    ...emptyFields(headers, HEADER_FIELD_PREFIX, (key) => t('agentApi.cardHeaderField', { key }))
  ]
}

/** 加完 / 改完连一次：连上了回工具名，连不上回原因（McpManager 已经把 stderr 末尾拼进去了） */
async function connectReceipt(server: McpServer): Promise<Record<string, unknown>> {
  if (server.isEnabled !== 1) return { connected: false, note: 'The server is disabled.' }
  const result = await mcpService.connect(server.id, { timeoutMs: RECEIPT_CONNECT_TIMEOUT_MS })
  if (!result.ok) {
    return {
      connected: false,
      error: result.error ?? mcpService.getError(server.id) ?? 'unknown error',
      ...(server.type === 'http'
        ? {
            note: 'If the error says 401 or 403 and the server signs users in through a browser (OAuth), ShuviX cannot connect to it yet; header-based keys work.'
          }
        : {})
    }
  }
  const tools = mcpService
    .getServerToolInfos(server.id)
    .map((tool) => tool.name.replace(/^mcp__.*?__/, ''))
  return {
    connected: true,
    tools,
    next: `To use it in this session, turn it on with tool_search (query "${safeExtensionName(server.name)}"); the user approves that too.`
  }
}

function handlerOutcome(result: unknown): { success: boolean; id?: string; error?: string } {
  return typeof result === 'object' && result !== null
    ? (result as { success: boolean; id?: string; error?: string })
    : { success: false, error: 'unexpected result' }
}

function sourceRows(
  type: string,
  command: string,
  args: string[],
  url: string
): AgentChannelCard['rows'] {
  return type === 'http'
    ? [{ label: t('agentApi.cardUrl'), value: maskUrl(url) }]
    : [{ label: t('agentApi.cardCommand'), value: [command, ...args].join(' ') }]
}

// ─── 通道 ───

export const mcpList: AgentChannel<Record<string, never>> = {
  channel: 'mcp:list',
  summary:
    "List the user's MCP servers: how each one starts or where it connects, which env and header keys have values (never the values), whether it is enabled, and the last connection error.",
  params: Type.Object({}, { additionalProperties: false }),
  // 表上是 admin（返回值带 key）；这条路把值都打了码，只剩读
  access: 'read',
  card: () => ({ title: t('agentApi.mcpListTitle'), rows: [] }),
  toHandlerArgs: () => [],
  async present(result) {
    const servers = Array.isArray(result)
      ? (result as Array<McpServer & { status?: string; error?: string; toolCount?: number }>)
      : []
    return servers.map((server) => {
      if (server.isBuiltin === 1 || server.type === 'inproc') {
        return {
          name: server.name,
          builtin: true,
          enabled: server.isEnabled === 1,
          note: 'Built in; not changed here.'
        }
      }
      const cwd = cwdOf(server)
      const env = presence(stringRecord(server.env))
      const headers = presence(stringRecord(server.headers))
      return {
        name: server.name,
        type: server.type,
        enabled: server.isEnabled === 1,
        ...(server.type === 'stdio'
          ? { command: server.command, args: stringArray(server.args), ...(cwd ? { cwd } : {}) }
          : { url: maskUrl(server.url) }),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        status: server.status,
        ...(server.error ? { error: server.error } : {}),
        tools: server.toolCount ?? 0
      }
    })
  }
}

export const mcpGetTools: AgentChannel<NameArgs> = {
  channel: 'mcp:getTools',
  summary: 'The tools one MCP server reported the last time it connected (names and first lines).',
  params: NameParams,
  card: (args) => ({ title: t('agentApi.mcpGetToolsTitle', { name: args.name }), rows: [] }),
  toHandlerArgs: (args) => [findByName(args.name).id],
  async present(result) {
    const tools = Array.isArray(result)
      ? (result as Array<{ name: string; description?: string }>)
      : []
    return tools.map((tool) => ({
      name: tool.name.replace(/^mcp__.*?__/, ''),
      description: (tool.description ?? '').trim().split(/\r?\n/)[0].slice(0, 200)
    }))
  }
}

export const mcpAdd: AgentChannel<AddArgs> = {
  channel: 'mcp:add',
  summary:
    "Add an MCP server to the user's settings, translated from whatever the user gave you (a README snippet, another app's config, a command line). Every session can then turn it on. ShuviX connects once right away and returns its tools or the error.",
  params: AddParams,
  fieldsOf: (args) => fieldsOfRecords(args.env, args.headers),
  withValues: (args, values) => ({
    ...args,
    env: fillValues(args.env, ENV_FIELD_PREFIX, values),
    headers: fillValues(args.headers, HEADER_FIELD_PREFIX, values)
  }),
  card(args) {
    const rows: AgentChannelCard['rows'] = [
      { label: t('agentApi.cardName'), value: args.name },
      ...sourceRows(args.type, args.command ?? '', args.args ?? [], args.url ?? '')
    ]
    if (args.cwd) rows.push({ label: t('agentApi.cardCwd'), value: args.cwd })
    if (args.env && Object.keys(args.env).length > 0) {
      rows.push({ label: t('agentApi.cardEnv'), value: keysRow(args.env) })
    }
    if (args.headers && Object.keys(args.headers).length > 0) {
      rows.push({ label: t('agentApi.cardHeaders'), value: keysRow(args.headers) })
    }
    return { title: t('agentApi.mcpAddTitle', { name: args.name }), rows }
  },
  toHandlerArgs(args) {
    if (args.type === 'stdio' && !args.command?.trim()) {
      throw new Error('A stdio server needs "command".')
    }
    if (args.type === 'http' && !args.url?.trim()) throw new Error('An http server needs "url".')
    const params: McpServerAddParams = {
      name: args.name,
      type: args.type,
      ...(args.type === 'stdio'
        ? {
            command: args.command?.trim() ?? '',
            args: args.args ?? [],
            ...(args.cwd ? { cwd: args.cwd } : {})
          }
        : { url: args.url?.trim() ?? '', headers: args.headers ?? {} }),
      env: args.env ?? {}
    }
    return [params]
  },
  async present(result, args) {
    const outcome = handlerOutcome(result)
    if (!outcome.success || !outcome.id)
      throw new Error(outcome.error ?? 'The server was not added.')
    const server = mcpDao.findById(outcome.id)
    if (!server) return { added: args.name }
    return { added: server.name, ...(await connectReceipt(server)) }
  }
}

export const mcpUpdate: AgentChannel<UpdateArgs> = {
  channel: 'mcp:update',
  summary:
    "Change one of the user's MCP servers (only the fields you pass). env and headers are merged by key. ShuviX reconnects once and returns its tools or the error. Sessions that have it on use the new settings from their next connection.",
  params: UpdateParams,
  fieldsOf: (args) => fieldsOfRecords(args.env, args.headers),
  withValues: (args, values) => ({
    ...args,
    env: fillValues(args.env, ENV_FIELD_PREFIX, values),
    headers: fillValues(args.headers, HEADER_FIELD_PREFIX, values)
  }),
  card(args) {
    const server = mcpDao.findByName(args.name.trim())
    const rows: AgentChannelCard['rows'] = [{ label: t('agentApi.cardName'), value: args.name }]
    const change = (label: string, before: string, after: string): void => {
      if (before !== after) rows.push({ label, value: `${before || '—'} → ${after || '—'}` })
    }
    if (args.newName !== undefined) change(t('agentApi.cardRename'), args.name, args.newName)
    if (server) {
      if (args.type !== undefined) change(t('agentApi.cardType'), server.type, args.type)
      if (args.command !== undefined || args.args !== undefined) {
        change(
          t('agentApi.cardCommand'),
          [server.command, ...stringArray(server.args)].join(' '),
          [args.command ?? server.command, ...(args.args ?? stringArray(server.args))].join(' ')
        )
      }
      if (args.url !== undefined)
        change(t('agentApi.cardUrl'), maskUrl(server.url), maskUrl(args.url))
      if (args.cwd !== undefined) change(t('agentApi.cardCwd'), cwdOf(server) ?? '', args.cwd ?? '')
    }
    if (args.env && Object.keys(args.env).length > 0) {
      rows.push({ label: t('agentApi.cardEnv'), value: keysRow(args.env) })
    }
    if (args.headers && Object.keys(args.headers).length > 0) {
      rows.push({ label: t('agentApi.cardHeaders'), value: keysRow(args.headers) })
    }
    if (args.enabled !== undefined) {
      rows.push({
        label: t('agentApi.cardEnabled'),
        value: args.enabled ? t('agentApi.cardOn') : t('agentApi.cardOff')
      })
    }
    return { title: t('agentApi.mcpUpdateTitle', { name: args.name }), rows }
  },
  toHandlerArgs(args) {
    const server = findByName(args.name)
    const builtin = server.isBuiltin === 1 || server.type === 'inproc'
    if (
      builtin &&
      (args.newName !== undefined ||
        args.type !== undefined ||
        args.command !== undefined ||
        args.args !== undefined ||
        args.url !== undefined ||
        args.cwd !== undefined)
    ) {
      throw new Error(
        `"${safeExtensionName(server.name)}" is built in: only env, headers and enabled can change.`
      )
    }
    const merge = (
      current: Record<string, string>,
      patch: Record<string, string | null> | undefined
    ): Record<string, string> | undefined => {
      if (!patch) return undefined
      const next = { ...current }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key]
        else next[key] = value
      }
      return next
    }
    const env = merge(stringRecord(server.env), args.env)
    const headers = merge(stringRecord(server.headers), args.headers)
    const params: McpServerUpdateParams = {
      id: server.id,
      ...(args.newName !== undefined ? { name: args.newName } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.command !== undefined ? { command: args.command.trim() } : {}),
      ...(args.args !== undefined ? { args: args.args } : {}),
      ...(args.url !== undefined ? { url: args.url.trim() } : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd ?? '' } : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
      ...(args.enabled !== undefined ? { isEnabled: args.enabled } : {})
    }
    return [params]
  },
  async present(result, args) {
    const outcome = handlerOutcome(result)
    if (!outcome.success) throw new Error(outcome.error ?? 'The server was not changed.')
    const server = mcpDao.findByName((args.newName ?? args.name).trim())
    if (!server) return { changed: args.newName ?? args.name }
    if (server.isBuiltin === 1 || server.type === 'inproc') return { changed: server.name }
    return { changed: server.name, ...(await connectReceipt(server)) }
  }
}

export const mcpDelete: AgentChannel<NameArgs> = {
  channel: 'mcp:delete',
  summary:
    "Remove one of the user's MCP servers, with its saved keys. Sessions that have it on lose its tools.",
  params: NameParams,
  card(args) {
    const server = mcpDao.findByName(args.name.trim())
    return {
      title: t('agentApi.mcpDeleteTitle', { name: args.name }),
      rows: server
        ? [
            { label: t('agentApi.cardName'), value: server.name },
            ...sourceRows(server.type, server.command, stringArray(server.args), server.url)
          ]
        : [{ label: t('agentApi.cardName'), value: args.name }]
    }
  },
  toHandlerArgs: (args) => [findByName(args.name).id],
  async present(result, args) {
    const outcome = handlerOutcome(result)
    if (!outcome.success) throw new Error(outcome.error ?? 'The server was not removed.')
    return { removed: args.name }
  }
}
