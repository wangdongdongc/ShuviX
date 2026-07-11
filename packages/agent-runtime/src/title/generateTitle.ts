/**
 * 会话标题生成共享内核 —— 宿主无关。
 *
 * 输入「已解析模型 + apiKey + 对话文本」，调 completeSimple 让模型产出 {"title":"..."}，
 * 经三级兜底解析出干净标题。模型来源（专用标题模型 / 会话模型）与触发时机由端各自决定
 * （触发策略已在 chat-ui useAgentEvents 共享）。
 */
import type { TextContent } from '@earendil-works/pi-ai'
import { completeSimple } from '@earendil-works/pi-ai/compat'

/** completeSimple 的模型入参类型（pi-ai Model） */
type CompleteModel = Parameters<typeof completeSimple>[0]

export const TITLE_GEN_SYSTEM_PROMPT = `Generate a concise title (3-7 words) that captures the main topic or goal of this conversation.
The title should be clear enough that the user recognizes the session in a list.

Rules:
- Use the same language as the user's message
- Use sentence case (capitalize only the first word and proper nouns)
- Return JSON with a single "title" field

Good examples:
{"title": "Fix login button on mobile"}
{"title": "调试 CI 流水线失败问题"}
{"title": "Add OAuth authentication"}
{"title": "重构 API 客户端错误处理"}

Bad (too vague): {"title": "Code changes"} {"title": "对话记录"}
Bad (too long): {"title": "Investigate and fix the issue with the login button not working on mobile devices"}`

/**
 * 从模型原始输出解析标题（纯函数）：
 * - 剥离 ```json 围栏
 * - L1 直接 JSON.parse；L2 正则提取 {"title":"..."}；L3 去引号/句号兜底
 * - 统一截断到 30 字
 */
export function parseTitle(raw: string): string | null {
  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  if (!stripped) return null

  // L1: 直接 parse
  try {
    const parsed = JSON.parse(stripped)
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title.trim().slice(0, 30)
    }
  } catch {
    /* continue to L2 */
  }

  // L2: 正则提取 {"title":"..."}
  const match = stripped.match(/\{\s*"title"\s*:\s*"([^"]*)"\s*\}/)
  if (match?.[1]?.trim()) {
    return match[1].trim().slice(0, 30)
  }

  // L3: 兜底 — 去掉引号/句号等杂物
  const fallback = stripped.replace(/^["'`]+|["'`.,。！!]+$/g, '').trim()
  return fallback.slice(0, 30) || null
}

/**
 * 用给定模型生成会话标题。失败或空内容返回 null（调用方决定是否再走启发式兜底）。
 */
export async function generateSessionTitle(input: {
  model: CompleteModel
  apiKey: string
  conversationText: string
}): Promise<string | null> {
  const result = await completeSimple(
    input.model,
    {
      systemPrompt: TITLE_GEN_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: input.conversationText }],
          timestamp: Date.now()
        }
      ]
    },
    { apiKey: input.apiKey }
  )

  const raw = result.content
    ?.filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim()

  return raw ? parseTitle(raw) : null
}
