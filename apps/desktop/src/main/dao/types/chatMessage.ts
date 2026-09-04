/**
 * 群聊会话的消息行（表 `chat_messages`，迁移 v16）。
 *
 * 只服务**聊天会话**（`settings.bots` 非空的无根会话）；有根会话的转写仍在 JSONL 会话树里。
 * 一个会话在创建那一刻就定死是哪一种，两套存储互斥不相交。
 *
 * 为什么是表而不是会话树：群聊消息是**平的** —— 没有分叉、没有工具块/思考块、没有压缩
 * 切点，会话树的能力一个都用不上；而「谁说的」在树的数据模型里只能靠署名侧车那种补丁
 * 表达（消息前多写一条 custom entry，投影时靠「紧邻」配对）。一列 `authorKind` + `botName`
 * 取代整套机制，顺带把「两条 entry 之间不得有 await 逃逸点」那条纪律连同它的异步互斥
 * 一起消掉：一条消息就是一行，seq 在同步事务里分配。
 */

/** 发言人类别 */
export type ChatAuthorKind = 'user' | 'bot' | 'system'

/** 附件描述符 —— 字节落盘，行里只存指向它的引用（base64 进表会让全量读变得昂贵） */
export interface ChatAttachmentRef {
  /** 相对 `<userData>/data/chat-attachments/<sessionId>/` 的文件名 */
  file: string
  mimeType: string
  /** 字节数（UI 与排错用；不为它回读文件） */
  size?: number
}

/** 群聊消息行 */
export interface ChatMessageRow {
  /** 消息 id（uuidv4，随仓内惯例）；广播与 UI 共用。**排序一律用 seq**，不靠 id */
  id: string
  sessionId: string
  /** 会话内单调；排序、回退区间、笔记增量窗都用它。事务内分配 */
  seq: number
  authorKind: ChatAuthorKind
  /** bot 的身份键（`authorKind === 'bot'`） */
  botName?: string
  /** **落库当时**的显示名 —— bot md 被删或改名，历史消息永不裂 */
  displayName?: string
  /** markdown：模型可见的唯一权威（结构化回复由 botReplyToMarkdown 投影而来） */
  content: string
  /** 意图段判定（reply / task / clarify）—— clarify 回连的判定材料 */
  decision?: string
  /** BotReply 结构化原文，仅供 UI 双形态渲染 */
  reply?: string
  /** 用户消息的标记态原文字典（内联 token） */
  inlineTokens?: string
  /** 附件描述符数组 */
  attachments?: ChatAttachmentRef[]
  /** 失败 / 降级通告（UI 上错误色气泡） */
  isError?: boolean
  /** 触发它的那条消息（bot 回复指向它回应的那条用户消息） */
  replyToId?: string
  /**
   * 遗留列（v16 的 bot→bot 接力护栏）：接力已取消，新写入不再填它，读侧照旧原样带出。
   * 留着列而不做迁移 —— SQLite 删列不值一次 user_version。
   */
  rootId?: string
  /** 遗留列，同上；新写入恒为 0 */
  hop: number
  createdAt: number
}

/** 新增一条消息时调用方要给的字段（id / seq / createdAt 由 DAO 分配；hop 缺省 0） */
export type ChatMessageInsert = Omit<ChatMessageRow, 'id' | 'seq' | 'createdAt' | 'hop'> & {
  /** 显式指定 id（极少用：需要先拿到 id 再写内容时）；缺省由 DAO 生成 */
  id?: string
  hop?: number
}
