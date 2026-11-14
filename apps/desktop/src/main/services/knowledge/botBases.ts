/**
 * bot 库（2026-11-14，用户裁决：每个 bot 一个独立的知识库）—— 宿主注入的那一半。
 *
 * bot 库是 knowledge-shuvix 下的 `bots/<key>/`，key 由 bot 的身份算出（chat-protocol `botKnowledgeKey`：对象 id，没有就是名字），
 * 与安全策略的 `subject.bot` 同一个值。可「一条会话绑定的是哪个 bot、它的 key 是什么」「某个 key 现在叫什么」要读
 * bot 注册表，而注册表在平铺的 botService 里 —— 本模块是内聚模块，不能反向依赖它（eslint boundaries），所以由
 * main/index.ts 在启动时注入。没注入（单测）就当没有 bot 库。
 */
export interface BotKnowledgeHost {
  /** 这条会话**自己**绑定的 bot 的库 key；不是 bot 会话、bot 文件不在 → null */
  keyOfSession(sessionId: string): string | null
  /** 某个 key 此刻属于哪个**生效的** bot，给界面显示名；没有（含已归档的 bot）→ undefined */
  displayNameOf(key: string): string | undefined
}

let host: BotKnowledgeHost | null = null

export function setBotKnowledgeHost(next: BotKnowledgeHost | null): void {
  host = next
}

export function botKeyOfSession(sessionId: string): string | null {
  try {
    return host?.keyOfSession(sessionId) ?? null
  } catch {
    return null
  }
}

export function botDisplayNameOf(key: string): string | undefined {
  try {
    return host?.displayNameOf(key)
  } catch {
    return undefined
  }
}
