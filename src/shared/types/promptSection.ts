/**
 * 项目级 system prompt 分段卡片
 *
 * - 应用层(main / preload / renderer 共用)以 `ProjectPromptSection[]` 形式持有
 * - DB 层复用 `projects.systemPrompt` TEXT 列,序列化为 `ProjectSystemPromptData`
 *   JSON 信封,便于将来扩展(version / meta 等)
 */
export interface ProjectPromptSection {
  /** uuid v7,稳定 React key + dnd-kit sortable id */
  id: string
  /** 卡片标题(可空字符串) */
  title: string
  /** 卡片正文(可空字符串) */
  content: string
}

/** projects.systemPrompt 列实际写入的 JSON 信封 */
export interface ProjectSystemPromptData {
  sections: ProjectPromptSection[]
}
