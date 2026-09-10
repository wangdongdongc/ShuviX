/**
 * knowledge 工具（桌面注册）—— 复用 @shuvix/agent-runtime 的共享 createKnowledgeTool 内核。
 *
 * 桌面只注入端适配：Node fs port、根目录、扫描 / 作用域解析 / 检索（services/knowledge）、
 * 桌面 SecurityContext（写入与文件工具同一道门 —— review-knowledge-writes 两边都覆盖）、
 * 写入者 actor、写后变更管线（投影 + 提交 + 事件）。
 *
 * 不在内置基座档案的工具清单里（一期基础设施：应用层未上线前不改变任何会话的行为）；
 * 内置 knowledge-writer 与用户档案按名解析使用。
 */
import {
  createKnowledgeTool,
  KNOWLEDGE_DESCRIPTION,
  KNOWLEDGE_TOOL_NAME,
  KnowledgeParamsSchema,
  type KnowledgeLogOp
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
  getKnowledgeRoot,
  recordKnowledgeChange,
  resolveSessionScopeTarget,
  scanKnowledge,
  searchKnowledge
} from '../services/knowledge'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { t } from '../i18n'

function logOpOf(op: 'create' | 'update' | 'set-status', status?: string): KnowledgeLogOp {
  if (op === 'create') return 'Creation'
  if (op === 'set-status' && status === 'deprecated') return 'Deprecation'
  return 'Update'
}

export const makeKnowledgeTool = (ctx: ToolContext): ReturnType<typeof createKnowledgeTool> =>
  createKnowledgeTool({
    root: getKnowledgeRoot(),
    port: nodeFileSystemPort,
    security: getDesktopSecurityContext(ctx),
    listConcepts: async () => (await scanKnowledge()).concepts,
    resolveScope: (scope, opts) => resolveSessionScopeTarget(ctx.sessionId, scope, opts),
    search: (query, opts) => searchKnowledge(query, opts),
    actor: () => agentActorOf(ctx),
    now: () => new Date(),
    afterWrite: (e) =>
      recordKnowledgeChange({
        path: e.path,
        op: logOpOf(e.op, e.status),
        title: e.title,
        actor: agentActorOf(ctx)
      }),
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
