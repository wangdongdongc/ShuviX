/**
 * AppEvent —— 通用内部事件（后端发布，前后端均可订阅）。
 *
 * 与 ChatEvent 并列：ChatEvent 是单会话 agent 流式协议（agent.onEvent）；AppEvent 是全局、
 * 非聊天的后端状态事件（events.subscribe），收编原本散落的「后端变更 → UI 重新同步」回调。
 *
 * 约束：载荷必须可序列化、不含密钥（要跨进程/网络发到渲染层）。详见 docs/internal-events.md。
 */

export type AppEvent =
  | {
      type: 'files.changed'
      /** 工作目录标识（= chatStore.projectPath） */
      root: string
      /** 本次变更的文件（已归一到该端 UI 路径空间）；省略表示"未知，保守整体刷新" */
      paths?: string[]
      kind?: 'write' | 'edit' | 'delete'
    }
  | {
      type: 'settings.changed'
      /** 变更的设置键（如 'general.language'）；省略 = 未指明，消费者全量重取 */
      keys?: string[]
    }
  /** 提供商/模型配置变更（增删改/同步/导入）—— 与通用设置 KV 区分，避免一条事件过泛 */
  | { type: 'providers.changed' }
  | { type: 'project.changed' }
  | { type: 'session.configChanged'; sessionId: string }
  /** 会话标题变更（AI 自动生成）—— 载荷带 title，消费者直接更新、无需回查；用户手动改名由发起端自更 */
  | { type: 'session.titleChanged'; sessionId: string; title: string }
  /**
   * 会话列表成员变化（创建 / 删除 / 移动项目）—— 信号事件，消费者重拉 session.list。
   * 不带载荷：列表查询是廉价本地读，快照载荷跨窗口重复且可能乱序；覆盖所有非 UI 发起的
   * 变更（IPC/CLI 直建、知识库/记忆笔记去重开会话等），UI 流程的乐观刷新照旧。
   */
  | { type: 'session.listChanged' }
  /**
   * bot 注册表变化（保存 / 新建 / 删除 / 非法文件修好）—— 信号事件，消费者重拉 bot.list。
   * 与 session.listChanged 同口径：不带载荷。只覆盖经 botService 落盘的变更；bot 自己在
   * 答话途中用 `edit` 改 md、用户往目录里丢文件这类写入不广播，由消费者在窗口聚焦时重扫兜底。
   */
  | { type: 'bot.changed' }
  /**
   * 智能体档案注册表变化（新建 / 覆盖副本 / 删除 / 经笔记本落盘的编辑）—— 信号事件，
   * 消费者重拉 subAgent.list。侧栏那一组把档案的显示名直接摆在屏幕上，而改名就发生在
   * 同一个窗口的笔记本里（没有切窗口这一下可以兜底），所以 agent 目录与 bots 目录一样
   * 要回执；口径也一致：只覆盖经宿主落盘的写入，外部编辑器由窗口聚焦时的重扫兜底。
   */
  | { type: 'agent.changed' }
  /**
   * 安全策略注册表变化（新建 / 覆盖副本 / 删除 / 经笔记本落盘的编辑）—— 信号事件，
   * 消费者重拉 policy.list。与 agent.changed 同口径：只覆盖经宿主落盘的变更，
   * 外部编辑器写盘由窗口聚焦时的重扫兜底。评估侧本就每次现扫现装配，这个事件只为
   * 侧栏那一组的显示名 / 覆盖态。
   */
  | { type: 'policy.changed' }
  /**
   * 技能注册表变化（启用开关 / 增删外部目录 / 删除技能 / 经笔记本落盘的 SKILL.md 编辑）——
   * 信号事件，消费者重拉 skill.listGrouped。与 agent.changed 同口径：只覆盖经宿主落盘的变更，
   * 用户自己往目录里丢技能由窗口聚焦时的重扫兜底。
   */
  | { type: 'skill.changed' }
  | { type: 'pinChat.changed'; pinnedSessionIds: string[] }
  | { type: 'widget.changed' }
  /**
   * 知识库（OKF bundle）内容变化 —— 宿主观察到的写入（knowledge 工具 / 文件工具落在根目录下）
   * 完成投影与提交之后发出。信号事件、不带载荷：消费者重拉 knowledge.list；外部编辑
   * （Obsidian 等）不广播，由消费者在窗口聚焦时重扫兜底（与 bot.changed 同口径）。
   */
  | { type: 'knowledge.changed' }
  /**
   * 请求渲染端验证图表源码（preview 工具发起，桌面专用；扩展工具在浏览器内就地验证）。
   * 渲染端用与 ChartView 同一管线（renderMermaid）跑一遍，结果经宿主回执通道
   * （preview:reportRender IPC）回给主进程 broker 对号入座；超时由 broker 诚实降级。
   */
  | { type: 'preview.validateChart'; validationId: string; sessionId: string; absPath: string }

export type AppEventType = AppEvent['type']

/** 按 type 取具体事件形状（供 useAppEvent 等做精确回调类型） */
export type AppEventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>

/** 纯 JS 发布订阅总线（Set-based，同步派发，无持久化/重放） */
export interface AppEventBus {
  publish(event: AppEvent): void
  subscribe(cb: (event: AppEvent) => void): () => void
}

export function createAppEventBus(): AppEventBus {
  const listeners = new Set<(event: AppEvent) => void>()
  return {
    publish(event) {
      // 复制一份再派发：回调内退订不影响本轮
      for (const cb of [...listeners]) {
        try {
          cb(event)
        } catch {
          /* 单个订阅者抛错不影响其它 */
        }
      }
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
