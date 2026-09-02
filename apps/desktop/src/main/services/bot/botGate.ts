/**
 * L0 确定性门（设计 §6.0）—— 一条用户消息进来之后，**哪些成员会被唤起**。
 *
 * 零 LLM、纯函数：宿主事实全部以参数交付，因此可以单测每一条边界。它决定的只有
 * 「谁参与」，不决定「谁最终说话」—— 后者是每个成员自己的意图段判的（v2 没有仲裁，
 * 有资格参与的成员各自独立决定开不开口）。
 *
 * 五段按序，**顺序即语义**：任何一段命中都固定后续。
 *
 *   0. 作者过滤与循环护栏 —— 见下。
 *   1. @提及    —— 命中即定向：只有被点名的成员参与，mention-only 不再过滤。
 *   2. clarify 回连 —— 上一条 bot 消息是某个成员的 clarify 时，这条无提及消息硬路由给它。
 *   3. mention-only —— 未定向时剔除声明了 mention-only 的成员。
 *   4. cohort  —— 剩下的 auto 成员按成员序即参与集合；空 = 这一轮没人开口。
 *
 * **作者判定为什么落在这里**：v1 靠**结构**保证「bot 的回复不触发 bot」—— 用户消息走
 * `handleUserMessage`，bot 自己的回复走 `appendBotMessage`，两条路根本不交汇，于是入参里
 * 连 author 都不需要有。v2 开了 bot→bot 接力，这条结构性保证随之作废：接力**就是**让一条
 * bot 消息回灌到同一个门上。所以作者成了显式入参，而「谁不响应谁」与两道循环护栏一并收进
 * 段 0 —— 它们回答的是同一个问题（这条消息该不该唤起任何人），分散到两处判必然漂移。
 */
import { BOT_MENTION_TOKEN_TYPE } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { ParsedBotFile } from '@shuvix/agent-runtime'
import type { BotDecisionKind, BotDecisionRecord } from './botJournal'

/**
 * 分支尾部最后一条 bot 消息的判定材料（clarify 回连用）。
 *
 * v2 起它来自 `chat_messages` 的最后一条 bot 行，而不是会话树上的署名侧车 ——
 * 那套「消息前多写一条 custom entry、投影时靠紧邻配对」的机制随群聊改表一并退场。
 */
export interface LastBotSender {
  botName: string
  displayName: string
  /** 意图段判定；`clarify` 才触发回连 */
  decision?: string
  /** 那条消息的 id */
  entryId: string
}

export interface L0Input {
  /** 会话成员名单（`settings.bots`），**顺序即成员序**（参与者与展示都按它） */
  members: string[]
  /**
   * 这条消息是谁说的（v2）。用户消息恒触发；bot 消息只触发那些
   * `shuvix-bot-respond-to: all` 的成员，且**永不触发它自己** —— 后者是结构性的，
   * 没有开关。缺省（`user`）等价于 v1 的硬规则「bot 的回复不触发 bot」。
   */
  author: { kind: 'user' } | { kind: 'bot'; name: string }
  /**
   * 循环护栏的两个计数（只在有成员开了 `respond-to: all` 时才可能触发）：
   * `hop` 是这条消息的传播跳数，`fanout` 是同一轮里已经产生的 bot 消息数。
   * 任一越界即整轮不参与 —— **终止性靠结构保证，不靠提示词自觉**。
   */
  hop: number
  fanout: number
  limits: { maxHop: number; maxFanout: number }
  /** 一次 `listAll()` 建好的索引；查不到的成员会被剔除并记 `l0_member_missing` */
  known: Map<string, ParsedBotFile>
  /**
   * 用户消息的**标记态原文**，不是展开后的 promptText。
   * 展开会把 paste token 换成用户粘的任意长文、把 cmd token 整条替换掉 ——
   * 在那上面找 `@名字` 会匹配到别人的内容里去。
   */
  text: string
  inlineTokens?: Record<string, InlineToken>
  /** 会话里最后一条 bot 消息的判定材料（没有则 null） */
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
  /** 本轮扇出触顶（护栏拦下）—— 宿主据此落一条可见的 system 消息，不静默 */
  fanoutExceeded?: boolean
  /** 参与集合，成员序；**空 = 这一轮没人开口** */
  cohort: string[]
  /** 定向（被提及或 clarify 回连）—— 意图段据此换用不含 ignore 的契约 */
  directed: boolean
  records: L0Record[]
  /** 本轮消费掉的那条 clarify（调用方存进 clarifyConsumed） */
  consumedClarifyEntryId?: string
}

/**
 * 提及胶囊的消费口（生产端 = 输入框 @ 弹层的 `buildBotToken`，A3 已落地；
 * `token.id` 即 bot 的 name，按身份键精确认领，displayName 撞名也不糊）。
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

  // 命中的区间就地抹掉 —— 「长名优先」只靠排序是不够的：`hit` 是按**成员**去重的，
  // 所以 `@研究员` 命中「研究员」之后，短名「研究」照样能在同一段文字上再命中一次
  // （一个没被点名的 bot 因此被唤起）。抹区间而不是加词尾边界：词尾边界会把
  // `@bobby` 命中 `bob` 这类降级期刻意的宽松一并禁掉。填充字符用 NUL 而不是空格：
  // 空格会凭空造出一个词边界，让紧跟其后的短别名（`@alpha@b` 里的 `@b`）反而变成命中。
  let scan = text.toLowerCase()
  const hit = new Set<string>()
  for (const { member, alias } of candidates) {
    const needle = `@${alias.toLowerCase()}`
    let from = 0
    for (;;) {
      const at = scan.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? '' : scan[at - 1]
      if (before === '' || /\s/.test(before)) {
        hit.add(member)
        scan = scan.slice(0, at) + '\u0000'.repeat(needle.length) + scan.slice(at + needle.length)
        from = at + needle.length
      } else {
        from = at + 1
      }
    }
  }
  // 按成员序输出（命中集合的顺序不该取决于匹配顺序）
  return members.filter((m) => hit.has(m))
}

export function runL0Gate(inp: L0Input): L0Result {
  const records: L0Record[] = []

  // ── 0. 作者过滤与循环护栏（v2）──
  // hop 管纵向（链路必然终止），fanout 管横向（一条消息不会炸出几十条）。缺任何一个
  // 都留着一条失控路径；两者在缺省 `respond-to: user` 下恒不触发，零成本
  if (inp.author.kind === 'bot') {
    if (inp.hop >= inp.limits.maxHop) {
      records.push({ kind: 'l0_hop_exceeded', botName: inp.author.name, detail: { hop: inp.hop } })
      return { cohort: [], directed: false, records }
    }
    if (inp.fanout >= inp.limits.maxFanout) {
      records.push({
        kind: 'l0_fanout_exceeded',
        botName: inp.author.name,
        detail: { fanout: inp.fanout }
      })
      return { cohort: [], directed: false, records, fanoutExceeded: true }
    }
  }
  // 谁有资格看这条消息：用户消息人人可见；bot 消息只有声明了 respond-to: all 的成员，
  // 且发言人自己永远出局
  const author = inp.author
  const eligible =
    author.kind === 'user'
      ? inp.members
      : inp.members.filter((m) => m !== author.name && inp.known.get(m)?.respondTo === 'all')
  if (!eligible.length) return { cohort: [], directed: false, records }
  inp = { ...inp, members: eligible }

  // ── 1. @提及：token 优先，裸文本降级 ──
  // 去重：两个指向同一 bot 的提及胶囊否则会给同一个成员派两个 run，而 v2 里没有任何一处
  // 会拦下第二条 —— 每个 bot 各自独立处理消息，两个 run 就是两条一模一样的回复
  const byToken = [
    ...new Set(mentionsFromTokens(inp.inlineTokens).filter((n) => inp.members.includes(n)))
  ]
  const mentioned = byToken.length ? byToken : mentionsFromText(inp.text, inp.members, inp.known)
  // 「命中」指**解析出了活着的成员**，不是「文本里出现了 @」：否则打一个已删除的 bot 名字
  // 就成了会话的静音开关 —— 它会吞掉本该发生的 clarify 回连与正常组队
  // 这一步是**探测**：不命中就回落到后续段，所以不落记录 —— 缺失成员的
  // l0_member_missing 统一由段 3 记，否则同一条消息会读出两次缺失
  const directedCohort = mentioned.filter((n) => inp.known.has(n))
  if (directedCohort.length) {
    const via = byToken.length ? 'token' : 'text'
    // 被提及但已删除的成员：在这里记，段 3 不会再走到
    for (const name of mentioned) {
      if (!inp.known.has(name)) records.push({ kind: 'l0_member_missing', botName: name })
    }
    for (const name of directedCohort) {
      records.push({ kind: 'l0_directed', botName: name, detail: { via } })
    }
    return finish(directedCohort, true, records, inp.members)
  }

  // ── 2. clarify 回连 ──
  const last = inp.lastBotSender
  if (
    last &&
    last.decision === 'clarify' &&
    inp.members.includes(last.botName) &&
    // 缺失判定前移：走 present 会在这里记一条 l0_member_missing，回落到段 3 又记一条 ——
    // 决策记录是按 bot 分目录的调查材料，同一条消息重复归因会读出两次缺失
    inp.known.has(last.botName) &&
    !inp.clarifyConsumed.has(last.entryId)
  ) {
    const cohort = [last.botName]
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

/**
 * **这一层没有「无从解释的沉默」**：L0 之后每一次沉默都已经有具体原因
 * （`l0_member_missing` / `l0_mention_only_skipped`），一个成员若既在册又不是
 * mention-only，它必然进 cohort。
 *
 * 设计 §7 说的「全体沉默」是另一回事：cohort 组起来了，但一个字都没换来 —— 它只有
 * 等全员跑完才知道 —— v2 里没人说话就是没人说话，不再落任何提示。
 */
function finish(
  cohort: string[],
  directed: boolean,
  records: L0Record[],
  _members: string[]
): L0Result {
  for (const name of cohort) {
    records.push({
      kind: 'cohort_formed',
      botName: name,
      detail: { members: cohort, directed, size: cohort.length }
    })
  }
  return { cohort, directed, records }
}
