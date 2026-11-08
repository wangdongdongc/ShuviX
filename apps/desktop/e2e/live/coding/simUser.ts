/**
 * The simulated user for tasks with hidden facts (`task.user`): a separate model call that plays the person
 * who wrote the request. It knows the request and the task's facts and nothing else, gives a fact only when
 * the agent asks about that point (or proposes or reports something that contradicts it), and returns a JSON
 * verdict the probe counts: which questions touched which facts, which facts it gave, whether the agent was
 * done.
 *
 * It runs on deepseek with the key the deepseek arm uses (`SHUVIX_PROBE_COMPLETIONS_KEY` / `_MODEL`) and
 * calls api.deepseek.com from the test process, never through the app under test. The same simulated user
 * answers every arm and every model, so the arms are compared against one user.
 */
import type { Fact } from './tasks'

export interface SimTurn {
  from: 'user' | 'agent'
  text: string
}

export interface SimCard {
  question: string
  options: Array<{ label: string; description: string }>
}

export interface SimVerdict {
  /** what the agent's message mainly was */
  kind: 'question' | 'completion' | 'progress' | 'mixed'
  /** each question the agent put to the user (or plan it asked to confirm), with the facts it touched */
  questions: Array<{ text: string; facts: string[] }>
  /** facts the reply gives */
  disclosed: string[]
  /** the reply corrects something the agent already did or decided */
  correction: boolean
  /** nothing to answer: the agent finished without contradicting a fact, or only reported progress */
  done: boolean
  reply: string
  /** option labels ticked on a card */
  selections: string[]
  /** the model call failed or never returned valid JSON (the probe then stops the conversation) */
  error?: string
}

export interface SimUser {
  respond(history: SimTurn[], latest: { text: string; card?: SimCard }): Promise<SimVerdict>
  /** raw calls, for the report */
  readonly log: Array<{ input: string; output: string }>
}

const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max / 2)}\n…（中间省略 ${text.length - max} 字）…\n${text.slice(-max / 2)}`

function systemPrompt(request: string, facts: Fact[]): string {
  const known = facts.length
    ? [
        '关于这件事，你心里还清楚下面这些事实，只是没写进消息里。除此之外你没有任何别的要求或想法：',
        '',
        '<facts>',
        ...facts.map((f) => `${f.id}：${f.text}`),
        '</facts>'
      ]
    : ['你写的那条消息就是你全部的要求，此外你没有任何别的要求或想法。']
  return [
    '你在扮演一个真实的用户。你维护着一个叫 stockroom 的库存服务（你会写代码，但这件事想交给 AI 编程助手来做）。你刚给助手发了下面这条消息：',
    '',
    '<request>',
    request,
    '</request>',
    '',
    ...known,
    '',
    '怎么回答助手：',
    '1. 只有助手问到某个事实涉及的点，或者它打算做的、已经做了的跟某个事实冲突，才说出那个事实。用自己的话简短地说，只说被问到或冲突的那几条，不要顺带说出别的。',
    '2. 助手笼统地问你还有什么要求、或者请你把某件事说具体，就把跟它问的那件事有关的事实都告诉它。',
    '3. 助手问的东西你的事实里没有：说你没有特别要求，让它自己定。不要编造新要求，不要给技术建议，不要提示它该问什么。',
    '4. 助手请你确认一个方案：跟事实不冲突就说可以；冲突就指出来。方案里没提到的点不用补充（除非第 1、2 条要你说）。',
    '5. 助手问要不要顺手做别的事：你的消息和事实里都没要的，就说不用。',
    '6. 助手在汇报做完了：汇报里有跟事实冲突的地方就指出来（这算纠正）；没有就 done=true，reply 留空。',
    '7. 用中文，像一个忙碌的人那样回答，一两句话，不客套。',
    '',
    '只输出一个 JSON 对象，不要别的文字：',
    '{"kind": "question", "questions": [{"text": "…", "facts": ["F2"]}], "disclosed": ["F2"], "correction": false, "done": false, "reply": "…", "selections": []}',
    '',
    '- kind：助手这条消息主要在问你（question）、在汇报已经做完（completion）、在说进展或接下来要做什么而没有问你（progress）、既汇报做完又问你（mixed）。',
    '- questions：这条消息里助手问你的每个问题、或请你确认的每个方案，一句话概括，以及它涉及哪些事实的编号（不涉及任何事实就是 []）。没问你任何东西就是 []。',
    '- disclosed：你这次的 reply 里说出了哪些事实的编号。',
    '- correction：reply 是不是在纠正助手已经做了或已经定了的东西。',
    '- done：没什么要回的了（助手做完了且没有冲突，或者只是在说进展）。done 为 true 时 reply 为空。',
    '- selections：只在助手给了选项卡片时填你勾选的选项的 label（原样照抄），也可以不勾、只用 reply 回答。'
  ].join('\n')
}

function userContent(history: SimTurn[], latest: { text: string; card?: SimCard }): string {
  const lines = ['<conversation>']
  for (const t of history)
    lines.push(`[${t.from === 'user' ? '你' : '助手'}] ${clip(t.text, 1500)}`)
  lines.push(
    '</conversation>',
    '',
    '助手刚发来的消息：',
    '<latest>',
    clip(latest.text || '（没有文字）', 6000),
    '</latest>'
  )
  if (latest.card) {
    lines.push(
      '',
      '助手还弹出了一张选择卡片，等你回答：',
      `问题：${latest.card.question}`,
      '选项：',
      ...latest.card.options.map((o) => `- ${o.label}：${o.description}`)
    )
  }
  return lines.join('\n')
}

const KINDS = new Set(['question', 'completion', 'progress', 'mixed'])

function parseVerdict(text: string, facts: Fact[]): SimVerdict | undefined {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
  const ids = new Set(facts.map((f) => f.id))
  const factList = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.map(String).filter((id) => ids.has(id)))] : []
  const kind = KINDS.has(String(raw.kind)) ? (raw.kind as SimVerdict['kind']) : 'progress'
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : ''
  return {
    kind,
    questions: Array.isArray(raw.questions)
      ? raw.questions.map((q) => {
          const o = (q ?? {}) as Record<string, unknown>
          return { text: String(o.text ?? ''), facts: factList(o.facts) }
        })
      : [],
    disclosed: factList(raw.disclosed),
    correction: raw.correction === true,
    done: raw.done === true || reply === '',
    reply,
    selections: Array.isArray(raw.selections) ? raw.selections.map(String) : []
  }
}

export function createSimUser(opts: {
  key: string
  model: string
  request: string
  facts: Fact[]
  baseUrl?: string
}): SimUser {
  const base = opts.baseUrl ?? 'https://api.deepseek.com'
  const system = systemPrompt(opts.request, opts.facts)
  const log: Array<{ input: string; output: string }> = []
  let jsonMode = true

  async function call(content: string): Promise<string> {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: 2000,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content }
        ]
      })
    })
    const body = await res.text()
    if (res.status === 400 && jsonMode && /response_format|json/i.test(body)) {
      jsonMode = false
      return call(content)
    }
    if (!res.ok) throw new Error(`simulated user: HTTP ${res.status} ${body.slice(0, 300)}`)
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> }
    return parsed.choices?.[0]?.message?.content ?? ''
  }

  return {
    log,
    async respond(history, latest) {
      const content = userContent(history, latest)
      let lastError = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const output = await call(content)
          log.push({ input: content, output })
          const verdict = parseVerdict(output, opts.facts)
          if (verdict) return verdict
          lastError = `not JSON: ${output.slice(0, 200)}`
        } catch (e) {
          lastError = String((e as Error)?.message ?? e)
          log.push({ input: content, output: `ERROR ${lastError}` })
        }
      }
      return {
        kind: 'progress',
        questions: [],
        disclosed: [],
        correction: false,
        done: true,
        reply: '',
        selections: [],
        error: lastError
      }
    }
  }
}
