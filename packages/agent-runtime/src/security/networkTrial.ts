/**
 * 网络主体规则的解析期试算（2026-10-19）—— 远程访问的规则在求值期出错时，deny / ask 按 fail-safe 算命中，结果是
 * 把这一类请求**全部**拒掉，连这台电脑自己都进不来；而这类错误（读一个请求未必带的头、拼错的属性、对不上的类型）
 * 解析期的语法校验看不出来。所以 `subject.kind` 点名了 `network` 的规则，解析时拿一份样例请求逐个客体类型算一遍，
 * 算出错就给一条软告警（不判非法：样例不代表一切请求）。告警经 write / edit 的写后校验回到 agent 手里，它当场能改
 * （见 shuvixMdWrite.ts）。
 *
 * 样例的主体每个属性都给了值（请求头与 cookie 是空表 —— 读一个具体的头必须先 `'x' in subject.headers`），客体按
 * 宿主上报的形状给齐（policyGate.ts）。
 */
import { evaluateLet, evaluateMatch } from './celMatch'
import { mergeConditions } from './conditions'
import type { PolicyRuleSpec, PolicyVarValue } from './types'

/** 网络点位的客体类型 → 样例客体、缺省 action、经由的工具 */
const SAMPLES: Record<
  string,
  { object: Record<string, unknown>; action: string; tool: { name: string; operation: string } }
> = {
  socket: { object: { type: 'socket' }, action: 'connect', tool: { name: '', operation: '' } },
  request: {
    object: {
      type: 'request',
      method: 'GET',
      path: '/',
      query: {},
      route: 'page',
      scope: 'app',
      access: 'read'
    },
    action: 'request',
    tool: { name: '', operation: '' }
  },
  channel: {
    object: {
      type: 'channel',
      channel: 'session:list',
      group: 'session',
      scope: 'sessions',
      kind: 'invoke',
      access: 'read',
      size: 64,
      args: []
    },
    action: 'invoke',
    tool: { name: '', operation: '' }
  },
  path: {
    object: {
      type: 'path',
      path: '/home/user/notes/a.md',
      requestedPath: '/home/user/notes/a.md',
      displayPath: '/home/user/notes/a.md',
      scope: 'files',
      access: 'read'
    },
    action: 'read',
    tool: { name: 'files', operation: 'read' }
  }
}

const SAMPLE_SUBJECT = {
  kind: 'network',
  agentKind: '',
  profile: '',
  sessionId: '',
  depth: 0,
  address: '192.0.2.10',
  port: 50000,
  localAddress: '192.0.2.1',
  localPort: 7766,
  family: 'ipv4',
  interface: 'en0',
  headers: {},
  cookies: {},
  device: '',
  userAgent: '',
  connection: ''
}

/** 宿主给网络主体的事实变量（与会话无关的那些），样例值 */
const SAMPLE_VARS: Record<string, PolicyVarValue> = {
  home: '/home/user',
  workspace: '',
  toolResultsBase: '/home/user/.shuvix-data/tool_results',
  skillsDirs: ['/home/user/.shuvix/skills'],
  botsDir: '/home/user/.shuvix/bots',
  shuvixConfigDirs: [
    '/home/user/.shuvix/policies',
    '/home/user/.shuvix/agents',
    '/home/user/.shuvix/hooks',
    '/home/user/.shuvix/skills'
  ],
  builtinKnowledgeDir: '/app/knowledge',
  sessionArtifactsDir: '',
  systemDirs: []
}

/**
 * 一条规则在样例网络请求上试算：不点名 `network` 主体、没有 match → 不试，回 null；全部算得出来 → null；
 * 出错 → 一句话（哪个客体类型、错误的第一行）
 */
export function trialNetworkRule(
  rule: PolicyRuleSpec,
  scope: Record<string, string[]> | undefined,
  lets: Record<string, string> | undefined
): string | null {
  if (!rule.match) return null
  const conditions = mergeConditions(scope, rule.conditions)
  if (!conditions?.['subject.kind']?.includes('network')) return null
  const types = (conditions['object.type'] ?? Object.keys(SAMPLES)).filter((t) =>
    Object.hasOwn(SAMPLES, t)
  )
  const letValues: Record<string, unknown> = {}
  for (const [name, expr] of Object.entries(lets ?? {})) {
    try {
      letValues[name] = evaluateLet(expr, SAMPLE_VARS, '/')
    } catch (error) {
      return `let '${name}' fails on the sample variables (${firstLine(error)})`
    }
  }
  for (const type of types) {
    const sample = SAMPLES[type]
    const action = conditions.action?.find((a) => a !== '*') ?? sample.action
    try {
      evaluateMatch(
        rule.match,
        {
          subject: SAMPLE_SUBJECT,
          action,
          tool: sample.tool,
          object: sample.object,
          env: { host: 'desktop', platform: '' },
          vars: SAMPLE_VARS,
          ...letValues
        },
        '/'
      )
    } catch (error) {
      return `the match fails on a sample ${type} request (${firstLine(error)})`
    }
  }
  return null
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0].trim()
}
