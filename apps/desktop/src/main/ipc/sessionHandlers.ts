import { dialog } from 'electron'
import { defineHandler } from './registry'
import { windowOf } from './ipcAdapter'
import { sessionService } from '../services/sessionService'
import { closeWatcherIfWorkingDirectory } from '../services/filesWatcherService'
import { chatGateway, operationContext, createClientContext } from '../frontend'
import { isPinned, unpin as unpinPinnedChat } from '../services/pinnedChatService'
import { forkSession } from '../services/sessionFork'
import { sessionAcl } from '../services/acl'
import { listSessionMentions } from '../services/sessionMentions'
import { isPathAccess } from '@shuvix/chat-protocol/sessionAcl'
import type { SessionForkParams } from '@shuvix/chat-protocol/sessionFork'
import type {
  SessionUpdateProjectParams,
  SessionUpdateEnabledToolsParams,
  SessionUpdateKnowledgeBasesParams,
  SessionAclGrantParams,
  SessionAclRemoveParams,
  SessionAclSetAccessParams,
  SessionUpdateTitleParams,
  SessionCreateParams
} from '../types'

/**
 * 会话管理 IPC 处理器
 * 负责参数解析，委托给 SessionService
 */
export function registerSessionHandlers(): void {
  /** 获取所有会话 */
  defineHandler('session:list', () => {
    return sessionService.list()
  })

  /** 创建新会话（笔记本会话：params.notebookPath 非空；聊天会话：params.bot 非空） */
  // Chrome 标签页会话只由 Chrome 前端开（它核对过是哪个浏览器、哪个标签页）—— 渲染层传来的一律滤掉
  defineHandler('session:create', (_ctx, params?: SessionCreateParams) =>
    sessionService.create(params ? { ...params, chromeTab: undefined } : params)
  )

  /** 更新会话标题 */
  defineHandler('session:updateTitle', (_ctx, params: SessionUpdateTitleParams) => {
    sessionService.updateTitle(params.id, params.title)
    return { success: true }
  })

  /** 更新会话模型配置（provider/model） */
  /** 更新会话所属项目 */
  defineHandler('session:updateProject', (_ctx, params: SessionUpdateProjectParams) => {
    sessionService.updateProjectId(params.id, params.projectId)
    return { success: true }
  })

  /**
   * 改扩展能力勾选（mcp:/skill:）。会话已有 Agent 运行时（含创建中 / 关停中）时拒绝、
   * 什么也不写 —— 勾选只在创建 Agent 那一刻读一次。
   */
  defineHandler('session:updateEnabledTools', (_ctx, params: SessionUpdateEnabledToolsParams) => ({
    success: sessionService.updateEnabledTools(params.id, params.enabledTools)
  }))

  /**
   * 改这条会话启用的知识库。与扩展能力不同：**不看有没有运行时** —— 知识库是工具每次调用
   * 现查的，改完下一次调用就生效。
   */
  defineHandler(
    'session:updateKnowledgeBases',
    (_ctx, params: SessionUpdateKnowledgeBasesParams) => ({
      success: sessionService.updateKnowledgeBases(params.id, params.knowledgeBases)
    })
  )

  /** 输入框 @ 会话的候选（除这一条以外、侧栏看得见的会话） */
  defineHandler('session:mentionEntries', (_ctx, params: { sessionId: string }) =>
    listSessionMentions(params.sessionId)
  )

  /** 会话权限表（派生行先按此刻的设置对账；会话种类的行带上目标会话的标题） */
  defineHandler('session:listAcl', (_ctx, id: string) => sessionAcl.entriesForDisplay(id))

  /** 手动授予一条路径（来源 user） */
  defineHandler('session:grantAcl', (_ctx, params: SessionAclGrantParams) => {
    const entry = isPathAccess(params.access)
      ? sessionAcl.grantPath(params.id, params.target, params.access)
      : null
    return { success: entry !== null, entry }
  })

  /** 改一行的访问方式（授予的行与工作目录那一行） */
  defineHandler('session:setAclAccess', (_ctx, params: SessionAclSetAccessParams) => ({
    success:
      isPathAccess(params.access) && sessionAcl.setAccess(params.id, params.entryId, params.access)
  }))

  /** 删一行（只有授予的行） */
  defineHandler('session:removeAclEntry', (_ctx, params: SessionAclRemoveParams) => ({
    success: sessionAcl.remove(params.id, params.entryId)
  }))

  /**
   * 会话 fork：把这条会话复制成一条新会话（整段，或从 `messageId` 那条回复分支），放在它旁边。
   * 被拒（形态不给 / 在忙 / 回复不在）时什么都没建；源会话从不被写
   */
  defineHandler('session:fork', (_ctx, params: SessionForkParams) => forkSession(params))

  /** 获取单个会话（含 workingDirectory） */
  defineHandler('session:getById', (_ctx, id: string) => {
    return sessionService.getById(id) || null
  })

  /** 删除会话（同时清理 Agent 内存实例、消息、HTTP 日志和临时工作目录） */
  defineHandler('session:delete', async (_ctx, id: string) => {
    // 若被删的会话正处于悬浮态，先关闭对应悬浮窗
    if (isPinned(id)) {
      await unpinPinnedChat(id, 'session-deleted')
    }
    // 删除前捕获 workingDirectory，删除后用于关闭 watcher（仅当当前 watcher 监听的就是此目录时）
    // 注：同项目的多个会话共享 workingDirectory，此时不应误关 —— closeWatcherIfWorkingDirectory
    // 只做"路径相同则关"的窄判断；项目目录被多个会话共用时不影响其它会话的后续 scan
    const wd = sessionService.getById(id)?.workingDirectory
    await sessionService.delete(id)
    if (wd) closeWatcherIfWorkingDirectory(wd)
    return { success: true }
  })

  // 注：session:generateTitle 已删除 —— 自动标题改由内置 auto-title hook 驱动
  // （session.prompt-accepted / session.turn-completed 埋点 + titler agent），
  // 该 IPC 本就没有任何渲染端调用方。

  /** 打开文件夹选择对话框（挂在调用方窗口上；没有窗口 → null） */
  defineHandler('dialog:openDirectory', async (ctx) => {
    const win = windowOf(ctx)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  /** 查询指定 session 的所有运行时资源状态 */
  defineHandler('runtime:statuses', (ctx, sessionId: string) =>
    operationContext.run(createClientContext(ctx, sessionId), () =>
      chatGateway.getRuntimeStatuses(sessionId)
    )
  )

  /** 销毁指定运行时资源 */
  defineHandler('runtime:destroy', (ctx, params: { sessionId: string; runtimeId: string }) =>
    operationContext.run(createClientContext(ctx, params.sessionId), () =>
      chatGateway.destroyRuntime(params.sessionId, params.runtimeId)
    )
  )
}
