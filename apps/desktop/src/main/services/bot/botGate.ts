/**
 * L0 确定性门（设计 §6.0）—— 一条用户消息进来之后，**哪些成员会被唤起**。
 *
 * 零 LLM、纯函数：宿主事实全部以参数交付，因此可以单测每一条边界。它决定的只有
 * 「谁参与」，不决定「谁最终说话」—— 后者是仲裁（`botArbiter`）的事。
 *
 * 四段按序，**顺序即语义**：任何一段命中都固定后续。
 *
 *   0. 作者过滤 —— 见下面「为什么这里没有作者判定」。
 *   1. @提及    —— 命中即定向：只有被点名的成员参与，mention-only 不再过滤。
 *   2. clarify 回连 —— 上一条 bot 消息是某个成员的 clarify 时，这条无提及消息硬路由给它。
 *   3. mention-only —— 未定向时剔除声明了 mention-only 的成员。
 *   4. cohort  —— 剩下的 auto 成员按成员序即参与集合；空 = 全体沉默。
 *
 * **为什么这里没有作者判定**：「bot 的回复不得触发 bot」是硬规则（防循环），但它今天
 * 由**结构**保证而不是由字段保证 —— `handleUserMessage` 的唯一调用链是 `agent:prompt`
 * IPC → gateway 分流，而 bot 自己的回复走 `appendBotMessage`，完全旁路它。
 * `AgentPromptParams` 里没有 author，加一个恒为 'user' 的字段等于给自己开一张假证明。
 * 将来真出现「bot 消息回灌 prompt 入口」的路径（bot 间接力、CLI 注入、建议问题走错口），
 * 该改的是那条路径。
 */
import { BOT_MENTION_TOKEN_TYPE } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { BotSenderSidecar, ParsedBotFile } from '@shuvix/agent-runtime'
import type { BotDecisionKind, BotDecisionRecord } from './botJournal'

/** 上一条 bot 消息的署名侧车 + 它所在的 entry id（clarify 回连的判定材料） */
export interface LastBotSender extends BotSenderSidecar {
  entryId: string
}

export interface L0Input {
  /** 会话成员名单（`settings.bots`），**顺序即成员序** —— 仲裁最后一级 tie-break 也用它 */
  members: string[]
  /** 一次 `listAll()` 建好的索引；查不到的成员会被剔除并记 `l0_member_missing` */
  known: Map<string, ParsedBotFile>
  /**
   * 用户消息的**标记态原文**，不是展开后的 promptText。
   * 展开会把 paste token 换成用户粘的任意长文、把 cmd token 整条替换掉 ——
   * 在那上面找 `@名字` 会匹配到别人的内容里去。
   */
  text: string
  inlineTokens?: Record<string, InlineToken>
  /** 分支尾部反扫到的最后一条 bot 署名侧车（没有则 null） */
  lastBotSender: LastBotSender | null
  /** 已经回连过的 clarify entry id —— 一条 clarify 只硬路由一次 */
  clarifyConsumed: ReadonlySet<string>
}

/** 决策记录的骨架：调用方补齐 sessionId / ticketId / ts */
export type L0Record = { kind: BotDecisionKind; botName: string } & Pick<
  BotDecisionRecord,
  'detail'
>

export interface L0Result {
  /** 参与集合，成员序；**空 = 全体沉默** */
  cohort: string[]
  /** 定向（被提及或 clarify 回连）—— 意图段据此换用不含 ignore 的契约 */
  directed: boolean
  records: L0Record[]
  /** 本轮消费掉的那条 clarify（调用方存进 clarifyConsumed） */
  consumedClarifyEntryId?: string
}

/**
 * 提及胶囊的消费口。
 *
 * **生产端（输入框胶囊）是 A3**，所以今天它恒返回空数组 —— 刻意不假装它已经能用。
 * 位置在这里是因为消费必须发生在 token 展开**之前**：`resolveTokensForAgent` 之后
 * type 就永久丢失了，那时再想认出「这是一次提及」已经没有依据。
 */
export function mentionsFromTokens(tokens?: Record<string, InlineToken>): string[] {
  if (!tokens) return []
  return Object.values(tokens)
    .filter((t) => t.type === BOT_MENTION_TOKEN_TYPE && !!t.id)
    .map((t) => t.id)
}

/**
 * 裸文本提及的降级匹配。
 *
 * 规则三条，每条都有代价换来的理由：
 *  - **长名优先**：否则 `@研究` 会抢在 `@研究员` 前面命中；
 *  - `@` 前须是行首或空白（词边界）：邮箱、`a@b` 这类不该算提及；
 *  - **大小写不敏感**：它本来就是胶囊没落地之前的降级路径，宁可宽一点。
 */
export function mentionsFromText(
  text: string,
  members: string[],
  known: Map<string, ParsedBotFile>
): string[] {
  const candidates: Array<{ member: string; alias: string }> = []
  for (const member of members) {
    const bot = known.get(member)
    candidates.push({ member, alias: member })
    if (bot?.displayName && bot.displayName !== member) {
      candidates.push({ member, alias: bot.displayName })
    }
  }
  // 长名优先
  candidates.sort((a, b) => b.alias.length - a.alias.length)

  const lower = text.toLowerCase()
  const hit = new Set<string>()
  for (const { member, alias } of candidates) {
    if (hit.has(member)) continue
    const needle = `@${alias.toLowerCase()}`
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? '' : lower[at - 1]
      if (before === '' || /\s/.test(before)) {
        hit.add(member)
        break
      }
      from = at + 1
    }
  }
  // 按成员序输出（命中集合的顺序不该取决于匹配顺序）
  return members.filter((m) => hit.has(m))
}

export function runL0Gate(inp: L0Input): L0Result {
  const records: L0Record[] = []

  // ── 1. @提及：token 优先，裸文本降级 ──
  const byToken = mentionsFromTokens(inp.inlineTokens).filter((n) => inp.members.includes(n))
  const mentioned = byToken.length ? byToken : mentionsFromText(inp.text, inp.members, inp.known)
  if (mentioned.length) {
    const via = byToken.length ? 'token' : 'text'
    const cohort = present(mentioned, inp, records)
    for (const name of cohort) {
      records.push({ kind: 'l0_directed', botName: name, detail: { via } })
    }
    return finish(cohort, true, records, inp.members)
  }

  // ── 2. clarify 回连 ──
  const last = inp.lastBotSender
  if (
    last &&
    last.decision === 'clarify' &&
    inp.members.includes(last.botName) &&
    !inp.clarifyConsumed.has(last.entryId)
  ) {
    const cohort = present([last.botName], inp, records)
    if (cohort.length) {
      records.push({
        kind: 'l0_clarify_relink',
        botName: last.botName,
        detail: { clarifyEntryId: last.entryId }
      })
      return {
        ...finish(cohort, true, records, inp.members),
        consumedClarifyEntryId: last.entryId
      }
    }
  }

  // ── 3. mention-only：未定向时不参与 ──
  const auto: string[] = []
  for (const name of present(inp.members, inp, records)) {
    if (inp.known.get(name)?.respond === 'mention-only') {
      records.push({ kind: 'l0_mention_only_skipped', botName: name })
      continue
    }
    auto.push(name)
  }

  // ── 4. cohort ──
  return finish(auto, false, records, inp.members)
}

/** 剔除名单里已经不存在的成员（`updateBots` 刻意不校验名字，降级在这里兑现） */
function present(names: string[], inp: L0Input, records: L0Record[]): string[] {
  const out: string[] = []
  for (const name of names) {
    if (!inp.known.has(name)) {
      records.push({ kind: 'l0_member_missing', botName: name })
      continue
    }
    out.push(name)
  }
  return out
}

function finish(
  cohort: string[],
  directed: boolean,
  records: L0Record[],
  members: string[]
): L0Result {
  if (!cohort.length) {
    // 全体沉默。**逐成员记**而不是记一条会话级的 —— 决策记录按 bot 分目录，
    // 「这个 bot 为什么没说话」不该需要跨文件对账。已经因缺失/mention-only
    // 记过原因的成员不重复记
    const explained = new Set(records.map((r) => r.botName))
    for (const name of members) {
      if (explained.has(name)) continue
      records.push({ kind: 'l0_silent', botName: name })
    }
    return { cohort, directed, records }
  }
  for (const name of cohort) {
    records.push({
      kind: 'cohort_formed',
      botName: name,
      detail: { members: cohort, directed, size: cohort.length }
    })
  }
  return { cohort, directed, records }
}
