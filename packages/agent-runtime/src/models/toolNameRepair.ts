/**
 * Tool-name repair — a tool call whose name matches an offered tool only up to letter case is
 * renamed to that tool before anyone sees it.
 *
 * Models write a tool's name the way the product is spelled: on Windows the first command often
 * goes to `powerShell` (the description says "PowerShell" throughout, the other tool names are
 * lower-case-first), and pi-durable matches names exactly, so that call came back as
 * `tool_unavailable` and cost a round. pi-ai already does this for Claude subscription logins
 * (`fromClaudeCodeName` in its anthropic transport); this covers every provider.
 *
 * Only a name that matches no offered tool exactly and exactly one case-insensitively is
 * changed: with two tools differing only in case the call is left alone, and pi-durable answers
 * it as before. The repaired name reaches the transcript, so later turns copy it from history.
 * Only the model's own fresh output changes — the prompt and tool declarations a provider
 * caches are untouched.
 */
import {
  getCurrentTools,
  normalizeContext,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ToolCall
} from '@earendil-works/pi-ai'

export type ToolNameResolver = (name: string) => string

/**
 * The resolver for one request's offered tools (the same set pi-durable checks calls against),
 * or undefined when the request offers none. Never throws — it runs before the request starts,
 * where a throw would fail the call: a context it cannot read gets no repair, and the request
 * itself reports whatever is wrong with it.
 */
export function toolNameResolverFor(context: Context): ToolNameResolver | undefined {
  let names: string[]
  try {
    names = getCurrentTools(normalizeContext(context).messages)
      .map((tool) => (tool as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === 'string')
  } catch {
    return undefined
  }
  if (names.length === 0) return undefined
  const exact = new Set(names)
  // Lower-cased name → the one tool it folds to, or null when several do.
  const folded = new Map<string, string | null>()
  for (const name of exact) {
    const key = name.toLowerCase()
    folded.set(key, folded.has(key) ? null : name)
  }
  return (name) => {
    if (exact.has(name)) return name
    return folded.get(name.toLowerCase()) ?? name
  }
}

function repairedName(
  block: { type: string; name?: unknown },
  resolve: ToolNameResolver
): string | undefined {
  // A streaming partial may not carry its name yet.
  if (block.type !== 'toolCall' || typeof block.name !== 'string') return undefined
  const name = resolve(block.name)
  return name === block.name ? undefined : name
}

function repairToolCall(call: ToolCall, resolve: ToolNameResolver): ToolCall {
  const name = repairedName(call, resolve)
  return name === undefined ? call : { ...call, name }
}

/** The message with its tool calls renamed, or the same object when none needs it. */
export function repairToolCallNames(
  message: AssistantMessage,
  resolve: ToolNameResolver
): AssistantMessage {
  // Anything not shaped like a message (an event type pi adds later) passes through.
  if (!Array.isArray(message?.content)) return message
  if (!message.content.some((block) => repairedName(block, resolve) !== undefined)) return message
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === 'toolCall' ? repairToolCall(block, resolve) : block
    )
  }
}

/** Every message an event carries, repaired; the same event when nothing changes. */
export function repairEventToolNames(
  event: AssistantMessageEvent,
  resolve: ToolNameResolver
): AssistantMessageEvent {
  switch (event.type) {
    case 'done': {
      const message = repairToolCallNames(event.message, resolve)
      return message === event.message ? event : { ...event, message }
    }
    case 'error': {
      const error = repairToolCallNames(event.error, resolve)
      return error === event.error ? event : { ...event, error }
    }
    case 'toolcall_end': {
      const partial = repairToolCallNames(event.partial, resolve)
      const toolCall = repairToolCall(event.toolCall, resolve)
      return partial === event.partial && toolCall === event.toolCall
        ? event
        : { ...event, partial, toolCall }
    }
    default: {
      const partial = repairToolCallNames(event.partial, resolve)
      return partial === event.partial ? event : { ...event, partial }
    }
  }
}
