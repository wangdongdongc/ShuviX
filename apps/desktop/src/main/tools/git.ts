/**
 * git 工具（桌面注册壳）—— 统一 multiplex 本地 git 工具，实现共享自 @shuvix/agent-runtime
 * （isomorphic-git 单后端，与扩展端行为一致）。仅本地操作；桌面注入 node:fs 与
 * 会话 workingDirectory，author 回退读全局 gitconfig。
 *
 * 审批：不随「工作目录内写入需审批」一起收紧（见 makeDesktopResolveDir 的理由），
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
  type GitApprovalReason,
  type GitAuthor,
  type GitEnv,
  type GitFsClient
} from '@shuvix/agent-runtime'
import { t } from '../i18n'
import { sessionDao } from '../dao/sessionDao'
import {
  TOOL_ABORTED,
  resolveProjectConfig,
  assertReadApproved,
  assertWriteApproved,
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
 * 外部路径按该 action 的读/写语义走路径审批（拒绝时 throw，文本回流给模型）。
 */
function makeDesktopResolveDir(ctx: ToolContext) {
  return async (
    requested: string,
    opts: { action: string; mutates: boolean; toolCallId: string }
  ): Promise<string> => {
    const config = resolveProjectConfig(ctx.sessionId)
    const abs = resolve(config.workingDirectory, requested)
    // git 豁免「工作目录内写入需审批」那条规则：仓库操作不是单文件写入，套不进 diff 预览，
    // 而 add/commit 这类高频且可逆的操作逐条弹会把审批淹没。真正该拦的按 action 精确处理
    // （见 GIT_OPS 的 approval 与下面的 approveOp）。目录外仍按读/写语义走路径审批。
    if (isPathWithinWorkspace(abs, config.workingDirectory)) return abs
    const guard = opts.mutates ? assertWriteApproved : assertReadApproved
    await guard(ctx, config, opts.toolCallId, GIT_TOOL_NAME, abs, requested)
    return abs
  }
}

/**
 * 逐操作审批 —— 只有 GIT_OPS 声明了 approval 的调用会走到这里
 * （init 建仓 / restore 与 checkout --force 吞改动 / branch -d 删分支）。
 * 与 bash 一致：会话级「免审批」是唯一豁免；无前端通道时放行（保持无 UI 环境可用）。
 */
function makeDesktopApproveOp(ctx: ToolContext) {
  return async (info: {
    action: string
    reason: GitApprovalReason
    command: string
    toolCallId: string
  }): Promise<void> => {
    if (!ctx.requestUserInput) return
    if (sessionDao.pickSettings(ctx.sessionId, ['autoApprove'])?.autoApprove) return

    const response = await ctx.requestUserInput({
      id: info.toolCallId,
      kind: 'approval',
      toolName: GIT_TOOL_NAME,
      command: info.command,
      description: t(`tool.gitApproval.${info.reason}`),
      createdAt: Date.now()
    })
    if (response.kind === 'cancel') throw new Error(TOOL_ABORTED)
    if (response.kind === 'other') {
      throw new Error(
        `User declined ${info.command} and provided feedback instead: ${response.text}`
      )
    }
    if (response.kind !== 'approval' || !response.approved) {
      throw new Error(
        (response.kind === 'approval' && response.reason) || `User denied ${info.command}`
      )
    }
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
      approveOp: makeDesktopApproveOp(ctx),
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
