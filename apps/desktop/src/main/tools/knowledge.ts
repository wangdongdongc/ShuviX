/**
 * knowledge 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createKnowledgeTool 内核。
 *
 * 检索、盘点、取原文、校验，加**新建条目**（担保元数据形状）。改动条目不经它 —— 走普通
 * `edit`，由写钩子刷新 `generated`、由 fileToolDeps 的 onFileChange 接同一条变更管线。
 *
 * 桌面只注入端适配：Node fs port、会话 → bundle 解析、该 bundle 的扫描与检索
 * （services/knowledge）、桌面 SecurityContext（与文件工具同一道门）、写入者 actor、
 * 新建后的变更管线（投影 + 提交 + 事件）。
 *
 * 作用域就是一个 bundle —— 本会话所属项目的那一个，所以工具没有 `scope` 参数。
 *
 * 不在内置基座档案的工具清单里（应用层未上线前不改变任何会话的行为）；
 * 内置 knowledge-writer 与用户档案按名解析使用。
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
  locateBundle,
  recordKnowledgeChange,
  scanBundle,
  searchBundle,
  sessionBundle
} from '../services/knowledge'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { t } from '../i18n'

/** 工具只认 bundle 的绝对路径；宿主这边按它反查 bundle id（`projects/<slug>`） */
function bundleIdOf(dir: string): string | null {
  return locateBundle(`${dir.replace(/[/\\]+$/, '')}/index.md`)?.bundle ?? null
}

export const makeKnowledgeTool = (ctx: ToolContext): ReturnType<typeof createKnowledgeTool> =>
  createKnowledgeTool({
    port: nodeFileSystemPort,
    security: getDesktopSecurityContext(ctx),
    resolveBundle: (opts) => sessionBundle(ctx.sessionId, opts),
    scan: async (dir) => {
      const located = bundleIdOf(dir)
      if (!located) return { files: [], concepts: [] }
      const { files, concepts } = await scanBundle(located)
      return { files, concepts }
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
        title: e.title,
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
