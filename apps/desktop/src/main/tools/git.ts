/**
 * git 工具（桌面注册壳）—— 统一 multiplex 本地 git 工具，实现共享自 @shuvix/agent-runtime
 * （isomorphic-git 单后端，与扩展端行为一致）。仅本地操作；桌面注入 node:fs 与
 * 会话 workingDirectory，author 回退读全局 gitconfig。
 *
 * 询问：不随「工作目录内写入需询问」一起收紧（见 makeDesktopResolveDir 的理由），
 * 改为按 action 精确拦截 —— init / restore / checkout --force / branch -d 要用户点头。
 */
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createGitTool,
  buildGitToolDescription,
  buildGitParamsSchema,
  GIT_TOOL_NAME,
  type GitAskReason,
  type GitAuthor,
  type GitEnv,
  type GitFsClient
} from '@shuvix/agent-runtime'
import { t } from '../i18n'
import {
  TOOL_ABORTED,
  getDesktopSecurityContext,
  resolveProjectConfig,
  assertReadAllowed,
  assertWriteAllowed,
  isPathWithinWorkspace,
  type ToolContext
} from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'

/** 提取 gitconfig 文本 [user] 段的 name/email（简易 ini；不处理 include/includeIf 指令） */
function parseUserSection(content: string): Partial<GitAuthor> {
  const out: Partial<GitAuthor> = {}
  let inUser = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inUser = /^\[user\]$/i.test(line)
      continue
    }
    if (!inUser || line.startsWith('#') || line.startsWith(';')) continue
    const m = /^(name|email)\s*=\s*(.+)$/i.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (m[1].toLowerCase() === 'name') out.name ??= value
    else out.email ??= value
  }
  return out
}

/** commit author 回退：~/.gitconfig 优先，其次 $XDG_CONFIG_HOME/git/config（对齐 git 优先级） */
async function globalGitAuthor(): Promise<GitAuthor | undefined> {
  const xdgBase = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const candidates = [join(homedir(), '.gitconfig'), join(xdgBase, 'git', 'config')]
  const merged: Partial<GitAuthor> = {}
  for (const file of candidates) {
    try {
      const user = parseUserSection(await nodeFs.promises.readFile(file, 'utf8'))
      merged.name ??= user.name
      merged.email ??= user.email
    } catch {
      // 文件不存在/不可读：继续下一个候选
    }
    if (merged.name && merged.email) break
  }
  return merged.name && merged.email ? (merged as GitAuthor) : undefined
}

function createDesktopGitEnv(sessionId: string): GitEnv {
  return {
    fs: nodeFs as unknown as GitFsClient,
    dir: resolveProjectConfig(sessionId).workingDirectory,
    resolveAuthorFallback: globalGitAuthor
  }
}

/**
 * "dir" 参数解析：相对工作目录归一；工作目录内直接放行，
 * 外部路径按该 action 的读/写语义走路径询问（拒绝时 throw，文本回流给模型）。
 */
function makeDesktopResolveDir(ctx: ToolContext) {
  return async (
    requested: string,
    opts: { action: string; mutates: boolean; toolCallId: string }
  ): Promise<string> => {
    const config = resolveProjectConfig(ctx.sessionId)
    const abs = resolve(config.workingDirectory, requested)
    // git 豁免「工作目录内写入需询问」那条规则：仓库操作不是单文件写入，套不进 diff 预览，
    // 而 add/commit 这类高频且可逆的操作逐条弹会把询问淹没。真正该拦的按 action 精确处理
    // （见 GIT_OPS 的 askReason 与下面的 askOp）。目录外仍按读/写语义走路径询问。
    if (isPathWithinWorkspace(abs, config.workingDirectory)) return abs
    const guard = opts.mutates ? assertWriteAllowed : assertReadAllowed
    await guard(ctx, config, opts.toolCallId, GIT_TOOL_NAME, abs, requested)
    return abs
  }
}

/**
 * 逐操作安全评估 —— 每个 git 工具操作都上报（gitAction/force/delete 是客体属性，
 * 哪些组合要询问写在内置 git-safety 策略的 match 里；autoAllow 走 consent 层）。
 * i18n 询问文案留在桌面 PEP（description 注入，破坏性操作才有原因码）。
 */
function makeDesktopAskOp(ctx: ToolContext) {
  return async (info: {
    action: string
    reason: GitAskReason | null
    force: boolean
    delete: boolean
    command: string
    toolCallId: string
  }): Promise<void> => {
    await getDesktopSecurityContext(ctx).enforceGitOp(
      { gitAction: info.action, command: info.command, force: info.force, delete: info.delete },
      {
        toolCallId: info.toolCallId,
        toolName: GIT_TOOL_NAME,
        description: info.reason ? t(`tool.gitAsk.${info.reason}`) : undefined,
        abortError: TOOL_ABORTED,
        // fail-closed：ask 且无询问通道 → 拒绝（桌面 root/派生 agent 恒有通道，
        // 无前端时 harness 层已即时 cancel；此分支只防御未来的无通道调用方）
        missingChannel: 'deny'
      }
    )
  }
}

registerBuiltinTool({
  name: GIT_TOOL_NAME,
  group: 'general',
  // 不在内置 default 档案的工具清单里（用户可覆盖 ~/.shuvix/agents/default.md 加入主会话）；
  // 子代理白名单（如 wiki curator）按名解析不受此限
  getLabel: () => t('tool.gitLabel'),
  getHint: () => t('tool.gitHint'),
  factory: (ctx) =>
    createGitTool({
      // 每次 execute 取最新 workingDirectory（会话配置可变）
      getEnv: () => createDesktopGitEnv(ctx.sessionId),
      resolveDir: makeDesktopResolveDir(ctx),
      askOp: makeDesktopAskOp(ctx),
      abortError: TOOL_ABORTED,
      label: t('tool.gitLabel')
    }),
  presentation: {
    icon: 'GitBranch',
    iconColor: '#f59e0b'
  },
  describe: () => ({
    description: buildGitToolDescription(),
    parameters: buildGitParamsSchema()
  })
})
