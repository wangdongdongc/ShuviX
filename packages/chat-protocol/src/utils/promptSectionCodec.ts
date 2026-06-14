import type { ProjectPromptSection } from '../types/promptSection'

/**
 * 解析 JSON 信封 `{ sections: [...] }` → ProjectPromptSection[]
 * 防御性 fallback：遇到老 plain text / 损坏数据返回空数组
 */
export function parsePromptSections(raw: string | undefined | null): ProjectPromptSection[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.sections)) {
      return parsed.sections.filter(
        (s: unknown): s is ProjectPromptSection =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as { id?: unknown }).id === 'string' &&
          typeof (s as { title?: unknown }).title === 'string' &&
          typeof (s as { content?: unknown }).content === 'string'
      )
    }
  } catch {
    /* 旧 plain text 或损坏,按空处理 */
  }
  return []
}

/** 序列化 ProjectPromptSection[] → JSON 信封字符串 */
export function encodePromptSections(sections: ProjectPromptSection[]): string {
  return JSON.stringify({ sections })
}
