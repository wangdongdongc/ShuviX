/**
 * bot md 管线字段（`shuvix-bot-pipeline`）的**候选项契约** —— 属性卡的联动控件按它渲染：
 * 选一个工作流，它声明的槽位随之列出，每个槽位再从 agent 名单里选。
 *
 * 候选项是运行时注册表事实（哪些工作流存在、各自声明了什么槽位、有哪些 agent），描述符是
 * 静态数据装不下它们，故经 ChatApi `shuvixMd.botPipelineOptions` 由宿主提供（同工具 / 模型
 * 候选项的分层）。没有 bot 面的宿主（扩展）不实现 —— 控件退化为只读展示。
 */

/** 工作流声明的一个 agent 槽位（与 agent-runtime 的 PipelineAgentSlot 同构） */
export interface BotPipelineSlot {
  role: string
  required: boolean
  description?: string
}

export interface BotPipelineWorkflowOption {
  name: string
  source: 'builtin' | 'user'
  /** 重入策略（skip / queue / parallel）—— bot 管线要求 parallel，别的模式会在校验里被点名 */
  concurrency: string
  /** 声明的槽位（顺序即声明序）；没声明 = 空数组 */
  slots: BotPipelineSlot[]
}

export interface BotPipelineOptions {
  /** 生效的工作流（被同名用户文件遮蔽的内置不在列） */
  workflows: BotPipelineWorkflowOption[]
  /** 生效的 agent 名（同上，被遮蔽的内置不在列） */
  agents: string[]
}
