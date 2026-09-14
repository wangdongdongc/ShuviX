/**
 * knowledge 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createKnowledgeTool 内核。
 *
 * 检索、盘点、取原文、校验，加**新建条目**（担保元数据形状）。改动条目不经它 —— 走普通
 * `edit`，由写钩子刷新 `generated`、由 fileToolDeps 的 onFileChange 接同一条变更管线。
 *
 * 桌面只注入端适配：Node fs port、base 的解析与列举（`project` = 根会话所属项目的库，其余名字 =
 * `~/.shuvix/knowledge/` 下的用户库，所有会话都看得见）、bundle 的扫描与检索（services/knowledge）、
 * 桌面 SecurityContext（与文件工具同一道门）、写入者 actor、新建后的变更管线（提交 + 事件）。
 */
import {
  createKnowledgeTool,
  KNOWLEDGE_DESCRIPTION,
  KNOWLEDGE_TOOL_NAME,
  KnowledgeParamsSchema
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  agentActorOf,
  getDesktopSecurityContext,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import {
  listBases,
  locateBundle,
  recordKnowledgeChange,
  resolveBase,
  scanBundle,
  searchBundle
} from '../services/knowledge'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { t } from '../i18n'

/**
 * 工具只认 bundle 的绝对路径；宿主这边按它反查 bundle id（`projects/<id>` / `knowledge/<库名>`）。
 * locateBundle 收的是文件路径，拼上去的文件名只是个探针
 */
function bundleIdOf(dir: string): string | null {
  return locateBundle(`${dir.replace(/[/\\]+$/, '')}/probe.md`)?.bundle ?? null
}

export const makeKnowledgeTool = (ctx: ToolContext): ReturnType<typeof createKnowledgeTool> =>
  createKnowledgeTool({
    port: nodeFileSystemPort,
    security: getDesktopSecurityContext(ctx),
    // ctx.sessionId 恒为根会话 id（派生 agent 按根会话解析）
    resolveBase: (base) => resolveBase(ctx.sessionId, base),
    listBases: () => listBases(ctx.sessionId),
    scan: async (dir) => {
      const located = bundleIdOf(dir)
      if (!located) return { files: [], concepts: [], notes: [] }
      const { files, concepts, notes } = await scanBundle(located)
      return { files, concepts, notes }
    },
    search: (query, opts) => {
      const located = bundleIdOf(opts.bundleDir)
      return located ? searchBundle(located, query, { limit: opts.limit }) : Promise.resolve([])
    },
    actor: () => agentActorOf(ctx),
    now: () => new Date(),
    // 工具自己落盘（不经文件工具），所以变更管线要自己记一笔；`edit` 那条路由 onFileChange 接
    afterWrite: (e) => {
      const located = bundleIdOf(e.bundleDir)
      if (!located) return
      recordKnowledgeChange({
        bundle: located,
        path: e.path,
        op: 'Creation',
        actor: agentActorOf(ctx)
      })
    },
    abortError: TOOL_ABORTED,
    label: t(BUILTIN_TOOL_PRESENTATIONS[KNOWLEDGE_TOOL_NAME].labelKey)
  })

registerBuiltinTool({
  name: KNOWLEDGE_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[KNOWLEDGE_TOOL_NAME].labelKey),
  getHint: () => t('tool.knowledgeHint'),
  factory: (ctx) => makeKnowledgeTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[KNOWLEDGE_TOOL_NAME].presentation,
  describe: () => ({
    description: KNOWLEDGE_DESCRIPTION,
    parameters: KnowledgeParamsSchema
  })
})
