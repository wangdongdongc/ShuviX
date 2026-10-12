/**
 * 空回复追问 —— 工具跑完之后模型什么也没说就停了，不当它答完。
 *
 * pi 的循环规则是「回复里没有工具调用就是最终回答」（pi-durable `classify` → `answer`），不看正文。
 * 有的模型（多见于自部署的开源思考模型）会在工具结果之后只写一段思考 —— 计划了下一步，甚至写了
 * 「我去读那个文件」—— 然后发停止符，既没有正文也没有工具调用。按 pi 的规则这次运行以 done 结束，
 * 界面上像是做完了，其实任务断了。服务端改不了模型已经发出的停止符，只能在客户端兜。
 *
 * 规则与模型无关：**工具结果之后的回复既没有正文、也没有工具调用，就不算答完**。在 `onYield`（pi 结束
 * 一次运行之前唯一的口子）里追加一条 `<empty-reply>` 通知，同一个 run 接着跑 —— 和工具轮之后交给下一个
 * generation 是同一种交接，`pi.live.run` 一直在，中途不发 `agent_end`。
 *
 * 护栏：
 *  - **只管正常的最终回答**：onYield 只在 `answer()` 里调（stop / length / 没有调用的 toolUse）；停止、
 *    出错、上下文溢出、工具 terminate / handoff 都不经过它。`length` 不追问 —— 那是输出上限不够，再问一次
 *    多半还是被截断。
 *  - **自我封顶**：只在「这次回复之前的最后一条消息是工具结果」时追问。追问之后再空，前一条就是追问本身，
 *    不再追问 —— 同一个位置至多一次，不需要计数器（pi 的 memo 按 generation 任务存，每次续写都是新任务，
 *    数不住）。进程重启后重新判断，结论相同。
 *  - **用户优先**：这次边界放下了用户的插话 / 排队消息（或 reset）时，pi 自己忽略 continue。
 *  - **出错就不追问**：读不到上下文 / 任何异常 → 不追问、照常结束（中止除外：照原样抛给 pi）。
 *  - 找「前一条」时跳过 system 消息（段落增量）和出错 / 中止的助手消息 —— pi-ai 发请求时也丢掉它们，
 *    模型看到的前一条仍是工具结果。
 *
 * 追问是一条 user 消息（pi 的 continue 只能写这个），用 `<empty-reply>` 信封包着：投影认成系统通知
 * （通知行，不画成用户气泡），transcriptDigest 也不把它当人写的 —— 自动审查只看人说了什么。
 */
import type { Context } from '@earendil-works/chord'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import {
  GenerationTask,
  hook,
  type Harness,
  type HookRegistration
} from '@earendil-works/pi-durable'
import { EMPTY_REPLY_NOTICE_KIND } from '@shuvix/chat-protocol/systemNoticeContract'
import type { RuntimeLogger } from '../types'
import { errorText } from './context'

/** 追问正文（写给模型看的；信封标签见 chat-protocol `EMPTY_REPLY_NOTICE_KIND`） */
export const EMPTY_REPLY_NOTICE_TEXT = [
  `<${EMPTY_REPLY_NOTICE_KIND}>`,
  'Your previous reply had no visible text and no tool call, so nothing happened.',
  'If you meant to call a tool, call it now. If the task is finished, give your answer.',
  `</${EMPTY_REPLY_NOTICE_KIND}>`
].join('\n')

/** 一条最终回答是不是「空」的：正常停下，没有工具调用，正文去掉空白后为空（思考不算正文） */
export function isEmptyReply(message: AssistantMessage): boolean {
  if (message.stopReason !== 'stop' && message.stopReason !== 'toolUse') return false
  for (const block of message.content) {
    if (block.type === 'toolCall') return false
    if (block.type === 'text' && block.text.trim() !== '') return false
  }
  return true
}

/** 模型上下文里最后一条有效消息是不是工具结果（跳过 system 段落增量与出错 / 中止的助手消息） */
export function followsToolResult(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'system') continue
    if (
      message.role === 'assistant' &&
      (message.stopReason === 'error' || message.stopReason === 'aborted')
    ) {
      continue
    }
    return message.role === 'toolResult'
  }
  return false
}

export interface EmptyReplyHookDeps {
  /** 读对话的模型上下文（未包装的 Harness：只读，不开启调度器） */
  harness: Pick<Harness, 'conversation'>
  sessionId: string
  logger: RuntimeLogger
}

/**
 * `pi.generation` 的 onYield：空回复且紧跟工具结果 → `{ continue: 追问 }`，否则不表态。
 * 挂在 `shuvix.builtin` 上，所以根对话与派生 agent 的对话都生效。
 */
export function emptyReplyHook(deps: EmptyReplyHookDeps): HookRegistration {
  return hook(GenerationTask, {
    onYield: async (answer, api, context: Context) => {
      // 有正文或有调用的回答（绝大多数）在这里就返回，不读任何东西
      if (!isEmptyReply(answer)) return undefined
      try {
        const conversation = await deps.harness.conversation(api.conversationId, context)
        if (conversation === undefined) return undefined
        // 这次回答还没写进去（answer 在提交之前调 hook），上下文的末尾就是它前面那条
        const view = await conversation.context(context)
        if (!followsToolResult(view.messages)) return undefined
      } catch (error) {
        if (context.abortSignal?.aborted) throw error
        deps.logger.warn(
          `session ${deps.sessionId}: checking an empty reply failed; the run ends as usual: ${errorText(error)}`
        )
        return undefined
      }
      // pi 在这次边界放下了用户输入时会忽略 continue，所以这里只说「请求」
      deps.logger.info(
        `session ${deps.sessionId} conversation ${api.conversationId}: the reply after tool results had no text and no tool call; requesting a continuation (skipped if user input is queued)`
      )
      return { continue: EMPTY_REPLY_NOTICE_TEXT }
    }
  })
}
