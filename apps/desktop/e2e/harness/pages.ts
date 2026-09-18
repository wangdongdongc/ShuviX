/**
 * 薄 page-object 层 —— DOM 断言集中在此，选择器坏了只修一处。
 * 约定：断言优先走 IPC（window.api.*）；只有「确实在验证 UI 呈现」时才用这里。
 */
import type { CdpClient } from './cdp'
import { sleep, until } from './cdp'

// ─────────────────────────────────────────────────────────────────────────
// 主窗对话区 + 侧栏会话列表
//
// 断言优先走 IPC（`window.api.message.list` / 事件收集器）；这里只放「确实在验证
// 呈现」的部分。两条锚点原则：
//   - 消息条目按 `data-msg-*` 认（MessageRenderer 根节点），工具行按 `data-tool-*` 认；
//     它们是对话区唯一与配色/图标/文案无关的钩子。
//   - 其余（气泡正文、思考块、用量、待处理面板）按**结构**认，绝不认 i18n 文案。

/** 对话流里的一个可见条目（含流式合成占位项 `streaming-live`） */
export interface ChatItem {
  /** 投影契约里的消息 id —— 一条 entry 一条消息，id 就是 entry id */
  id: string
  role: string
  type: string
  /** 该条目屏幕上的主文本（助手正文 / 用户气泡正文 / 错误行文案） */
  text: string
}

/**
 * 乐观占位气泡（还没落库的那条用户消息）的快照。
 *
 * id 固定是 `pending-prompt`（chat-ui 的 `PENDING_PROMPT_ID`）—— 它**不是** entry id，
 * 树上还没有这条消息，所以气泡上不给回退，且压淡一档（`data-msg-pending`）。
 */
export interface PendingPromptShot extends ChatItem {
  /** 压淡标记（UserBubble 的 `data-msg-pending`）：还没落库的可见信号 */
  pendingLook: boolean
  /** 气泡里有没有回退按钮 —— 占位不该有：回退的目标 entry 还不存在 */
  rollback: boolean
}

/** 工具行快照（ToolCallBlock 的 data-tool-*） */
/** 步骤合并行（StepGroup）的快照 */
export interface ChatStepGroup {
  state: 'collapsed' | 'expanded'
  /** 合并进这一行的步骤数（思考 / 已完成的工具调用） */
  size: number
  /** 合并行头一行的文本（标签 / 步骤序列 + 摘要 + 计数） */
  text: string
}

/** 系统通知行（SystemNoticeRow）的快照 */
export interface ChatSystemNotice {
  kind: 'compaction' | 'background' | 'instruction'
  state: 'collapsed' | 'expanded'
  /** 整行（含展开正文）的文本 */
  text: string
}

export interface ChatToolRow {
  name: string
  status: string
}

/**
 * 屏幕上一张图的快照 —— 「它显示的是哪一份文件」是这组断言的核心。
 *
 * 工具卡片里的模型图走 `shuvix-preview://`（主进程流式读盘，零 base64 进渲染进程），
 * 路径在 URL 的 query 里；右侧预览面板的图片走 data: URL（另一条既有实现），路径只能
 * 从 `alt` 取 —— 故 `path` 两种来源都认。`src` 只留头部：data: URL 可能有几 MB，
 * 整串搬过 CDP 没有意义，够看出协议即可。
 */
export interface ToolImageShot {
  /** src 的前 120 字符（够辨认协议） */
  src: string
  path: string
  naturalWidth: number
  naturalHeight: number
  complete: boolean
}

export interface ChatPane {
  /** 输入框就绪（会话已选中、ChatView 已挂载） */
  ready(): Promise<void>

  /** 往输入框填字（native value setter + input 事件，走 React 的 onChange） */
  type(text: string): Promise<void>
  /** 敲回车（走 React 的 onKeyDown → handleSend / handleSteer） */
  pressEnter(): Promise<void>
  /** 往输入框派发任意按键（弹层方向键导航等；只走 keydown，不改 value） */
  pressKey(key: string): Promise<void>
  /** type + pressEnter */
  typeAndSend(text: string): Promise<void>
  /** 点发送按钮（禁用态下浏览器本就不派发 onClick，用于验证「点不动」） */
  clickSend(): Promise<void>
  inputValue(): Promise<string>
  /** 发送按钮（lucide-send）是否禁用 */
  sendDisabled(): Promise<boolean>
  /** 流式态：`streaming-live` 合成占位项存在 ⟺ isStreaming */
  isBusy(): Promise<boolean>
  /** 等到流式结束（上界内不落定即抛）；判据是连续两次都不在流式态，见实现处说明 */
  waitIdle(timeoutMs?: number): Promise<void>
  /** 等到条目数达到 n */
  waitItems(n: number, timeoutMs?: number): Promise<void>
  /** StreamingFooter 的 loading dots 是否在屏 */
  loadingDots(): Promise<boolean>

  items(): Promise<ChatItem[]>
  /**
   * 落定条目（剔除两个合成占位项，便于与 message.list 对齐）：流式占位卡
   * `streaming-live`，以及还没落库的乐观占位 `pending-prompt`。
   */
  settledItems(): Promise<ChatItem[]>
  /** 乐观占位气泡（不在屏时为 null）—— 「发出去了但还没落库」的唯一判据 */
  pendingItem(): Promise<PendingPromptShot | null>
  /**
   * 屏幕上压淡（`data-msg-pending`）的用户气泡个数。
   * 与 `pendingItem` 是两条独立判据：id 换成真实 entry 之后，这个标记也必须一起消失。
   */
  pendingLookCount(): Promise<number>
  /** 某条消息的气泡里有没有回退按钮（占位没有；落库之后有） */
  rollbackVisible(msgId: string): Promise<boolean>
  /**
   * 对话区里的「正在连接 MCP」那一行（AssistantBubble 的 `data-mcp-connecting`）的文本；
   * 不在屏时为 null。**只在对话区内找** —— 工具选择器触发钮上另有一个同名锚点。
   */
  mcpConnectingRow(): Promise<string | null>
  /** 用户气泡内的内联 Token 胶囊文本（TokenChip 的 span[role=button]） */
  tokenBadges(msgId: string): Promise<string[]>
  /** 用户气泡内的附图解码状态 */
  images(): Promise<Array<{ naturalWidth: number; complete: boolean }>>
  /** 思考块数量（ThinkingText 的 font-serif 按钮） */
  thinkingBlocks(): Promise<number>
  /** 错误行数量（error_event 条目） */
  errorRows(): Promise<number>
  toolRows(): Promise<ChatToolRow[]>
  /** 展开第 i 个工具行并回其详情区文本（**切换**语义 —— 已展开时会折叠回去） */
  expandToolRow(index: number): Promise<string>
  /** 第 i 个工具行是否展开（展开态在摘要行下方多长出一个详情容器） */
  toolRowExpanded(index: number): Promise<boolean>
  /** 把第 i 个工具行设成指定展开态（幂等，供不关心当前状态的用例用） */
  setToolRowExpanded(index: number, expanded: boolean): Promise<void>
  /** 工具子树内的模型图快照（未展开时为空 —— 缩略图只在展开态挂载） */
  toolImages(): Promise<ToolImageShot[]>
  /** 等工具子树内出现 n 张**已解码**的模型图（挂载与解码都是异步的） */
  waitToolImages(count: number, timeoutMs?: number): Promise<ToolImageShot[]>
  /** 工具子树内的图片降级文案（文件没了时 ToolImageThumb 不留破图，改说一句） */
  toolImageFallbacks(): Promise<string[]>
  /** 点第 i 张工具内联图（走 requestFilePreview，与 Files 面板点文件同一条信号） */
  clickToolImage(index: number): Promise<void>
  /** 工具子树**之外**的图片（右侧预览面板/覆盖层；那里的图走 data: URL，path 取自 alt） */
  previewPanelImages(): Promise<ToolImageShot[]>
  /** 相邻同名调用合并行的计数徽章文本 */
  groupBadges(): Promise<string[]>
  /** 展开所有合并行 */
  expandGroups(): Promise<void>
  /** 步骤合并行快照（展开态 + 步骤数 + 头行文本），按对话流顺序 */
  stepGroups(): Promise<ChatStepGroup[]>
  /** 系统通知行快照（压缩摘要 / 后台完成 / 指令注入） */
  systemNotices(): Promise<ChatSystemNotice[]>
  /** 切换第 i 个系统通知行的展开态，回其整体文本（**切换**语义） */
  toggleSystemNotice(index: number): Promise<string>

  /** 待处理输入面板（PendingInputsPanel）是否在屏 + 是否顶格在输入卡片内 */
  pendingPanel(): Promise<{ open: boolean; firstInCard: boolean }>

  /** 上下文用量环在屏（输入卡工具行内的 circle[r="6"]，轨道圈即可认） */
  ctxRingPresent(): Promise<boolean>
  /** 模型选择器在屏（输入卡工具行选择器簇内 ModelSelect inline 触发器的 chevron） */
  modelPickerPresent(): Promise<boolean>
  /**
   * 选择器簇（工具行第一个子节点）的直接子节点数 —— 「少了哪个选择器」的判据。
   *
   * 普通会话是两个（模型 / 工具；曾经居首的档案选择器随「会话内切换档案」一并下线）。
   * **不按图标认工具选择器**：它的触发钮在没有 MCP / skill 工具时连图标都不渲染，
   * 隔离实例里恰好就是那个空钮；数子节点是这里唯一不靠运气的判据。
   */
  pickerCount(): Promise<number>

  /** 悬浮某条用户气泡点回退（图标按钮，opacity-0 不影响程序化点击） */
  clickRollback(msgId: string): Promise<void>
  /** 末条助手卡片的「重新生成」 */
  clickRegenerate(msgId: string): Promise<void>
  /** ConfirmDialog 是否在屏 */
  confirmOpen(): Promise<boolean>
  /** 点 ConfirmDialog 的确认（页脚第二个按钮，与 policiesPane 同款） */
  confirmAccept(): Promise<void>
}

/** '#rrggbb' → 'rgb(r, g, b)'（getComputedStyle 的归一形态；颜色断言做精确比较用） */
export function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`
}

/** 空闲确认间隔：取实测起流延迟（6~33ms）的十倍量级，满载也留得住余量 */
const IDLE_CONFIRM_MS = 300

/**
 * 乐观占位气泡的固定 id（chat-ui 的 `PENDING_PROMPT_ID`）。
 * e2e 不引渲染包，与 `streaming-live` 同样按**值**钉在这里：它是跨进程的呈现契约。
 */
const PENDING_PROMPT_ID = 'pending-prompt'

/** 主窗对话区（会话已选中后调用） */
export function chatPane(main: CdpClient): ChatPane {
  const TEXTAREA = `document.querySelector('textarea')`
  const ITEMS = `[...document.querySelectorAll('[data-msg-id]')]`
  const TOOLS = `[...document.querySelectorAll('[data-tool-name]')]`
  const SCROLLER = `document.querySelector('.conversation-scroller')`
  // 合并行的计数徽章：StepGroup 给它打了 data-group-count。不按 tabular-nums 样式类认 ——
  // 折叠头的步数、合并通知的条数也是同款徽章，按类认会把它们一并数进来
  const GROUP_BADGES = `[...(${SCROLLER}?.querySelectorAll('[data-group-count]') ?? [])]`
  // 步骤合并行（StepGroup 根节点）与系统通知行（SystemNoticeRow 根节点）
  const GROUPS = `[...(${SCROLLER}?.querySelectorAll('[data-step-group]') ?? [])]`
  const NOTICES = `[...(${SCROLLER}?.querySelectorAll('[data-system-notice]') ?? [])]`
  const SEND_BTN = `[...document.querySelectorAll('button')].find((b) => b.querySelector('.lucide-send'))`
  // 工具卡片里的模型图：**必须**是 shuvix-preview:// —— 若哪天退回 data: URL（base64
  // 又灌进渲染进程），这里会认不到，用例即红，这正是想要的
  const TOOL_IMGS = `[...document.querySelectorAll('[data-tool-name] img')]
    .filter((i) => (i.getAttribute('src') || '').startsWith('shuvix-preview://'))`
  // 工具子树之外的图（右侧预览面板走 data: URL）：不限协议，路径从 alt 取
  const OUTSIDE_IMGS = `[...document.querySelectorAll('img')]
    .filter((i) => i.closest('[data-tool-name]') === null)`
  // path 用正则解而非 new URL：自定义 scheme 不是 special scheme，各引擎对其
  // searchParams 的支持不必赌
  const IMG_SHOT = (list: string): string =>
    `${list}.map((i) => {
      const src = i.getAttribute('src') || ''
      const m = /[?&]path=([^&]*)/.exec(src)
      return {
        src: src.slice(0, 120),
        path: m ? decodeURIComponent(m[1]) : (i.getAttribute('alt') || ''),
        naturalWidth: i.naturalWidth,
        naturalHeight: i.naturalHeight,
        complete: i.complete
      }
    })`
  const DIALOG = `document.querySelector('.dialog-panel')`
  const MSG = (id: string): string =>
    `document.querySelector('[data-msg-id=${JSON.stringify(id)}]')`
  // 输入卡工具行 = textarea 容器（div.relative）的下一个兄弟（InputArea 固定结构）。
  // 档案选择器/上下文环/模型选择器的存在性判断**必须**锚定在这里 —— `.lucide-bot`
  // 一图三用（分组头入口 / 会话行图标 / 档案选择器），裸查 document 必然误命中
  const TOOL_ROW = `(${TEXTAREA}?.parentElement?.nextElementSibling ?? null)`

  // 条目主文本：助手正文的 .markdown-body 是 .min-w-0 的**直接子节点**，
  // 过程区里的中间文本块也用 .markdown-body，靠这一层父子关系区分
  const ITEM_SNAPSHOT = `${ITEMS}.map((el) => {
    const role = el.dataset.msgRole ?? ''
    const type = el.dataset.msgType ?? ''
    let text = ''
    if (role === 'assistant' && type === 'message') {
      text = [...el.querySelectorAll('.markdown-body')]
        .filter((m) => (m.parentElement?.className ?? '').includes('min-w-0'))
        .map((m) => m.textContent ?? '')
        .join('')
    } else {
      text = el.querySelector('.whitespace-pre-wrap')?.textContent ?? ''
    }
    return { id: el.dataset.msgId ?? '', role, type, text: text.trim() }
  })`

  const isBusy = (): Promise<boolean> =>
    main.eval<boolean>(`document.querySelector('[data-msg-id="streaming-live"]') !== null`)

  const type = async (text: string): Promise<void> => {
    await main.eval(
      `(() => {
        const ta = ${TEXTAREA}
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set
        setter.call(ta, ${JSON.stringify(text)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`
    )
    await new Promise((r) => setTimeout(r, 120))
  }

  const pressEnter = async (): Promise<void> => {
    await main.eval(
      `${TEXTAREA}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
    )
  }

  const pressKey = async (key: string): Promise<void> => {
    await main.eval(
      `${TEXTAREA}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`
    )
  }

  return {
    ready: async () => {
      await until(() => main.eval<boolean>(`${TEXTAREA} !== null`), 'chat input mounted')
    },

    type: type,
    pressEnter: pressEnter,
    pressKey: pressKey,
    typeAndSend: async (text) => {
      await type(text)
      await pressEnter()
    },
    clickSend: async () => {
      await main.eval(`${SEND_BTN}?.click()`)
      await new Promise((r) => setTimeout(r, 200))
    },
    inputValue: () => main.eval<string>(`${TEXTAREA}?.value ?? ''`),
    sendDisabled: () => main.eval<boolean>(`${SEND_BTN}?.disabled ?? true`),
    isBusy,
    /**
     * 「不在流式态」的单次快照会在**刚发出去、还没起流**的空窗期里假空闲：实测从
     * 回车到 `streaming-live` 上屏是 6~33ms（满载更长），而 CDP 一个来回也就几毫秒
     * —— 两者同量级，于是 waitIdle 有时空转返回，紧随其后的断言就跑在了本轮任何
     * 消息落库之前。判据因此改成**连续两次、隔一个确认间隔**都空闲。
     */
    waitIdle: async (timeoutMs = 30_000) => {
      await until(
        async () => {
          if (await isBusy()) return false
          await sleep(IDLE_CONFIRM_MS)
          return !(await isBusy())
        },
        'streaming settled',
        timeoutMs
      )
    },
    waitItems: async (n, timeoutMs = 30_000) => {
      await until(
        () => main.eval<boolean>(`${ITEMS}.length >= ${n}`),
        `>=${n} chat items`,
        timeoutMs
      )
    },
    loadingDots: () =>
      main.eval<boolean>(`(${SCROLLER}?.querySelectorAll('.animate-bounce').length ?? 0) > 0`),

    items: () => main.eval<ChatItem[]>(ITEM_SNAPSHOT),
    settledItems: () =>
      main.eval<ChatItem[]>(
        `${ITEM_SNAPSHOT}.filter((i) => i.id !== 'streaming-live' && i.id !== '${PENDING_PROMPT_ID}')`
      ),
    pendingItem: () =>
      main.eval<PendingPromptShot | null>(`(() => {
        const el = ${MSG(PENDING_PROMPT_ID)}
        if (!el) return null
        return {
          id: el.dataset.msgId ?? '',
          role: el.dataset.msgRole ?? '',
          type: el.dataset.msgType ?? '',
          text: (el.querySelector('.whitespace-pre-wrap')?.textContent ?? '').trim(),
          pendingLook: !!el.querySelector('[data-msg-pending]'),
          rollback: !!el.querySelector('.lucide-rotate-ccw')
        }
      })()`),
    pendingLookCount: () =>
      main.eval<number>(`document.querySelectorAll('[data-msg-pending]').length`),
    rollbackVisible: (msgId) =>
      main.eval<boolean>(`!!${MSG(msgId)}?.querySelector('.lucide-rotate-ccw')`),
    mcpConnectingRow: () =>
      main.eval<string | null>(
        `(() => {
          const row = ${SCROLLER}?.querySelector('[data-mcp-connecting]')
          return row ? (row.textContent ?? '').trim() : null
        })()`
      ),
    tokenBadges: (msgId) =>
      main.eval<string[]>(
        `[...(${MSG(msgId)}?.querySelectorAll('span[role="button"]') ?? [])]
          .map((s) => (s.textContent ?? '').trim())`
      ),
    images: () =>
      main.eval(
        `[...document.querySelectorAll('[data-msg-role="user"] img')]
          .map((img) => ({ naturalWidth: img.naturalWidth, complete: img.complete }))`
      ),
    thinkingBlocks: () =>
      main.eval<number>(`${SCROLLER}?.querySelectorAll('button.font-serif').length ?? 0`),
    errorRows: () =>
      main.eval<number>(`document.querySelectorAll('[data-msg-type="error_event"]').length`),

    toolRows: () =>
      main.eval<ChatToolRow[]>(
        `${TOOLS}.map((el) => ({
          name: el.dataset.toolName ?? '',
          status: el.dataset.toolStatus ?? ''
        }))`
      ),
    expandToolRow: async (index) => {
      await main.eval(`${TOOLS}[${index}]?.querySelector('button')?.click()`)
      await new Promise((r) => setTimeout(r, 250))
      return main.eval<string>(`(${TOOLS}[${index}]?.textContent ?? '').trim()`)
    },
    // 展开态 = 摘要行原位不动 + 下方长出详情容器（见 ToolCallBlock 的两个返回分支）
    toolRowExpanded: (index) =>
      main.eval<boolean>(`(${TOOLS}[${index}]?.childElementCount ?? 0) > 1`),
    setToolRowExpanded: async (index, expanded) => {
      const now = await main.eval<boolean>(`(${TOOLS}[${index}]?.childElementCount ?? 0) > 1`)
      if (now === expanded) return
      await main.eval(`${TOOLS}[${index}]?.querySelector('button')?.click()`)
      await new Promise((r) => setTimeout(r, 250))
    },
    toolImages: () => main.eval<ToolImageShot[]>(IMG_SHOT(TOOL_IMGS)),
    waitToolImages: (count, timeoutMs = 20_000) =>
      until(
        async () => {
          const shots = await main.eval<ToolImageShot[]>(IMG_SHOT(TOOL_IMGS))
          const ready =
            shots.length === count && shots.every((s) => s.complete && s.naturalWidth > 0)
          return ready ? shots : null
        },
        `${count} decoded tool image(s)`,
        timeoutMs
      ),
    // 降级文案随渲染端语言（navigator.language）变，故按三语兜底认 —— 与列表页
    // 「已覆盖」徽标同款做法；返回原文，spec 只断言「有没有」不钉具体一句
    toolImageFallbacks: () =>
      main.eval<string[]>(
        `${TOOLS}
          .flatMap((el) => [...el.querySelectorAll('div')])
          .filter((d) => d.childElementCount === 0)
          .map((d) => (d.textContent ?? '').trim())
          .filter((s) => /no longer available|已不可用|利用できません/.test(s))`
      ),
    clickToolImage: async (index) => {
      await main.eval(`${TOOL_IMGS}[${index}]?.click()`)
      await new Promise((r) => setTimeout(r, 300))
    },
    previewPanelImages: () => main.eval<ToolImageShot[]>(IMG_SHOT(OUTSIDE_IMGS)),
    groupBadges: () =>
      main.eval<string[]>(`${GROUP_BADGES}.map((s) => (s.textContent ?? '').trim())`),
    expandGroups: async () => {
      await main.eval(`${GROUP_BADGES}.forEach((s) => s.closest('button')?.click())`)
      await new Promise((r) => setTimeout(r, 250))
    },
    stepGroups: () =>
      main.eval<ChatStepGroup[]>(
        `${GROUPS}.map((el) => ({
          state: el.dataset.groupState ?? '',
          size: Number(el.dataset.groupSize ?? 0),
          text: (el.querySelector('button')?.textContent ?? '').trim()
        }))`
      ),
    systemNotices: () =>
      main.eval<ChatSystemNotice[]>(
        `${NOTICES}.map((el) => ({
          kind: el.dataset.systemNotice ?? '',
          state: el.dataset.noticeState ?? '',
          text: (el.textContent ?? '').trim()
        }))`
      ),
    toggleSystemNotice: async (index) => {
      await main.eval(`${NOTICES}[${index}]?.querySelector('button')?.click()`)
      await new Promise((r) => setTimeout(r, 250))
      return main.eval<string>(`(${NOTICES}[${index}]?.textContent ?? '').trim()`)
    },

    pendingPanel: () =>
      main.eval(`(() => {
        const panel = document.querySelector('.rounded-t-2xl')
        if (!panel) return { open: false, firstInCard: false }
        // 顶格 = 输入卡片（border rounded-2xl 那层）的第一个子节点
        return { open: true, firstInCard: panel.parentElement?.firstElementChild === panel }
      })()`),

    ctxRingPresent: () => main.eval<boolean>(`!!${TOOL_ROW}?.querySelector('svg circle[r="6"]')`),
    modelPickerPresent: () =>
      main.eval<boolean>(`!!${TOOL_ROW}?.firstElementChild?.querySelector('.lucide-chevron-down')`),
    pickerCount: () => main.eval<number>(`${TOOL_ROW}?.firstElementChild?.childElementCount ?? 0`),

    clickRollback: async (msgId) => {
      await main.eval(
        `[...(${MSG(msgId)}?.querySelectorAll('button') ?? [])]
          .find((b) => b.querySelector('.lucide-rotate-ccw'))?.click()`
      )
      await new Promise((r) => setTimeout(r, 300))
    },
    clickRegenerate: async (msgId) => {
      await main.eval(
        `[...(${MSG(msgId)}?.querySelectorAll('button') ?? [])]
          .find((b) => b.querySelector('.lucide-refresh-cw'))?.click()`
      )
      await new Promise((r) => setTimeout(r, 300))
    },
    confirmOpen: () => main.eval<boolean>(`${DIALOG} !== null`),
    confirmAccept: async () => {
      await main.eval(`[...${DIALOG}.querySelectorAll('button')][1].click()`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// A2 · 用户气泡观察器（乐观占位 → 真实 entry 的换手过程）
//
// 「发出去的那句话一次都没有从屏幕上消失过」是**时段**断言，轮询证不了：CDP 一个来回
// 几毫秒到几十毫秒，而占位撤下与真实气泡上屏之间若真有空窗，也就是几十毫秒 —— 采样
// 正好落进去纯属运气。于是把观察装在页内：MutationObserver 每次对话区变动就记一帧，
// 连续相同的帧合并。空窗只要出现过一次，就必然留下一帧 `total: 0`。

/** 某一刻屏幕上「文本等于原文」的用户气泡构成 */
export interface BubbleFrame {
  /** 占位（id 为 `pending-prompt`）几个 */
  pending: number
  /** 真实 entry（其它 id）几个 */
  real: number
  /** 合计 —— 这一帧屏幕上那句话在不在（0 = 空窗） */
  total: number
  /** 这一帧对话列表在不在（`messages` 为空且不在流式态时，整列换成空态） */
  scroller: boolean
  /** 这一帧流式占位卡在不在 */
  live: boolean
  /**
   * 这一帧的时刻（`Date.now()`）。断言不看它，排查时靠它读出每两帧之间隔了多久 ——
   * 「首次挂载那段空档」与「真的把消息撤了」在帧序列上长得一样，只有时刻分得开。
   */
  t: number
}

export interface BubbleWatch {
  /** 开始观察「正文等于 text」的用户气泡（幂等：重复调用重新开始） */
  start(text: string): Promise<void>
  /** 迄今记录到的帧（首帧是 start 那一刻的快照） */
  frames(): Promise<BubbleFrame[]>
  /** 停止观察（不清空已记录的帧） */
  stop(): Promise<void>
}

/** 对话区用户气泡的变动观察器（DOM 锚点同 chatPane：`data-msg-*` + `.whitespace-pre-wrap`） */
export function bubbleWatch(main: CdpClient): BubbleWatch {
  const KEY = '__e2eBubbleWatch'
  return {
    start: async (text) => {
      await main.eval(`(() => {
        const prev = window.${KEY}
        if (prev && prev.obs) prev.obs.disconnect()
        const want = ${JSON.stringify(text)}
        const state = { frames: [], obs: null }
        const snap = () => {
          const bubbles = [...document.querySelectorAll('[data-msg-role="user"][data-msg-id]')]
            .filter(
              (el) => (el.querySelector('.whitespace-pre-wrap')?.textContent ?? '').trim() === want
            )
          const pending = bubbles.filter(
            (el) => el.dataset.msgId === ${JSON.stringify(PENDING_PROMPT_ID)}
          ).length
          const frame = {
            pending,
            real: bubbles.length - pending,
            total: bubbles.length,
            scroller: !!document.querySelector('.conversation-scroller'),
            live: !!document.querySelector('[data-msg-id="streaming-live"]'),
            t: Date.now()
          }
          const last = state.frames[state.frames.length - 1]
          // 连续相同的帧合并：流式正文每来一片就是一次 mutation，不合并的话几千帧全是重复
          if (
            last &&
            last.pending === frame.pending &&
            last.real === frame.real &&
            last.scroller === frame.scroller &&
            last.live === frame.live
          )
            return
          state.frames.push(frame)
        }
        snap()
        state.obs = new MutationObserver(snap)
        state.obs.observe(document.body, { childList: true, subtree: true, characterData: true })
        window.${KEY} = state
        return true
      })()`)
    },
    frames: () => main.eval<BubbleFrame[]>(`(window.${KEY}?.frames ?? []).map((f) => f)`),
    stop: async () => {
      await main.eval(`(() => {
        if (window.${KEY}?.obs) window.${KEY}.obs.disconnect()
        return true
      })()`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// A3 · 输入框 `@` 提及弹层（AtMentionPopover）
//
// 行锚点是组件自带的 data-at-suggestion：值是工作区相对路径 —— 弹层只列工作区文件。
// bot 行（曾经的 `bot:<name>` 名字空间）已整体退场；spec 里 `key.startsWith('bot:')` 只作否定断言。
// 选中态按**结构类**认（键盘选中 = bg-accent/15），不认 i18n 文案。
// 文件表是异步拉的（files.scan），行何时出现由 spec 用 until 等。

/** @ 弹层里的一行 */
export interface AtSuggestionRow {
  /** data-at-suggestion 属性值：工作区相对路径 */
  key: string
  /** 键盘选中态（bg-accent/15） */
  selected: boolean
}

export interface AtPopoverPane {
  /** 弹层是否在屏（有至少一行） */
  open(): Promise<boolean>
  /** 行快照（document 序） */
  rows(): Promise<AtSuggestionRow[]>
  /**
   * 选中某行 —— 派发 **bubbling mousedown**：行按钮监听的是 onMouseDown
   * （抢在 textarea blur 之前），element.click() 只发 click，选不中。
   */
  select(key: string): Promise<boolean>
}

export function atPopoverPane(main: CdpClient): AtPopoverPane {
  const ROWS = `[...document.querySelectorAll('[data-at-suggestion]')]`
  return {
    open: () => main.eval<boolean>(`${ROWS}.length > 0`),
    rows: () =>
      main.eval<AtSuggestionRow[]>(
        `${ROWS}.map((b) => ({
          key: b.getAttribute('data-at-suggestion') ?? '',
          selected: b.className.includes('bg-accent/15')
        }))`
      ),
    select: async (key) => {
      const hit = await main.eval<boolean>(`(() => {
        const row = ${ROWS}.find(
          (b) => b.getAttribute('data-at-suggestion') === ${JSON.stringify(key)}
        )
        if (!row) return false
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        return true
      })()`)
      await sleep(150)
      return hit
    }
  }
}

/**
 * 分组头定位目标：项目组按**种子项目名**认（组头 toggle 按钮里的 span.truncate，
 * CSS uppercase 不改 textContent），临时组 / 知识库组 / Bots 组 / 「项目」分节标题按
 * `data-group` 锚点认 —— 临时组与分节标题是摊开的纯分节（无图标无 toggle 按钮），知识库组
 * 与 Bots 组的标签是本地化文案，四者都只剩这个属性可认。Bots 组的行与页另有自己的 page
 * object（`botsPane`），这里的 target 只用于组头层面的菜单 / 按钮断言。
 */
export type GroupTarget = { project: string } | 'temp' | 'knowledge' | 'bots' | 'section'

/**
 * 菜单项原样快照（对齐 `ContextMenuItem`；侧栏不用 role/submenu，故只留这四个键）。
 *
 * 断「⋮ 与右键是同一份菜单」时比的是**整个对象**而不只是 id：真要分叉，多半分叉在
 * label 或 separator 上（两边各自组装一次 items 的写法一冒头就是这个形状）。
 */
export interface MenuItemShot {
  id?: string
  label?: string
  type?: 'normal' | 'separator'
  enabled?: boolean
}

/** 菜单的触发方式 —— 行/组头的 ⋮ 与右键走的是同一个回调，这里是「从哪一头进去」 */
export type MenuVia = 'menu-button' | 'contextmenu'

/** 行 / 分组头上「还剩哪些可点的东西」 */
export interface RowAffordances {
  /**
   * 该行（组头）内每个 `<button>` 的可读标识，DOM 序：
   *   'menu'         行尾那颗 ⋮（RowMenuButton）
   *   'subs-toggle'  有子会话的父行行首那枚折叠钮（`data-subs-toggle`；钮里包着行的身份图标）
   *   'toggle'       分组头的折叠钮（含分组标签 span.truncate 的那颗）
   *   'other'        其余（出现即说明有人往行里塞了新按钮 —— 正是要断死的东西）
   */
  buttons: string[]
  /** ⋮ 的**静止态** opacity（应为 '0'：悬停才浮现）；没有 ⋮ 时为空串 */
  menuOpacity: string
  /** 行内命中的「旧的一排小图标」类名（收进 ⋮ 之后应当一个不剩） */
  legacyActionIcons: string[]
}

/** 会话行行首身份图标的可读标识（见 SidebarPane.rowIcon） */
export type SessionRowIcon = 'bot' | 'notebook' | 'pinned' | 'multi' | 'chat' | 'other'

/** 分组正文里的一行会话 */
export interface GroupRowShot {
  title: string
  /** 活动行（SessionItem 的 active 分支给行本身加的 bg-bg-active） */
  active: boolean
  /** 行首身份图标（同 rowIcon） */
  icon: SessionRowIcon | ''
}

export interface SidebarPane {
  titles(): Promise<string[]>
  /**
   * 子会话行的标题（`data-sub` 锚点）。父子关系在侧栏只有一种可见形式：
   * 子行缩进渲染在父行下面，且**不再**出现在分组的平铺列表里。
   */
  subTitles(): Promise<string[]>
  /** 某个父行显示的子会话数徽标（`data-sub-count`）；没有徽标返回 0 */
  subCountOf(title: string): Promise<number>
  /**
   * 某个父行的子会话折叠态（`data-subs`）。**不能靠「子行在不在 DOM 里」判**——
   * 折叠只是把 AnimatedCollapse 的高度收成 0，行仍然在。
   */
  subsStateOf(title: string): Promise<string>
  /**
   * 点父行行首的子会话折叠钮（`data-subs-toggle`）。行不存在、或该行没有子会话（行首只是
   * 一枚图标，没有折叠钮）返回 false —— 绝不退而去点行里别的按钮。
   */
  toggleSubs(title: string): Promise<boolean>
  /**
   * 行首那枚身份图标说的「这是哪种会话」，不论它外面有没有包一层子会话折叠钮：
   *   'bot'      bot 会话（md 删了也是 —— 形态由 settings.bot 定）
   *   'notebook' 笔记本会话        'pinned' 悬浮会话
   *   'multi'    有子会话的普通会话（MessagesSquare）
   *   'chat'     普通会话（MessageSquare）
   *   'other'    认不出的图标；行不存在返回空串
   * 只在行内找：`.lucide-bot` 在别处也有（组头菜单、设置窗口……），裸查 document 必然误命中。
   */
  rowIcon(title: string): Promise<SessionRowIcon | ''>
  /**
   * 点侧栏某个会话（按标题）并**等它真的成为活动会话**；行都找不到返回 false。
   *
   * 「点完睡 600ms 就往下走」曾经是这里的做法：机器一慢，切换还没落定就开始断言，
   * 读到的全是上一个会话的对话区（多半是空列表），失败点离真因十几行远。活动态判据
   * 取 SessionItem 的 active 分支给**行本身**加的 `bg-bg-active`（非活动行是
   * `bg-bg-hover`，不会误命中）—— 它直接映射 `activeSessionId === s.id`。
   */
  openSession(title: string): Promise<boolean>
  /**
   * 走分组头菜单的「新建对话」并等列表落定（第一个非知识库组头的 ⋮ → new-chat）。
   *
   * 会让渲染端重新拉全量会话列表（`setSessions(await session.list())`）。经 IPC 建的会话
   * 如今也有 `session.listChanged` 广播兜底（sessions-changed.e2e.ts 钉住），这一下不再是
   * 唯一入口，但仍是「确定已落定」的同步等待点；`location.reload()` 被主进程的
   * will-navigate 守卫挡掉，不可用。分组头须已存在（至少有一个项目或一条会话）。
   */
  clickNewChat(): Promise<void>
  /**
   * 分组头菜单里的动作 id（A0 Bot 入口）。组头不再有一排小图标 —— 新建对话 / 新建 Bot 会话 /
   * 项目配置都在 ⋮ 与右键的同一份菜单里，故断言的是**菜单项**而非按钮。
   * 打开一次菜单（不选任何项 = 取消）后读 e2e 桩记下的 items；组头或 ⋮ 找不到返回 null。
   */
  groupMenuItems(target: GroupTarget): Promise<string[] | null>

  // ── 菜单：⋮ 与右键的**同一份** items（打开即取消，不选任何项） ──
  /**
   * 会话行菜单的**原始 items**（桩记下的那一份）。`via` 是触发方式：缺省点行尾的 ⋮，
   * 'contextmenu' 则往整行派发一个冒泡的 contextmenu 事件。行或 ⋮ 找不到返回 null。
   */
  rowMenuShots(title: string, via?: MenuVia): Promise<MenuItemShot[] | null>
  /** 分组头菜单的**原始 items**；`via` 同上（组头的右键监听在标题行上）。找不到返回 null */
  groupMenuShots(target: GroupTarget, via?: MenuVia): Promise<MenuItemShot[] | null>
  /** 开会话行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对） */
  pickRowMenu(title: string, actionId: string): Promise<void>
  /** 开分组头的 ⋮ 并选中一项（同上） */
  pickGroupMenu(target: GroupTarget, actionId: string): Promise<void>

  // ── 行 / 组头上还剩什么可点的 ──
  /** 会话行的按钮集合与 ⋮ 静止态；行不存在返回 null */
  rowAffordances(title: string): Promise<RowAffordances | null>
  /** 分组头的按钮集合与 ⋮ 静止态；组头不存在返回 null */
  groupAffordances(target: GroupTarget): Promise<RowAffordances | null>
  /**
   * 分组正文是否展开 —— 读组头下一个兄弟（AnimatedCollapse 的 grid 层）的内联
   * `gridTemplateRows`（折叠只收高度，行都还在 DOM 里，数行判不出来）。摊开的纯分节
   * （temp / section）没有折叠容器，恒为 true；组头不存在返回 false。
   */
  groupExpanded(target: GroupTarget): Promise<boolean>
  /**
   * 把分组设成指定展开态并等它落定（幂等）。折叠钮 = 组头里包着标签 span.truncate 的那颗；
   * 纯分节没有折叠钮，要它变态时抛错。
   */
  setGroupExpanded(target: GroupTarget, open: boolean): Promise<void>
  /**
   * 某组正文里的会话行（DOM 序，含子会话行）。经 picker 新建的会话共用本地化的默认标题 ——
   * 按标题全局定位会串到别的组，故「新会话落在哪组、是不是活动行」按组取。组头不存在返回 []。
   */
  groupRows(target: GroupTarget): Promise<GroupRowShot[]>
  /** 当前活动会话行（bg-bg-active）的标题；没有活动行返回空串 */
  activeTitle(): Promise<string>
}

// ── 侧栏菜单桩（bootstrap.cjs 顶掉了 `contextMenu:popup`）——会话行 / 分组头 / Bots 组共用 ──
//
// 菜单本身是原生的，e2e 驱动不了；桩把 items 写进渲染端的 `window.__E2E_MENU_ITEMS`，
// 返回值取自 `window.__E2E_MENU_PICK`。下面这组助手是「钉好要选哪一项 → 点 ⋮ / 右键 →
// 顺带核对该项在不在菜单里」的唯一实现，sidebarPane 与 botsPane 都只是换了 scope 来调。

/** 行/组头尾部那颗 ⋮（RowMenuButton）—— 侧栏一切动作如今的唯一入口 */
const MENU_BTN = (scope: string): string =>
  `${scope}?.querySelector('.lucide-ellipsis-vertical')?.closest('button')`

/**
 * 钉下一次弹出要选中的项，并清掉上一次记下的 items。钉 null = 取消（只看菜单内容时用）。
 */
const armMenu = (main: CdpClient, actionId: string | null): Promise<unknown> =>
  main.eval(`(() => {
    window.__E2E_MENU_PICK = ${JSON.stringify(actionId)}
    window.__E2E_MENU_ITEMS = null
    return true
  })()`)

/** 桩记下的最近一次菜单项（弹出是异步的，等它到） */
async function lastMenuItems(main: CdpClient): Promise<MenuItemShot[]> {
  await until(
    () => main.eval<boolean>(`Array.isArray(window.__E2E_MENU_ITEMS)`),
    'context menu popped'
  )
  return main.eval<MenuItemShot[]>(`window.__E2E_MENU_ITEMS`)
}

/** 同上，但只取自定义项的 id（分隔符被滤掉）—— 既有用例的口径，别动 */
async function lastMenuIds(main: CdpClient): Promise<string[]> {
  return (await lastMenuItems(main)).filter((it) => it.id).map((it) => it.id as string)
}

/**
 * 打开某处的菜单（不选任何项 = 取消）并回原始 items。
 *
 * `via` 是**触发方式**而非目标：'menu-button' 点该处的 ⋮，'contextmenu' 合成一个冒泡的
 * contextmenu 事件派发到该元素本身（会话行监听在整行上，分组头监听在标题行上）。
 * 元素/⋮ 不在返回 null。
 */
async function openMenu(
  main: CdpClient,
  scope: string,
  via: MenuVia
): Promise<MenuItemShot[] | null> {
  await armMenu(main, null)
  const target = via === 'menu-button' ? MENU_BTN(scope) : scope
  const opened = await main.eval<boolean>(`(() => {
    const el = ${target}
    if (!el) return false
    ${
      via === 'menu-button'
        ? 'el.click()'
        : "el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))"
    }
    return true
  })()`)
  if (!opened) return null
  return lastMenuItems(main)
}

/**
 * 打开某处的 ⋮ 并选中一项：先钉选择再点按钮，随后核对该项**真的在**菜单里 ——
 * 桩是照钉的 id 回的，菜单里没有这一项也不会报错，只是什么都不会发生（失败点会离真因很远）。
 */
async function pickFromMenu(
  main: CdpClient,
  scope: string,
  actionId: string,
  what: string
): Promise<void> {
  await until(() => main.eval<boolean>(`!!${MENU_BTN(scope)}`), `${what} menu button`)
  await armMenu(main, actionId)
  await main.eval(`${MENU_BTN(scope)}.click()`)
  const ids = await lastMenuIds(main)
  if (!ids.includes(actionId)) {
    throw new Error(
      `menu item "${actionId}" not offered by ${what} (got: ${ids.join(', ') || '-'})`
    )
  }
}

/**
 * 主窗侧栏会话列表（SessionItem 无 data-*，按「含 span.truncate 的可点击行」认）。
 *
 * 行与组头的动作只剩一个入口：悬停浮现的 ⋮（点它与右键弹的是同一份菜单）。菜单本身是
 * 原生的，e2e 驱动不了 —— bootstrap.cjs 把 `contextMenu:popup` 顶成了可脚本化的桩，
 * 这里只需「钉好要选哪一项 → 点 ⋮ → 顺带核对该项在不在菜单里」（见上方 pickFromMenu）。
 */
export function sidebarPane(main: CdpClient): SidebarPane {
  const ROWS = `[...document.querySelectorAll('div[class*="cursor-pointer"]')]
    .filter((d) => d.querySelector(':scope > div > span.truncate'))`
  /** 按标题定位会话行（标题在行内那层 span.truncate，与顶栏标题区分） */
  const ROW = (title: string): string =>
    `${ROWS}.find(
      (d) =>
        (d.querySelector(':scope > div > span.truncate')?.textContent ?? '').trim() ===
        ${JSON.stringify(title)}
    )`
  /** 活动会话行（SessionItem 的 active 分支给行本身加的 bg-bg-active） */
  const ACTIVE_ROW = `${ROWS}.find((d) => d.className.includes('bg-bg-active'))`
  /** 分组头行（SessionGroup 的 group/header 那层）—— 见 GroupTarget 的定位说明 */
  const HEADERS = `[...document.querySelectorAll('div[class*="group/header"]')]`
  const HEADER = (target: GroupTarget): string =>
    typeof target === 'string'
      ? `${HEADERS}.find((h) => h.getAttribute('data-group') === ${JSON.stringify(target)})`
      : `${HEADERS}.find(
          (h) =>
            (h.querySelector('button span.truncate')?.textContent ?? '').trim() ===
            ${JSON.stringify(target.project)}
        )`
  /**
   * 第一个「能建会话」的组头 —— 按 data-group **正向**点名（项目组 / 临时组）：知识库组的
   * 菜单里只有打开目录 / 刷新，而「项目」分节标题（`section`）压根没有菜单，两者都不是这里要的。
   */
  const ACTION_HEADER = `${HEADERS}.find((h) =>
    ['project', 'temp'].includes(h.getAttribute('data-group'))
  )`
  /**
   * 「旧的一排小图标」候选集：动作收进 ⋮ 之前，行是齿轮 + 垃圾桶，组头是 + / Bot / 齿轮 /
   * 刷新。改动之后行与组头里**一个都不该剩**，故按类名逐个点名（bot 图标不在名单里 ——
   * bot 会话行的身份图标一直是它）。
   */
  const LEGACY_ICONS = [
    'lucide-settings',
    'lucide-trash-2',
    'lucide-plus',
    'lucide-refresh-cw',
    'lucide-pencil',
    'lucide-download'
  ]
  const AFFORDANCES = (scope: string): string => `(() => {
    const el = ${scope}
    if (!el) return null
    const btns = [...el.querySelectorAll('button')]
    const kind = (b) => {
      if (b.querySelector('.lucide-ellipsis-vertical')) return 'menu'
      // 折叠钮里包的是行的身份图标（bot / 悬浮 / MessagesSquare 随会话变），故只认锚点
      if (b.hasAttribute('data-subs-toggle')) return 'subs-toggle'
      // 分组头的折叠钮 = 包着分组标签的那颗（按结构认，免得跟各分组的图标差异纠缠）
      if (b.querySelector('span.truncate')) return 'toggle'
      return 'other'
    }
    const menu = btns.find((b) => b.querySelector('.lucide-ellipsis-vertical')) ?? null
    return {
      buttons: btns.map(kind),
      menuOpacity: menu ? getComputedStyle(menu).opacity : '',
      legacyActionIcons: ${JSON.stringify(LEGACY_ICONS)}.filter((c) => el.querySelector('.' + c))
    }
  })()`

  /**
   * 行首身份图标（页内函数的源码，调用处接一个行元素）：有子会话的行，图标包在
   * `button[data-subs-toggle]` 里；否则它就是行的第一个子节点。lucide 图标都带 `lucide-<name>` 类。
   */
  const ROW_ICON_OF = `((row) => {
    const first = row ? row.firstElementChild : null
    const svg = first && first.matches('button[data-subs-toggle]') ? first.querySelector('svg') : first
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return ''
    const has = (c) => svg.classList.contains(c)
    if (has('lucide-bot')) return 'bot'
    if (has('lucide-file-text')) return 'notebook'
    if (has('lucide-picture-in-picture-2')) return 'pinned'
    if (has('lucide-messages-square')) return 'multi'
    if (has('lucide-message-square')) return 'chat'
    return 'other'
  })`
  /** 分组正文容器 = 组头的下一个兄弟（项目组是 AnimatedCollapse 的 grid 层，纯分节是一层普通 div） */
  const GROUP_BODY = (target: GroupTarget): string => `${HEADER(target)}?.nextElementSibling`
  const groupExpanded = (target: GroupTarget): Promise<boolean> =>
    main.eval<boolean>(`(() => {
      const body = ${GROUP_BODY(target)}
      if (!body) return false
      // 纯分节（temp / section）没有折叠容器，也就没有这条内联样式：恒展开
      const rows = body.style.gridTemplateRows
      return rows ? rows === '1fr' : true
    })()`)

  const pickGroupMenu = async (target: GroupTarget, actionId: string): Promise<void> => {
    await until(() => main.eval<boolean>(`${HEADER(target)} !== undefined`), 'group header')
    await pickFromMenu(main, HEADER(target), actionId, 'group header')
  }

  return {
    clickNewChat: async () => {
      await pickFromMenu(main, ACTION_HEADER, 'new-chat', 'session group header')
      await new Promise((r) => setTimeout(r, 800))
    },
    titles: () =>
      main.eval<string[]>(
        `${ROWS}.map((d) => (d.querySelector(':scope > div > span.truncate')?.textContent ?? '').trim())`
      ),
    subTitles: () =>
      main.eval<string[]>(
        `${ROWS}.filter((d) => d.hasAttribute('data-sub'))` +
          `.map((d) => (d.querySelector(':scope > div > span.truncate')?.textContent ?? '').trim())`
      ),
    subCountOf: (title) =>
      main.eval<number>(`Number(${ROW(title)}?.getAttribute('data-sub-count') ?? 0)`),
    subsStateOf: (title) => main.eval<string>(`${ROW(title)}?.getAttribute('data-subs') ?? ''`),
    toggleSubs: async (title) => {
      const clicked = await main.eval<boolean>(
        `(() => {
          // 只认折叠钮锚点：没有子会话的行里，:scope > button 只剩行尾那颗 ⋮
          const btn = ${ROW(title)}?.querySelector(':scope > button[data-subs-toggle]')
          if (!btn) return false
          btn.click()
          return true
        })()`
      )
      // 折叠动画 150ms（AnimatedCollapse 缺省）——等它落定再断言
      if (clicked) await new Promise((r) => setTimeout(r, 250))
      return clicked
    },
    rowIcon: (title) => main.eval<SessionRowIcon | ''>(`${ROW_ICON_OF}(${ROW(title)})`),
    openSession: async (title) => {
      const clicked = await main.eval<boolean>(
        `(() => {
          const row = ${ROW(title)}
          if (!row) return false
          row.click()
          return true
        })()`
      )
      if (!clicked) return false
      await until(
        () => main.eval<boolean>(`(${ROW(title)}?.className ?? '').includes('bg-bg-active')`),
        `session "${title}" activated`
      )
      return true
    },

    groupMenuItems: async (target) => {
      await until(() => main.eval<boolean>(`${HEADER(target)} !== undefined`), 'group header')
      await armMenu(main, null)
      const clicked = await main.eval<boolean>(`(() => {
        const btn = ${MENU_BTN(HEADER(target))}
        if (!btn) return false
        btn.click()
        return true
      })()`)
      if (!clicked) return null
      return lastMenuIds(main)
    },
    rowMenuShots: async (title, via = 'menu-button') => {
      await until(() => main.eval<boolean>(`${ROW(title)} !== undefined`), `session row "${title}"`)
      return openMenu(main, ROW(title), via)
    },
    groupMenuShots: async (target, via = 'menu-button') => {
      await until(() => main.eval<boolean>(`${HEADER(target)} !== undefined`), 'group header')
      return openMenu(main, HEADER(target), via)
    },
    pickRowMenu: async (title, actionId) => {
      await until(() => main.eval<boolean>(`${ROW(title)} !== undefined`), `session row "${title}"`)
      await pickFromMenu(main, ROW(title), actionId, `session row "${title}"`)
    },
    pickGroupMenu,

    rowAffordances: (title) => main.eval<RowAffordances | null>(AFFORDANCES(ROW(title))),
    groupAffordances: (target) => main.eval<RowAffordances | null>(AFFORDANCES(HEADER(target))),
    groupExpanded,
    setGroupExpanded: async (target, open) => {
      await until(() => main.eval<boolean>(`${HEADER(target)} !== undefined`), 'group header')
      if ((await groupExpanded(target)) === open) return
      const clicked = await main.eval<boolean>(`(() => {
        const btn = [...(${HEADER(target)}?.querySelectorAll(':scope > button') ?? [])].find(
          (b) => b.querySelector('span.truncate')
        )
        if (!btn) return false
        btn.click()
        return true
      })()`)
      if (!clicked) {
        throw new Error(`group ${JSON.stringify(target)} has no fold toggle (a flat section?)`)
      }
      await until(
        async () => (await groupExpanded(target)) === open,
        `group ${JSON.stringify(target)} ${open ? 'expanded' : 'collapsed'}`
      )
      // 内联样式已落定，高度过渡（150ms）还在走 —— 等它走完再往下
      await sleep(200)
    },
    groupRows: (target) =>
      main.eval<GroupRowShot[]>(`(() => {
        const body = ${GROUP_BODY(target)}
        if (!body) return []
        const iconOf = ${ROW_ICON_OF}
        return [...body.querySelectorAll('div[class*="cursor-pointer"]')]
          .filter((d) => d.querySelector(':scope > div > span.truncate'))
          .map((d) => ({
            title: (d.querySelector(':scope > div > span.truncate')?.textContent ?? '').trim(),
            active: d.className.includes('bg-bg-active'),
            icon: iconOf(d)
          }))
      })()`),
    activeTitle: () =>
      main.eval<string>(
        `(${ACTIVE_ROW}?.querySelector(':scope > div > span.truncate')?.textContent ?? '').trim()`
      )
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗里由侧栏菜单拉起的三个弹窗（会话配置 / 删除确认 / 项目编辑）
//
// 三者都长在同一个 `.dialog-panel` 类上，故锚点必须**互相排他**，否则会读到隔壁那一个：
//   - ConfirmDialog 只有标题 + 描述 + 两个页脚按钮，**没有任何 <input>** —— 这是它与
//     另外两个的天然分界，也是唯一 load-bearing 的一条（会话配置弹窗自带一个删除
//     ConfirmDialog，两块 .dialog-panel 会同时在屏）。
//   - 会话配置与项目编辑都「有 input」，但产品上不可能同时在屏（分别由行菜单与组头菜单
//     拉起）—— 两个 pane 因此共用同一个形状锚点，用例各自负责别把它们混在一屏里。

/** 扩展能力卡（ExtensionsSection：会话设置与项目编辑弹窗共用）里的一个条目 */
export interface ExtItemShot {
  /** 勾选用的工具名（`mcp:<server>` / `skill:<name>`），即 `data-ext-item` */
  key: string
  checked: boolean
  /** 勾选框被禁用 = 只读（会话已有 Agent 运行时） */
  disabled: boolean
  /** 这一条是不是被画成了禁用态（`aria-disabled`）：只读时整排压暗，卡片下方不再写只读原因 */
  lockedLook: boolean
  /**
   * 这一条是不是被画成了「离线」（`data-offline`）—— 只有**连接失败**才该这么画。
   * 只读态同样压暗，所以两种压暗不能按透明度分辨：离线只认这个标记。
   */
  offline: boolean
  /** 悬停提示（`title`）：可改时是条目自己的说明，只读时换成「为什么改不了」 */
  title: string
}

/** scope 内扩展能力条目的快照（页内表达式；scope 为空时回 []） */
const EXT_ITEMS = (scope: string): string =>
  `[...(${scope}?.querySelectorAll('label[data-ext-item]') ?? [])].map((label) => {
    const box = label.querySelector('input[type="checkbox"]')
    return {
      key: label.getAttribute('data-ext-item') ?? '',
      checked: !!box?.checked,
      disabled: !!box?.disabled,
      lockedLook: label.getAttribute('aria-disabled') === 'true',
      offline: label.hasAttribute('data-offline'),
      title: label.getAttribute('title') ?? ''
    }
  })`

/**
 * 分节说明气泡里的文案：从分节里的某个锚点元素出发，找到标题旁那个问号（`data-info-hint`），
 * 悬上去让它展开，读气泡（`data-info-tip`，portal 到 body 上）的文字，再移开收起。没有这张卡、
 * 或这一节没有说明时回空串。
 *
 * 2026-09-17 之前这些说明是铺在页面上的文字（SettingsSection 的 description / footer），
 * 拿「分节的最后一个子节点」就能读到；现在它们只在悬浮 / 聚焦时才存在，所以只能这样读。
 * 气泡是异步上屏的（事件 → setState → 重渲染），这里自带一小段轮询。
 */
const SECTION_HINT = (anchor: string): string =>
  `(async () => {
    const section = (${anchor})?.closest('section')
    // 只认标题那一行的问号：卡片里的行可能各有各的问号，document 序上都排在它后面
    const header = section?.querySelector('h3')?.parentElement
    const btn = header?.querySelector('[data-info-hint]')
    if (!btn) return ''
    // 走**悬浮**那条路，不走聚焦：气泡失焦即收起，而这一刻别处（弹窗挂载时的自动聚焦、异步数据
    // 到货后的重渲染）随时可能把焦点抢走 —— 抢走就等于当场收起，先前按 focus() 读的版本因此每隔
    // 几次就空手而归。悬浮态只由我们自己的 mouseout 结束，抢不走。
    // React 的 onMouseEnter 是从 mouseover/mouseout 合成的（relatedTarget 在子树外才算「进入」），
    // 所以派 mouseover 而不是 mouseenter —— 后者 React 根本不监听。
    const fire = (type) =>
      btn.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: document.body })
      )
    // 认**这个按钮**的那一个气泡（aria-describedby → id），不认 document 里的第一个：
    // 两个气泡可以同时开着（鼠标停在 A 上、键盘 Tab 到 B），那时 querySelector 会悄悄
    // 读到另一节的文案 —— 失败起来极难懂，而按 id 取是精确的
    const tipText = () => {
      const id = btn.getAttribute('aria-describedby')
      const tip = id ? document.getElementById(id) : null
      return (tip?.textContent ?? '').trim()
    }
    let text = ''
    for (let attempt = 0; attempt < 5 && !text; attempt++) {
      fire('mouseover')
      for (let i = 0; i < 20 && !text; i++) {
        text = tipText()
        if (!text) await new Promise((r) => setTimeout(r, 10))
      }
    }
    fire('mouseout')
    return text
  })()`

/** scope 内扩展能力卡的说明文案（标题旁的问号气泡）。没有这张卡、或没有说明时回空串。 */
const EXT_HINT = (scope: string): string =>
  SECTION_HINT(`${scope}?.querySelector('label[data-ext-item]')`)

/**
 * 等 scope 内某个扩展能力条目上屏（条目随 `tools.list` 异步到），再点它的勾选框。
 * 按属性值比对而不是拼属性选择器 —— key 里带冒号。只读时勾选框是 disabled 的，点了什么也不会发生。
 */
async function toggleExtIn(
  main: CdpClient,
  scope: string,
  key: string,
  what: string
): Promise<void> {
  const box = `[...(${scope}?.querySelectorAll('label[data-ext-item]') ?? [])]
    .find((label) => label.getAttribute('data-ext-item') === ${JSON.stringify(key)})
    ?.querySelector('input[type="checkbox"]')`
  await until(() => main.eval<boolean>(`!!(${box})`), `${what}: extension item "${key}"`)
  await main.eval(`(() => {
    ${box}.click()
    return true
  })()`)
}

/**
 * 知识库卡（KnowledgeBasesSection：会话设置与项目编辑弹窗共用）里的一个候选库。
 *
 * 与扩展能力条目**同形但语义相反**：知识库不进 Agent 的工具表，所以这张卡没有「已锁定」
 * 这回事 —— `disabled` 照样读出来，正是为了断「有运行时时它仍然可点」。
 */
export interface KnowledgeItemShot {
  /** 选择里存的名字（用户库的目录名 / 保留名 `project` / `shuvix`），即 `data-knowledge-base` */
  name: string
  /**
   * chip 上那行字。用户库就是目录名；两个保留名另取文案（`project` 是「项目」+ 项目当前名字，
   * `shuvix` 是 `knowledge.builtinBaseName` —— 与侧栏那一行读同一个 i18n 键）。
   */
  label: string
  checked: boolean
  disabled: boolean
}

/** scope 内知识库候选项的快照（页内表达式；scope 为空时回 []） */
const KNOWLEDGE_ITEMS = (scope: string): string =>
  `[...(${scope}?.querySelectorAll('label[data-knowledge-base]') ?? [])].map((label) => {
    const box = label.querySelector('input[type="checkbox"]')
    return {
      name: label.getAttribute('data-knowledge-base') ?? '',
      label: (label.querySelector('span')?.textContent ?? '').trim(),
      checked: !!box?.checked,
      disabled: !!box?.disabled
    }
  })`

/** 等 scope 内某个知识库候选项上屏（候选随 `knowledge.baseOptions` 异步到），再点它的勾选框 */
async function toggleKnowledgeIn(
  main: CdpClient,
  scope: string,
  name: string,
  what: string
): Promise<void> {
  const box = `[...(${scope}?.querySelectorAll('label[data-knowledge-base]') ?? [])]
    .find((label) => label.getAttribute('data-knowledge-base') === ${JSON.stringify(name)})
    ?.querySelector('input[type="checkbox"]')`
  await until(() => main.eval<boolean>(`!!(${box})`), `${what}: knowledge base "${name}"`)
  await main.eval(`(() => {
    ${box}.click()
    return true
  })()`)
}

/**
 * scope 内知识库卡的说明文案（标题旁的问号气泡）。没有这张卡、或没有说明时回空串。
 *
 * 「还没选过（一个都没勾）」与「这条会话自己选过」正是靠它区分的 —— 断言方比对的是文案本身
 * （三语取自 chat-protocol 的语言包），不是这里的结构。
 */
const KNOWLEDGE_HINT = (scope: string): string =>
  SECTION_HINT(`${scope}?.querySelector('label[data-knowledge-base]')`)

export interface SessionConfigPane {
  /** 等弹窗上屏 */
  waitOpen(): Promise<void>
  isOpen(): Promise<boolean>
  /** 等它真的卸载（关闭动画 120ms 之后才离开 DOM） */
  waitClosed(): Promise<void>
  /** 标题输入框的当前值 —— 「这个弹窗开的是哪条会话」的判据 */
  titleValue(): Promise<string>
  /** Escape 关闭并等卸载（弹窗在 window 上听 keydown） */
  close(): Promise<void>
  /**
   * 弹窗里扩展能力卡的条目（DOM 序）。**只在弹窗面板内找**：空会话的聊天区（EmptySessionHint）
   * 会内联渲染同一个会话设置面板，裸查 document 会读到那一张。条目随 `tools.list` 异步上屏，
   * 刚打开时可能为空 —— 断言方自己 `until`。
   */
  extItems(): Promise<ExtItemShot[]>
  /** 点弹窗里某个扩展能力条目的勾选框（等条目上屏再点；同样只在弹窗面板内找） */
  toggleExt(key: string): Promise<void>
  /**
   * 扩展能力卡里组名旁那把锁（`data-ext-lock`）的个数 —— 只读时每组一把（MCP / Skills 各一），
   * 可改时一把都没有。
   */
  lockIndicatorCount(): Promise<number>
  /** 扩展能力卡的说明文字（标题旁的问号气泡）：它是**恒定**的一句，不随只读态变 */
  hintText(): Promise<string>
  /** 弹窗里知识库卡的候选项（DOM 序；同样只在弹窗面板内找，口径同 extItems） */
  knowledgeItems(): Promise<KnowledgeItemShot[]>
  /** 点弹窗里某个知识库候选项的勾选框（这张卡不随 Agent 上锁，任何时候都点得动） */
  toggleKnowledgeBase(name: string): Promise<void>
  /** 知识库卡的说明文案（「还没选过」与「已明确设过」两句的判据） */
  knowledgeHint(): Promise<string>
  /** 弹窗遮罩的 z-index —— 说明气泡（portal 到 body）必须压在它上面才看得见 */
  overlayZ(): Promise<number>
}

/** 会话配置弹窗（SessionConfigDialog；由行菜单的 session-config 拉起） */
export function sessionConfigPane(main: CdpClient): SessionConfigPane {
  const PANEL = `[...document.querySelectorAll('.dialog-panel')].find((p) => p.querySelector('input'))`
  const isOpen = (): Promise<boolean> => main.eval<boolean>(`${PANEL} !== undefined`)
  return {
    waitOpen: async () => {
      await until(isOpen, 'session config dialog open')
    },
    isOpen,
    waitClosed: async () => {
      await until(async () => !(await isOpen()), 'session config dialog closed')
    },
    // 标题输入框是这个弹窗里的第一个 input（配置面板排在它下面：开关，以及有 MCP / skill 时的扩展能力勾选框）
    titleValue: () => main.eval<string>(`${PANEL}?.querySelector('input')?.value ?? ''`),
    close: async () => {
      await main.eval(
        `(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`
      )
      await until(async () => !(await isOpen()), 'session config dialog closed')
    },
    extItems: () => main.eval<ExtItemShot[]>(EXT_ITEMS(PANEL)),
    toggleExt: (key) => toggleExtIn(main, PANEL, key, 'session config dialog'),
    lockIndicatorCount: () =>
      main.eval<number>(`${PANEL}?.querySelectorAll('[data-ext-lock]').length ?? 0`),
    hintText: () => main.eval<string>(EXT_HINT(PANEL)),
    knowledgeItems: () => main.eval<KnowledgeItemShot[]>(KNOWLEDGE_ITEMS(PANEL)),
    toggleKnowledgeBase: (name) => toggleKnowledgeIn(main, PANEL, name, 'session config dialog'),
    knowledgeHint: () => main.eval<string>(KNOWLEDGE_HINT(PANEL)),

    overlayZ: () =>
      main.eval<number>(`(() => {
        const overlay = document.querySelector('.dialog-overlay')
        return overlay ? Number(getComputedStyle(overlay).zIndex) || 0 : -1
      })()`)
  }
}

export interface ConfirmSnapshot {
  open: boolean
  title: string
  /** 描述整段文本（含 count 插值出来的数字）—— 断数字，不断本地化文案 */
  description: string
}

export interface ConfirmPane {
  snapshot(): Promise<ConfirmSnapshot>
  waitOpen(): Promise<void>
  waitClosed(): Promise<void>
  /** 页脚第二个按钮 = 确认 */
  confirm(): Promise<void>
  /** 页脚第一个按钮 = 取消 */
  cancel(): Promise<void>
}

/** 通用确认弹窗（ConfirmDialog）—— 认「有 h3 且没有 input」的那块面板，见本节开头 */
export function confirmPane(main: CdpClient): ConfirmPane {
  const PANEL = `[...document.querySelectorAll('.dialog-panel')].find(
    (p) => p.querySelector('h3') && !p.querySelector('input')
  )`
  const isOpen = (): Promise<boolean> => main.eval<boolean>(`${PANEL} !== undefined`)
  const clickFooter = async (index: number): Promise<void> => {
    // 页脚 = 两个按钮那一层（照 policiesPane 的口径：[0] 取消，[1] 确认）
    await main.eval(`[...${PANEL}.querySelectorAll('button')][${index}].click()`)
    await sleep(200)
  }
  return {
    snapshot: () =>
      main.eval<ConfirmSnapshot>(`(() => {
        const panel = ${PANEL}
        if (!panel) return { open: false, title: '', description: '' }
        return {
          open: true,
          title: (panel.querySelector('h3')?.textContent ?? '').trim(),
          description: (panel.querySelector('h3 + div')?.textContent ?? '').trim()
        }
      })()`),
    waitOpen: async () => {
      await until(isOpen, 'confirm dialog open')
    },
    waitClosed: async () => {
      await until(async () => !(await isOpen()), 'confirm dialog closed')
    },
    confirm: () => clickFooter(1),
    cancel: () => clickFooter(0)
  }
}

export interface ProjectEditPane {
  waitOpen(): Promise<void>
  isOpen(): Promise<boolean>
  waitClosed(): Promise<void>
  /** 名称字段的当前值（ProjectInfoForm 的第一个 InlineInput） */
  nameValue(): Promise<string>
  close(): Promise<void>
  /** 扩展能力卡的条目（DOM 序；与会话设置同一个 ExtensionsSection，口径同 sessionConfigPane.extItems） */
  extItems(): Promise<ExtItemShot[]>
  /** 点某个扩展能力条目的勾选框 —— 只改弹窗里的草稿，保存才落库 */
  toggleExt(key: string): Promise<void>
  /** 知识库卡的候选项（与会话设置同一个 KnowledgeBasesSection） */
  knowledgeItems(): Promise<KnowledgeItemShot[]>
  /** 点某个知识库候选项 —— 同样只改草稿；「动过没有」决定保存时写不写这个键 */
  toggleKnowledgeBase(name: string): Promise<void>
  /** 点页脚的「保存」并等弹窗卸载（保存成功后弹窗自己关） */
  save(): Promise<void>
}

/**
 * 项目编辑弹窗（ProjectEditDialog → ProjectConfigDialog 外壳；由组头菜单的 edit-project 拉起）。
 *
 * ⚠️ 「选择/更换文件夹」按钮**只许做存在性断言，绝不点击**：它走 `dialog:openDirectory`，
 * 弹的是 OS 级目录面板，e2e 关不掉，整条 spec 会挂死。
 */
export function projectEditPane(main: CdpClient): ProjectEditPane {
  const PANEL = `[...document.querySelectorAll('.dialog-panel')].find((p) => p.querySelector('input'))`
  // 弹窗在项目数据到手之前渲染 null，故 isOpen 天然要靠 until 等
  const isOpen = (): Promise<boolean> => main.eval<boolean>(`${PANEL} !== undefined`)
  return {
    waitOpen: async () => {
      await until(isOpen, 'project edit dialog open')
    },
    isOpen,
    waitClosed: async () => {
      await until(async () => !(await isOpen()), 'project edit dialog closed')
    },
    nameValue: () => main.eval<string>(`${PANEL}?.querySelector('input')?.value ?? ''`),
    close: async () => {
      await main.eval(
        `(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`
      )
      await until(async () => !(await isOpen()), 'project edit dialog closed')
    },
    extItems: () => main.eval<ExtItemShot[]>(EXT_ITEMS(PANEL)),
    toggleExt: (key) => toggleExtIn(main, PANEL, key, 'project edit dialog'),
    knowledgeItems: () => main.eval<KnowledgeItemShot[]>(KNOWLEDGE_ITEMS(PANEL)),
    toggleKnowledgeBase: (name) => toggleKnowledgeIn(main, PANEL, name, 'project edit dialog'),
    save: async () => {
      // 面板的子节点依次是头部 / 内容 / 页脚；页脚里左边是归档，右边「取消 · 保存」—— 保存是最后一颗
      const clicked = await main.eval<boolean>(`(() => {
        const buttons = [...(${PANEL}?.lastElementChild?.querySelectorAll('button') ?? [])]
        const save = buttons[buttons.length - 1]
        if (!save) return false
        save.click()
        return true
      })()`)
      if (!clicked) throw new Error('project edit dialog: footer save button not found')
      await until(async () => !(await isOpen()), 'project edit dialog closed after save')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 输入框的工具选择器（ToolPicker）—— 会话的扩展能力勾选，与会话设置里的扩展能力卡同一份数据

/** 工具选择器面板里的一行 */
export interface ToolPickerItem {
  /** 工具名（`mcp:<server>` / `skill:<name>`），即 `data-tool-item` */
  name: string
  checked: boolean
  /** 勾选框被禁用 = 只读 */
  disabled: boolean
  /**
   * 这一行是不是被画成了「禁用态」（`aria-disabled`）：只读时整排压暗 + 禁用光标，
   * 面板里不再另起一行文字说明 —— 只读的可见性全靠这个。
   */
  lockedLook: boolean
  /**
   * 这一行是不是被画成了「离线」：行上的 `data-offline` 标记，或挂着 WifiOff 徽标。
   *
   * 惰性启动之后只有**连接失败**（serverStatus === 'error'）才该这么画 —— 「还没连」是常态。
   * 两个信号由同一个判断驱动，这里取「任一成立」：少画一个也算没画成离线，
   * 于是 `offline === false` 这条否定断言最严。（只读态也压暗，所以不再按透明度类名判）
   */
  offline: boolean
  /** 悬停提示（`title`）：只读时是「为什么改不了」，可改时没有 */
  title: string
}

export interface ToolPickerPane {
  /** 选择器在不在（欢迎页没有活动会话、或一个 MCP / skill 条目都没有时不渲染） */
  present(): Promise<boolean>
  /** 只读态（根上的 `data-locked`）：会话此刻有 Agent 运行时（含创建中 / 关停中） */
  locked(): Promise<boolean>
  /** 面板是否展开（按条目在不在 DOM 里判 —— 选择器只在有条目时才渲染，展开必有条目） */
  isOpen(): Promise<boolean>
  /** 展开面板并等条目上屏（幂等） */
  open(): Promise<void>
  /** 收起面板并等条目离开 DOM（幂等） */
  close(): Promise<void>
  /** 面板里的条目（DOM 序）；面板没展开时为空 */
  items(): Promise<ToolPickerItem[]>
  /**
   * 点某条目的勾选框（先展开面板）；条目不在返回 false。
   *
   * `force`：先摘掉 disabled、点完再装回 —— 模拟「绕过禁用态」。禁用的勾选框浏览器根本不派发
   * click，不 force 的话「只读时点了没用」什么也证明不了；force 之后点击真的进了 React 的
   * onChange，钉的是组件与写入口自己的只读判断。
   */
  toggle(name: string, opts?: { force?: boolean }): Promise<boolean>
  /** 触发钮上的锁（`data-tool-lock`）在不在 —— 只读时不用展开面板就看得见 */
  lockIndicatorVisible(): Promise<boolean>
  /**
   * 触发钮上的「正在连接 MCP」转圈（`data-mcp-connecting`）在不在。
   * 只在选择器内找 —— 助手占位卡上另有一个同名锚点（见 chatPane.mcpConnectingRow）。
   */
  connectingVisible(): Promise<boolean>
}

/** 输入框卡片里的工具选择器（`[data-tool-picker]`；主窗里只有当前会话那一个输入区） */
export function toolPickerPane(main: CdpClient): ToolPickerPane {
  const ROOT = `document.querySelector('[data-tool-picker]')`
  const ROWS = `[...(${ROOT}?.querySelectorAll('label[data-tool-item]') ?? [])]`
  const isOpen = (): Promise<boolean> => main.eval<boolean>(`${ROWS}.length > 0`)
  /** 根下第一颗按钮 = 开合面板的触发钮 */
  const clickTrigger = (): Promise<unknown> =>
    main.eval(`(() => {
      ${ROOT}.querySelector('button').click()
      return true
    })()`)
  const open = async (): Promise<void> => {
    await until(() => main.eval<boolean>(`!!${ROOT}`), 'tool picker present')
    if (!(await isOpen())) await clickTrigger()
    await until(isOpen, 'tool picker panel open')
  }
  return {
    present: () => main.eval<boolean>(`!!${ROOT}`),
    locked: () => main.eval<boolean>(`!!${ROOT}?.hasAttribute('data-locked')`),
    isOpen,
    open,
    close: async () => {
      if (!(await isOpen())) return
      await clickTrigger()
      await until(async () => !(await isOpen()), 'tool picker panel closed')
    },
    items: () =>
      main.eval<ToolPickerItem[]>(`${ROWS}.map((label) => {
        const box = label.querySelector('input[type="checkbox"]')
        return {
          name: label.getAttribute('data-tool-item') ?? '',
          checked: !!box?.checked,
          disabled: !!box?.disabled,
          lockedLook: label.getAttribute('aria-disabled') === 'true',
          offline:
            label.hasAttribute('data-offline') ||
            !!label.querySelector('span.text-red-400 svg'),
          title: label.getAttribute('title') ?? ''
        }
      })`),
    toggle: async (name, opts = {}) => {
      await open()
      const force = opts.force === true
      return main.eval<boolean>(`(() => {
        const box = ${ROWS}
          .find((label) => label.getAttribute('data-tool-item') === ${JSON.stringify(name)})
          ?.querySelector('input[type="checkbox"]')
        if (!box) return false
        const wasDisabled = box.disabled
        if (${force}) box.disabled = false
        box.click()
        // 装回原样：React 只在 prop 变化时才碰 disabled，不装回的话之后读到的禁用态就是假的
        if (${force}) box.disabled = wasDisabled
        return true
      })()`)
    },
    lockIndicatorVisible: () => main.eval<boolean>(`!!${ROOT}?.querySelector('[data-tool-lock]')`),
    connectingVisible: () => main.eval<boolean>(`!!${ROOT}?.querySelector('[data-mcp-connecting]')`)
  }
}

export interface HttpLogPane {
  /** 记录开关当前是否打开（读 Toggle 的 on 态背景类） */
  recordOn(): Promise<boolean>
  /** 点击记录开关 */
  toggleRecord(): Promise<void>
  /** 记录状态行文案（关闭态说明为什么没数据，开启态提醒库在涨） */
  statusText(): Promise<string>
}

/** 设置窗口「监视器 / LLM 请求」子页（openSettings('monitor/httpLogs') 后调用） */
export async function httpLogPane(settings: CdpClient): Promise<HttpLogPane> {
  // 记录开关是工具栏里唯一的圆角胶囊按钮（工具栏带 data-monitor-toolbar 标记）
  const SWITCH = `document.querySelector('[data-monitor-toolbar] button.rounded-full')`
  await until(() => settings.eval<boolean>(`${SWITCH} !== null`), 'http log tab ready')

  return {
    recordOn: () => settings.eval<boolean>(`${SWITCH}.className.includes('bg-accent')`),
    toggleRecord: async () => {
      await settings.eval(`${SWITCH}.click()`)
      await new Promise((r) => setTimeout(r, 300))
    },
    // 状态行只在读到设置后才渲染，未就绪时选不中 —— until 把空串视为未就绪，正好
    statusText: () =>
      until(
        () =>
          settings.eval<string>(
            `(document.querySelector('[data-monitor-status]')?.textContent ?? '').trim()`
          ),
        'http log status settled'
      )
  }
}

export interface SettingsTabsPane {
  /** 左栏 tab 导航的按钮文案（DOM 序 = 宿主注入的 tab 序） */
  labels(): Promise<string[]>
  /** 当前高亮 tab 的文案（TabButton 的 active 分支：bg-accent/10） */
  activeLabel(): Promise<string>
  /** 设置窗口当前 hash（`#settings/<tab>`） */
  hash(): Promise<string>
}

/**
 * 设置窗口的 tab 导航（SettingsContainer 左栏：w-[180px] 列里的 TabButton）。
 * 「某个 tab 还在不在」这类否定断言的唯一入口 —— 按文案认（精确匹配，别 includes：
 * 「Telegram Bots」是另一个 tab）。
 */
export async function settingsTabsPane(settings: CdpClient): Promise<SettingsTabsPane> {
  const NAV = `document.querySelector('.w-\\\\[180px\\\\]')`
  const TABS = `[...(${NAV}?.querySelectorAll(':scope > button') ?? [])]`
  await until(() => settings.eval<boolean>(`${TABS}.length > 0`), 'settings tab nav ready')
  return {
    labels: () => settings.eval<string[]>(`${TABS}.map((b) => (b.textContent ?? '').trim())`),
    activeLabel: () =>
      settings.eval<string>(
        `(${TABS}.find((b) => b.className.includes('bg-accent/10'))?.textContent ?? '').trim()`
      ),
    hash: () => settings.eval<string>('location.hash')
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 设置页三个注册表 tab（智能体 / 安全策略 / Hooks）—— 同一副两栏布局，共用一个工厂。
//
// 左列（按宽度类认，`.pop()` 取最后一个）：合法行 = 带 `.font-medium` 标签的按钮（内置行另带锁
// `.lucide-lock`，选中态 `bg-accent/10`）；解析不过的文件行没有 `.font-medium`、文件名在
// `.font-mono` 里（选中态琥珀 `bg-amber-500/10`）；底栏 新建 `.lucide-plus` / 重扫描
// `.lucide-refresh-cw`。右栏 = 列表列的下一个兄弟，自上而下：页级错误框（新建 / 删除失败才有）→
// 头部（标题 `span.text-sm.font-semibold` + 动作图标，那条 `.border-b`）→ Hooks 才有的拒绝原因
// 红框 → 详情。**用户文件的详情就是它的笔记本会话**（`[data-registry-note=<fileName>]`，openNote
// 回来之前渲染 null）；内置是等价 md 的只读查看，没有 data-registry-note。
//
// 就绪判据一律是「挂载到位」而不是睡一觉：内置 = 头部标题对上 + 面板里有 .cm-content + 没有笔记；
// 用户 = 头部标题对上 + 笔记里的属性卡上屏。头部动作一律按图标认（位置会随功能增减漂）。

/** 行的来源（同名覆盖时内置行与用户行并存、标签相同，靠锁图标分开） */
export type RegistryRowSource = 'builtin' | 'user'

/** 详情头部的动作图标 */
export interface RegistryHeaderIcons {
  trash: boolean
  save: boolean
  copy: boolean
}

export interface RegistryConfirmSnapshot {
  open: boolean
  title: string
  description: string
}

/** 三个注册表 tab 共有的面 */
export interface RegistryTabPane {
  /** 点底栏「重扫描」并等列表落定（列表只在挂载时加载，外部写入的新文件要重扫才可见） */
  refresh(): Promise<void>
  /** 「无法解析」分组里的文件名 */
  invalidRows(): Promise<string[]>
  /** 点一行解析不过的文件并等它的笔记挂上 */
  selectInvalidRow(fileName: string): Promise<void>
  /** 当前选中的非法文件行（琥珀态）；没有为空串 */
  selectedInvalid(): Promise<string>
  /** 点底栏「新建」并等**新**笔记（属性卡）上屏，回它的文件名；失败时抛出页级错误框原文 */
  clickNew(): Promise<string>
  /** 点内置详情头部的「创建覆盖副本」并等新笔记上屏，回文件名；失败同上 */
  clickCreateOverride(): Promise<string>
  /** 点详情头部的垃圾桶并等确认框弹出 */
  clickDelete(): Promise<void>
  confirmDialog(): Promise<RegistryConfirmSnapshot>
  /** 点确认框的「删除」（页脚第二个按钮）并等确认框关闭 */
  confirmDialogConfirm(): Promise<void>
  /** 详情里开着的笔记绑定的文件名（`data-registry-note`）；内置 / 无选中为空串 */
  noteFile(): Promise<string>
  /** 详情头部标题（合法条目 = 显示名；解析不过的文件 = 文件名） */
  headerTitle(): Promise<string>
  /**
   * 详情头部左栏逐行的文本（标题 span 的祖父节点的每个子节点，各自 trim）：[0] 标题行（名字 + 来源 /
   * 覆盖徽标），[1] 文件路径或提示；同名里输掉的用户文件多出 [2]「与 X 同名、那一份优先」。三个 tab 同构
   */
  headerLines(): Promise<string[]>
  /** 详情区里笔记之外的红框文本（页级错误框 + Hooks 的拒绝原因框），多个以换行连接 */
  reasonText(): Promise<string>
  headerIcons(): Promise<RegistryHeaderIcons>
  /** 详情里属性卡输入框的个数，以及是否全部禁用（内置只读 = 控件照常渲染、全部禁用） */
  inputs(): Promise<{ count: number; disabled: boolean }>
}

/**
 * 行的附加筛选。同名的几份都列出来时（覆盖内置 + 同名用户文件），标签 + 来源分不开两份用户文件：
 * `overridden` 按划线认 —— true 只挑被遮蔽的那行，false 只挑生效的那行，省略不限。
 */
export interface RegistryRowFilter {
  overridden?: boolean
}

/** 列表行原始快照（各 tab 再映射成自己的形状） */
interface RegistryRowShot {
  label: string
  /** 行内第二行的 mono 小字（Hooks 行的 `agent · 触发器` 副标题；其余 tab 为空串） */
  subtitle: string
  struck: boolean
  overriddenBadge: boolean
  selected: boolean
  builtin: boolean
}

interface RegistryTabInternals extends RegistryTabPane {
  rawRows(): Promise<RegistryRowShot[]>
  selectRow(label: string, which?: RegistryRowSource, opts?: RegistryRowFilter): Promise<void>
}

/**
 * 注册表 tab 的公共实现。`columnWidth` 是左列的宽度类（智能体 / 策略 220px，Hooks 240px）——
 * 两栏布局里只有它能不靠文案认出左列。
 */
function registryTabPane(settings: CdpClient, columnWidth: string): RegistryTabInternals {
  const COLUMN = `[...document.querySelectorAll('.w-\\\\[${columnWidth}\\\\]')].pop()`
  const PANEL = `(${COLUMN}?.nextElementSibling ?? null)`
  const COLUMN_BUTTONS = `[...(${COLUMN}?.querySelectorAll('button') ?? [])]`
  const ROWS = `${COLUMN_BUTTONS}.filter((b) => b.querySelector('.font-medium'))`
  const INVALID_ROWS = `${COLUMN_BUTTONS}.filter((b) => !b.querySelector('.font-medium') && b.querySelector('.font-mono'))`
  const COLUMN_BTN = (icon: string): string =>
    `${COLUMN_BUTTONS}.find((b) => b.querySelector('${icon}'))`
  /** 头部 = 标题 span 所在的那条 border-b（笔记在它之后，querySelector 先命中头部） */
  const HEADER = `(${PANEL}?.querySelector('span.text-sm.font-semibold')?.closest('.border-b') ?? null)`
  const HEADER_BTN = (icon: string): string =>
    `[...(${HEADER}?.querySelectorAll('button') ?? [])].find((b) => b.querySelector('${icon}'))`
  const NOTE = `(${PANEL}?.querySelector('[data-registry-note]') ?? null)`
  const DIALOG = `document.querySelector('.dialog-panel')`
  // 标签 + 来源（锁图标）+ 可选的「是否被遮蔽」（划线）—— 同名的几份都列出来时靠后两者分开
  const ROW = (label: string, which?: RegistryRowSource, filter: RegistryRowFilter = {}): string =>
    `${ROWS}.find((r) =>
      (r.querySelector('.font-medium')?.textContent ?? '').trim() === ${JSON.stringify(label)} &&
      (${JSON.stringify(which ?? '')} === '' || (${JSON.stringify(which ?? '')} === 'builtin') === !!r.querySelector('.lucide-lock')) &&
      (${JSON.stringify(filter.overridden ?? null)} === null || ${JSON.stringify(filter.overridden ?? null)} === !!r.querySelector('.line-through')))`

  const noteFile = (): Promise<string> =>
    settings.eval<string>(`${NOTE}?.getAttribute('data-registry-note') ?? ''`)

  /**
   * 等一份**新**笔记挂上（文件名与 before 不同 + 属性卡上屏）。新建 / 覆盖副本失败时详情区顶部
   * 出页级错误框（右栏第一个子节点）—— until 会吞掉轮询期异常，故失败经返回值传出来再抛。
   */
  const waitNewNote = async (before: string, what: string): Promise<string> => {
    const outcome = await until<{ file: string } | { rejected: string } | null>(async () => {
      const state = await settings.eval<{ file: string; card: boolean; error: string }>(`(() => {
        const note = ${NOTE}
        const first = ${PANEL}?.firstElementChild ?? null
        const isError = !!first && first.className.includes('bg-red-500/10')
        return {
          file: note?.getAttribute('data-registry-note') ?? '',
          card: !!note?.querySelector('.cm-shuvix-fmcard'),
          error: isError ? (first.textContent ?? '').trim() : ''
        }
      })()`)
      if (state.file && state.file !== before && state.card) return { file: state.file }
      if (state.error) return { rejected: state.error }
      return null
    }, what)
    if ('rejected' in outcome) throw new Error(`${what} rejected: ${outcome.rejected}`)
    return outcome.file
  }

  return {
    rawRows: () =>
      settings.eval<RegistryRowShot[]>(`${ROWS}.map((r) => ({
        label: (r.querySelector('.font-medium')?.textContent ?? '').trim(),
        subtitle: (r.querySelector('.font-mono')?.textContent ?? '').trim(),
        struck: !!r.querySelector('.line-through'),
        overriddenBadge: [...r.querySelectorAll('span')].some((s) => /覆盖|Overridden|上書き/.test(s.textContent ?? '')),
        selected: r.className.includes('bg-accent/10'),
        builtin: !!r.querySelector('.lucide-lock')
      }))`),

    selectRow: async (label, which, opts) => {
      // 找行与「等详情挂好」用的是同一个带筛选的定位 —— 同名两行里点了哪行，就等哪行选中
      const row = ROW(label, which, opts)
      await until(() => settings.eval<boolean>(`!!(${row})`), `registry row "${label}"`)
      const builtin = await settings.eval<boolean>(`(() => {
        const r = ${row}
        r.click()
        return !!r.querySelector('.lucide-lock')
      })()`)
      await until(
        () =>
          settings.eval<boolean>(`(() => {
            const r = ${row}
            if (!r || !r.className.includes('bg-accent/10')) return false
            const panel = ${PANEL}
            const title = (panel?.querySelector('span.text-sm.font-semibold')?.textContent ?? '').trim()
            if (title !== ${JSON.stringify(label)}) return false
            const note = panel.querySelector('[data-registry-note]')
            // 注册表 md 恒以 frontmatter 开头：两种详情都等属性卡上屏（槽位 / 开关的读数挂在卡上）
            return ${builtin}
              ? !note && !!panel.querySelector('.cm-shuvix-fmcard')
              : !!note?.querySelector('.cm-shuvix-fmcard')
          })()`),
        `registry detail mounted for "${label}"`
      )
    },

    refresh: async () => {
      await settings.eval(`${COLUMN_BTN('.lucide-refresh-cw')}.click()`)
      // 重扫期间按钮置灰（refreshing），恢复可点 = 这一轮 list + listInvalid 已回来并落进 state
      await until(
        () => settings.eval<boolean>(`${COLUMN_BTN('.lucide-refresh-cw')}?.disabled === false`),
        'registry list rescanned'
      )
      await sleep(150)
    },

    invalidRows: () =>
      settings.eval<string[]>(`${INVALID_ROWS}.map((b) => (b.textContent ?? '').trim())`),

    selectInvalidRow: async (fileName) => {
      const row = `${INVALID_ROWS}.find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(fileName)})`
      await until(() => settings.eval<boolean>(`!!(${row})`), `invalid row "${fileName}"`)
      await settings.eval(`${row}.click()`)
      await until(
        () =>
          settings.eval<boolean>(`(() => {
            const note = ${NOTE}
            return note?.getAttribute('data-registry-note') === ${JSON.stringify(fileName)} &&
              !!note.querySelector('.cm-content')
          })()`),
        `note mounted for invalid file "${fileName}"`
      )
    },

    selectedInvalid: () =>
      settings.eval<string>(
        `(${INVALID_ROWS}.find((b) => b.className.includes('bg-amber-500/10'))?.textContent ?? '').trim()`
      ),

    clickNew: async () => {
      const before = await noteFile()
      await settings.eval(`${COLUMN_BTN('.lucide-plus')}.click()`)
      return waitNewNote(before, 'new registry file')
    },

    clickCreateOverride: async () => {
      await until(
        () => settings.eval<boolean>(`!!${HEADER_BTN('.lucide-copy')}`),
        'create-override action'
      )
      const before = await noteFile()
      await settings.eval(`${HEADER_BTN('.lucide-copy')}.click()`)
      return waitNewNote(before, 'override copy')
    },

    clickDelete: async () => {
      await until(
        () => settings.eval<boolean>(`!!${HEADER_BTN('.lucide-trash-2')}`),
        'delete action'
      )
      await settings.eval(`${HEADER_BTN('.lucide-trash-2')}.click()`)
      await until(() => settings.eval<boolean>(`${DIALOG} !== null`), 'delete confirm dialog')
    },

    confirmDialog: () =>
      settings.eval<RegistryConfirmSnapshot>(`(() => {
        const panel = ${DIALOG}
        if (!panel) return { open: false, title: '', description: '' }
        return {
          open: true,
          title: (panel.querySelector('h3')?.textContent ?? '').trim(),
          description: (panel.querySelector('h3 + div')?.textContent ?? '').trim()
        }
      })()`),

    confirmDialogConfirm: async () => {
      await settings.eval(`[...${DIALOG}.querySelectorAll('button')][1].click()`)
      await until(() => settings.eval<boolean>(`${DIALOG} === null`), 'confirm dialog closed')
      // 确认框先关、删除与重扫随后异步落定 —— 断言方仍应 until，这里只让出一拍
      await sleep(300)
    },

    noteFile,

    headerTitle: () =>
      settings.eval<string>(
        `(${HEADER}?.querySelector('span.text-sm.font-semibold')?.textContent ?? '').trim()`
      ),

    headerLines: () =>
      settings.eval<string[]>(`(() => {
        // 头部左栏 = 标题 span 的祖父节点：标题行 → 路径 / 提示 →（同名里输掉时）谁压过了它
        const column = ${HEADER}?.querySelector('span.text-sm.font-semibold')?.parentElement?.parentElement
        return column ? [...column.children].map((c) => (c.textContent ?? '').trim()) : []
      })()`),

    reasonText: () =>
      settings.eval<string>(
        `[...(${PANEL}?.querySelectorAll('div') ?? [])]
          .filter((d) => d.className.includes('bg-red-500/10') && !d.closest('[data-registry-note]') && !d.closest('.cm-editor'))
          .map((d) => (d.textContent ?? '').trim())
          .join('\\n')`
      ),

    headerIcons: () =>
      settings.eval<RegistryHeaderIcons>(`(() => {
        const btns = [...(${HEADER}?.querySelectorAll('button') ?? [])]
        const has = (icon) => btns.some((b) => b.querySelector(icon))
        return { trash: has('.lucide-trash-2'), save: has('.lucide-save'), copy: has('.lucide-copy') }
      })()`),

    inputs: () =>
      settings.eval<{ count: number; disabled: boolean }>(`(() => {
        const els = [...(${PANEL}?.querySelectorAll('.cm-shuvix-fmcard-input') ?? [])]
        return { count: els.length, disabled: els.length > 0 && els.every((i) => i.disabled) }
      })()`)
  }
}

export interface AgentsPaneRow {
  displayName: string
  struck: boolean
  overriddenBadge: boolean
  selected: boolean
  builtin: boolean
}

export interface AgentsPane extends RegistryTabPane {
  rows(): Promise<AgentsPaneRow[]>
  /**
   * 点一行并等详情挂好（见本节开头的就绪判据）；`which` 在覆盖后两行同名时点名来源，
   * `opts.overridden` 再分开同名的几份用户文件（划线的那几行是输掉的）
   */
  selectRow(displayName: string, which?: RegistryRowSource, opts?: RegistryRowFilter): Promise<void>
  /**
   * 详情面板 —— 内置是等价 md 的只读查看、自定义档案是它的笔记本，两者都是「md 原文 + 属性卡」，
   * 故这里读的是卡片：
   *   fieldKeys  卡片各行的 frontmatter 键（`data-key`，locale-free，优先用它断言）
   *   cardBadge  类型徽章文案（'ShuviX agent · v1'）
   *   toggles / togglesDisabled  布尔字段开关数与是否全部只读（内置档案只读）
   *   slots      选择器槽位数（model / tools / instruction-files 可编辑时各一个）
   *   hasDeleteButton / hasSaveButton  面板里的删除 / 保存图标（笔记本自动保存，恒无保存）
   */
  detail(): Promise<{
    fieldKeys: string[]
    cardBadge: string
    toggles: number
    togglesDisabled: boolean
    slots: number
    hasDeleteButton: boolean
    hasSaveButton: boolean
  }>
}

/** 设置窗口「智能体」tab（openSettings('agents') 后调用；等首屏详情就绪） */
export async function agentsPane(settings: CdpClient): Promise<AgentsPane> {
  await until(
    () => settings.eval<boolean>(`document.querySelector('.cm-content') !== null`),
    'agents tab ready'
  )
  const { rawRows, ...common } = registryTabPane(settings, '220px')

  return {
    ...common,
    rows: async () =>
      (await rawRows()).map((r) => ({
        displayName: r.label,
        struck: r.struck,
        overriddenBadge: r.overriddenBadge,
        selected: r.selected,
        builtin: r.builtin
      })),
    detail: () =>
      settings.eval(`(() => {
        // 右面板恒是列表列的下一个兄弟（两栏布局）
        const col = [...document.querySelectorAll('.w-\\\\[220px\\\\]')].pop()
        const pane = col?.nextElementSibling
        const toggles = [...pane.querySelectorAll('.cm-shuvix-fmcard-toggle')]
        return {
          fieldKeys: [...pane.querySelectorAll('.cm-shuvix-fmcard-row')].map((r) => r.dataset.key),
          cardBadge: pane.querySelector('.cm-shuvix-fmcard-badge')?.textContent.trim() ?? '',
          toggles: toggles.length,
          togglesDisabled: toggles.length > 0 && toggles.every((b) => b.disabled),
          slots: pane.querySelectorAll('.cm-shuvix-fmcard-slot').length,
          hasDeleteButton: [...pane.querySelectorAll('button')].some((b) => b.querySelector('.lucide-trash-2')),
          hasSaveButton: [...pane.querySelectorAll('button')].some((b) => b.querySelector('.lucide-save'))
        }
      })()`)
  }
}

export interface PoliciesPaneRow {
  name: string
  struck: boolean
  overriddenBadge: boolean
  /** 当前选中行（选中态是 accent 配色，不是 aria 属性） */
  selected: boolean
  builtin: boolean
}

export interface PoliciesPane extends RegistryTabPane {
  rows(): Promise<PoliciesPaneRow[]>
  /**
   * 点一行并等详情挂好（见本节开头的就绪判据）；`which` 在覆盖后两行同名时点名来源，
   * `opts.overridden` 再分开同名的几份用户文件（划线的那几行是输掉的）
   */
  selectRow(name: string, which?: RegistryRowSource, opts?: RegistryRowFilter): Promise<void>
  /**
   * 详情 —— 内置是等价 md 的只读查看、用户策略是它的笔记本，两者都是「md 原文 + 属性卡」，
   * 故这里读的是卡片：
   *   sourceBadge      来源徽标（内置 / 自定义）
   *   cardBadge        类型徽章（'ShuviX policy · v1'）
   *   fieldKeys        卡片各行的 frontmatter 键（data-key，locale-free）
   *   effectBadges/Texts  规则摘要里的 effect 徽章数与**原始 effect 名**
   *                    （卡片按 md 原文展示 deny/ask/force-allow，不做本地化 —— 所见即引擎所评估）
   *   hasScope         策略级 scope 行有值（非「未设置」）
   *   conditionLines   各规则行的条件/match 摘要文本
   *   rulePrompts      各规则的人读提示语行（没写 prompt 的规则不产生这一行，故长度可小于规则数）
   *   hasRationale     正文（Rationale）已渲染进 CM6
   *   actionButtons    面板里 CM6 之外的按钮数（头部动作；断言优先用 headerIcons 按图标认）
   *   inputs/slots     可编辑控件数（内置只读时照常渲染、全部禁用）
   */
  detail(): Promise<{
    sourceBadge: string
    cardBadge: string
    fieldKeys: string[]
    effectBadges: number
    effectBadgeTexts: string[]
    hasScope: boolean
    conditionLines: string[]
    rulePrompts: string[]
    hasRationale: boolean
    actionButtons: number
    inputs: number
    /** 输入框是否全部禁用（只读态的判据 —— 控件照常渲染，只是不可交互） */
    inputsDisabled: boolean
    slots: number
  }>
}

/** 设置窗口「安全策略」tab（openSettings('policies') 后调用；等列表就绪） */
export async function policiesPane(settings: CdpClient): Promise<PoliciesPane> {
  // 按「含策略名的 .font-medium」认行，**不要**按图标认：列表图标随 object.type 变
  // （path→FileText / command→Terminal / gitTool→GitBranch / database→Database，
  // 未声明 object.type 的策略才回退 Shield），按图标筛会只剩零星几行。
  const { rawRows, ...common } = registryTabPane(settings, '220px')
  await until(async () => (await rawRows()).length > 0, 'policies tab ready')

  return {
    ...common,
    rows: async () =>
      (await rawRows()).map((r) => ({
        name: r.label,
        struck: r.struck,
        overriddenBadge: r.overriddenBadge,
        selected: r.selected,
        builtin: r.builtin
      })),
    detail: () =>
      settings.eval(`(() => {
        // 右面板恒是列表列的下一个兄弟（PolicySettings 的两栏布局）
        const col = [...document.querySelectorAll('.w-\\\\[220px\\\\]')].pop()
        const pane = col.nextElementSibling
        const effects = [...pane.querySelectorAll('.cm-shuvix-fmcard-effect')]
        const scopeRow = pane.querySelector('[data-key="shuvix-policy-scope"]')
        return {
          sourceBadge: pane.querySelector('span.text-\\\\[9px\\\\]')?.textContent.trim() ?? '',
          cardBadge: pane.querySelector('.cm-shuvix-fmcard-badge')?.textContent.trim() ?? '',
          fieldKeys: [...pane.querySelectorAll('.cm-shuvix-fmcard-row')].map((r) => r.dataset.key),
          effectBadges: effects.length,
          effectBadgeTexts: effects.map((e) => e.textContent.trim()),
          hasScope: !!scopeRow && !scopeRow.querySelector('.cm-shuvix-fmcard-unset'),
          conditionLines: [...pane.querySelectorAll('.cm-shuvix-fmcard-rule-text')].map((e) =>
            e.textContent.trim()
          ),
          rulePrompts: [...pane.querySelectorAll('.cm-shuvix-fmcard-rule-prompt')].map((e) =>
            e.textContent.trim()
          ),
          hasRationale: (pane.querySelector('.cm-content')?.textContent ?? '').trim().length > 0,
          actionButtons: [...pane.querySelectorAll('button')].filter(
            (b) => !b.closest('.cm-editor')
          ).length,
          inputs: pane.querySelectorAll('.cm-shuvix-fmcard-input').length,
          inputsDisabled: [...pane.querySelectorAll('.cm-shuvix-fmcard-input')].every(
            (i) => i.disabled
          ),
          slots: pane.querySelectorAll('.cm-shuvix-fmcard-slot').length
        }
      })()`)
  }
}

export interface HooksPaneRow {
  name: string
  /** 行内副标题 `<agent> · <trigger>, <trigger>`（HookRow 的 hint：派谁 · 什么时候会跑） */
  hint: string
  struck: boolean
  overriddenBadge: boolean
  selected: boolean
  builtin: boolean
}

export interface HooksPane extends RegistryTabPane {
  rows(): Promise<HooksPaneRow[]>
  /**
   * 点一行并等详情挂好（见本节开头的就绪判据）；`which` 在覆盖后两行同名时点名来源，
   * `opts.overridden` 再分开同名的几份用户文件（划线的那几行是输掉的）
   */
  selectRow(name: string, which?: RegistryRowSource, opts?: RegistryRowFilter): Promise<void>
}

/**
 * 设置窗口「Hooks」tab（openSettings('hooks') 后调用；等列表就绪）。
 * 与另外两个 tab 的差别只在左列宽 240px、行多一行 `agent · 触发器` 副标题（hint）、以及选中
 * 解析不过的文件时头部与笔记之间多一个拒绝原因红框（解析器原文，与属性卡横幅同源 —— reasonText）。
 * 内置 hook 没有 detail()：它的只读详情用公共面的 inputs() / headerIcons() 断言。
 */
export async function hooksPane(settings: CdpClient): Promise<HooksPane> {
  const { rawRows, ...common } = registryTabPane(settings, '240px')
  await until(async () => (await rawRows()).length > 0, 'hooks tab ready')

  return {
    ...common,
    rows: async () =>
      (await rawRows()).map((r) => ({
        name: r.label,
        hint: r.subtitle,
        struck: r.struck,
        overriddenBadge: r.overriddenBadge,
        selected: r.selected,
        builtin: r.builtin
      }))
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 注册表笔记（bot / agent / 策略 / hook md 的笔记本会话）的正文与属性卡 —— 两个窗口共用。
//
// 作用域：主窗里点 Bots 分组的一行，主区就是那份文件的笔记本（同一时刻只有它一个 .cm-content），
// 作用域是整个 document；设置窗里是详情区的 `[data-registry-note]`（RegistryNoteView 根）——
// 收在它里面，免得读到内置条目的只读预览，没有开着的笔记时一切读数为空。
//
// 写入只走两条路，**绝不往 CodeMirror 里打字**：属性卡字段 `commitField`（真实编辑路径：失焦
// 提交 → 行级 scoped edit → 200ms 防抖自动保存落盘），或 seed.ts 的 `noteWrite`（写路径 IPC）。
//
// `mark()` / `isMarked()` 是挂在 `[data-registry-note]` 元素上的 JS 属性（刻意不是 data-*）：
// 重挂载会造出一个新元素、标记随之消失 —— 「改名 / 合法性翻面时笔记没被卸载重开」的判据。

/** 属性卡校验徽章的语义类（'' = 未上屏，或该类型没有校验器） */
export type FmCardStatus = 'ok' | 'warn' | 'err' | ''

export interface RegistryNotePane {
  /** 等正文（.cm-content）里出现特征串 */
  waitBody(marker: string): Promise<void>
  /** 正文文本（没有笔记为空串） */
  bodyText(): Promise<string>
  /** 等属性卡上屏（只等卡片本身；校验态是异步回来的，要等它用 waitStatus） */
  waitCard(): Promise<void>
  cardBadge(): Promise<string>
  cardStatus(): Promise<FmCardStatus>
  /** 等校验徽章落到指定语义类 */
  waitStatus(status: Exclude<FmCardStatus, ''>): Promise<void>
  /** 校验横幅文本（解析器原文，逐行以换行连接）；横幅隐藏时为空串 */
  bannerText(): Promise<string>
  /** 卡片文本字段（textarea）的当前值；字段不在返回 null */
  fieldValue(key: string): Promise<string | null>
  /** 改一个文本字段：写 value + 派发 blur（卡片失焦即提交）；字段不存在或只读则抛 */
  commitField(key: string, value: string): Promise<void>
  mark(): Promise<void>
  isMarked(): Promise<boolean>
}

export function registryNotePane(client: CdpClient): RegistryNotePane {
  const ROOT = `(location.hash.startsWith('#settings') ? document.querySelector('[data-registry-note]') : document)`
  const FIELD = (key: string): string =>
    `${ROOT}?.querySelector('.cm-shuvix-fmcard-input[data-key=${JSON.stringify(key)}]')`
  const NOTE_EL = `document.querySelector('[data-registry-note]')`
  const MARK = '__e2eRegistryNoteMark'

  const bodyText = (): Promise<string> =>
    client.eval<string>(`${ROOT}?.querySelector('.cm-content')?.textContent ?? ''`)
  const cardStatus = (): Promise<FmCardStatus> =>
    client.eval<FmCardStatus>(`(() => {
      const cls = ${ROOT}?.querySelector('.cm-shuvix-fmcard-status')?.className ?? ''
      return /is-(ok|warn|err)/.exec(cls)?.[1] ?? ''
    })()`)

  return {
    waitBody: async (marker) => {
      await until(
        async () => (await bodyText()).includes(marker),
        `note body shows ${JSON.stringify(marker)}`
      )
    },
    bodyText,
    waitCard: async () => {
      await until(
        () => client.eval<boolean>(`!!${ROOT}?.querySelector('.cm-shuvix-fmcard')`),
        'frontmatter card mounted'
      )
    },
    cardBadge: () =>
      client.eval<string>(
        `(${ROOT}?.querySelector('.cm-shuvix-fmcard-badge')?.textContent ?? '').trim()`
      ),
    cardStatus,
    waitStatus: async (status) => {
      await until(async () => (await cardStatus()) === status, `card status is-${status}`)
    },
    bannerText: () =>
      client.eval<string>(`(() => {
        const banner = ${ROOT}?.querySelector('.cm-shuvix-fmcard-banner')
        if (!banner || banner.hidden) return ''
        return [...banner.querySelectorAll('.cm-shuvix-fmcard-banner-line')]
          .map((n) => n.textContent ?? '')
          .join('\\n')
      })()`),
    fieldValue: (key) => client.eval<string | null>(`${FIELD(key)}?.value ?? null`),
    commitField: async (key, value) => {
      await until(() => client.eval<boolean>(`!!${FIELD(key)}`), `card field "${key}"`)
      const outcome = await client.eval<string>(`(() => {
        const input = ${FIELD(key)}
        if (!input) return 'missing'
        if (input.disabled) return 'read-only'
        input.value = ${JSON.stringify(value)}
        // 卡片在 blur 上提交（行级 scoped edit），不经 React —— 直接派发即走真实提交路径
        input.dispatchEvent(new Event('blur'))
        return 'ok'
      })()`)
      if (outcome !== 'ok') throw new Error(`card field "${key}" is ${outcome}`)
    },
    mark: async () => {
      const marked = await client.eval<boolean>(`(() => {
        const note = ${NOTE_EL}
        if (!note) return false
        note.${MARK} = true
        return true
      })()`)
      if (!marked) throw new Error('no [data-registry-note] element to mark')
    },
    isMarked: () => client.eval<boolean>(`${NOTE_EL}?.${MARK} === true`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// frontmatter 属性卡的**字段槽位**（可编辑宿主：笔记本注入 mountField）
//
// 卡片自有的 `.cm-shuvix-fmcard*` 钩子稳定，spec 里可直接内联；但槽位里挂的是
// 仓库既有的成熟组件（csv → ToolSelectList，select → ModelSelect），它们的 DOM
// 是**外部结构**（紧凑列表的 label/checkbox、模型面板的分组头/型号按钮、portal
// 出去的 `.picker-panel`）—— 那部分选择器一律收在这里，组件重构只修一处。
//
// 两个实测差异写进方法名/实现，spec 不必再记：
//   - 工具触发器监听 **mousedown**（卡内交互一律阻止默认以免夺走光标），
//     模型触发器监听 **click**；
//   - ToolSelectList 的勾选走 `input.click()`（React onChange 走 click 通道），
//     而这条路径**不发 mousedown**，故不会误触发弹层的「点外部关闭」
//     （那个监听是 document 捕获阶段的 mousedown）。

export interface FmCardPanelGeometry {
  /** portal 直挂 body —— 卡片盒子 overflow-hidden，absolute 弹层会被裁掉 */
  inBody: boolean
  /** 是否仍在卡片子树内（应为 false） */
  insideCard: boolean
  /** 面板矩形完整落在视口内 */
  withinViewport: boolean
  /** 面板中心点的命中元素落在面板内部（被遮挡/被裁切时为 false） */
  centerHitsPanel: boolean
  width: number
  height: number
}

export interface FmCardToolItem {
  /** 列表展示名（mcp:/skill: 条目在此显示短名） */
  name: string
  checked: boolean
}

export interface FmCardPane {
  /**
   * 等属性卡**整张就绪**（读任何槽位内容之前都先过这一关）。
   *
   * 卡片进 DOM 只是第一步：`.cm-shuvix-fmcard` 与空的 `.cm-shuvix-fmcard-slot` 是
   * CM6 widget 同步建的，槽位**里面**的选择器则由宿主用独立 React root 异步挂载
   * （`createRoot().render()` 是调度执行的，实测滞后 5~6ms）。只等卡片/槽位存在就读
   * 触发器文案，会踩进这段空窗期读到空串。`slots` 给定时顺带把槽位数当就绪条件。
   */
  waitReady(opts?: { slots?: number }): Promise<void>
  /** 字段行的触发器文案（工具：归一后的逗号串 / 模型：提供商 · 型号 或占位） */
  triggerText(key: string): Promise<string>
  /** 槽位内按钮数（模型字段：1 = 仅触发器，2 = 触发器 + 清除入口） */
  slotButtons(key: string): Promise<number>

  /** 工具弹层：开（触发器 mousedown）并等列表拉回 */
  openTools(): Promise<void>
  toolsOpen(): Promise<boolean>
  toolsGeometry(): Promise<FmCardPanelGeometry | null>
  /** 弹层里的候选项（展示名 + 勾选态） */
  toolItems(): Promise<FmCardToolItem[]>
  /** 勾选/取消勾选一项；候选项不存在返回 false */
  clickTool(name: string): Promise<boolean>
  /** 在弹层内部按下鼠标（「点内部不关」的探针） */
  mousedownInsideTools(): Promise<void>

  /** 模型面板：开（触发器 click）并等 portal 上屏 */
  openModel(): Promise<void>
  modelOpen(): Promise<boolean>
  /** 面板里的提供商分组名（型号按钮带 pl-5，据此与分组头区分） */
  modelGroups(): Promise<string[]>
  /** 展开一个分组（默认全折叠，只有当前选中的提供商展开） */
  expandModelGroup(label: string): Promise<boolean>
  /** 点选型号；未展开/不存在返回 false */
  pickModel(modelId: string): Promise<boolean>
  /** 点槽位里的清除入口（未选态没有该按钮） */
  clearModel(): Promise<void>

  /** 全局关闭手势（弹层监听的是 document 捕获阶段） */
  pressEscape(): Promise<void>
  clickOutside(): Promise<void>
}

/** 主窗笔记本里的属性卡字段槽位（可编辑宿主） */
export function fmCardPane(main: CdpClient): FmCardPane {
  // 字段行一律按 data-key 定位 —— 标签文案是 i18n 产物，描述符顺序会随字段增删漂移
  const SLOT = (key: string): string =>
    `document.querySelector('.cm-shuvix-fmcard-row[data-key=${JSON.stringify(key)}] .cm-shuvix-fmcard-slot')`
  const TOOLS_PANEL = `document.querySelector('.cm-shuvix-fmcard-tools-panel')`
  const TOOL_LABELS = `[...document.querySelectorAll('.cm-shuvix-fmcard-tools-panel label')]`
  const MODEL_PANEL = `document.querySelector('.picker-panel')`
  const MODEL_BUTTONS = `[...document.querySelectorAll('.picker-panel button')]`

  const toolsOpen = (): Promise<boolean> => main.eval<boolean>(`${TOOLS_PANEL} !== null`)
  const modelOpen = (): Promise<boolean> => main.eval<boolean>(`${MODEL_PANEL} !== null`)

  return {
    waitReady: async ({ slots } = {}) => {
      await until(
        () =>
          main.eval<boolean>(`(() => {
            if (!document.querySelector('.cm-shuvix-fmcard')) return false
            const els = [...document.querySelectorAll('.cm-shuvix-fmcard-slot')]
            ${slots === undefined ? '' : `if (els.length !== ${slots}) return false`}
            // 槽位里有子节点 = 宿主的 React root 已挂完（空槽位读文案只会读到空串）
            return els.every((el) => el.childElementCount > 0)
          })()`),
        `frontmatter card ready${slots === undefined ? '' : ` (${slots} slots)`}`
      )
    },
    triggerText: (key) =>
      main.eval<string>(`(${SLOT(key)}?.querySelector('button')?.textContent ?? '').trim()`),
    slotButtons: (key) => main.eval<number>(`${SLOT(key)}?.querySelectorAll('button').length ?? 0`),

    openTools: async () => {
      await main.eval(
        `${SLOT('shuvix-tools')}.querySelector('button')` +
          `.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`
      )
      // 候选项是打开后才拉的（tools.list()）——等列表落定，否则勾选会扑空
      await until(() => main.eval<number>(`${TOOL_LABELS}.length`), 'tools panel populated')
    },
    toolsOpen,
    toolsGeometry: () =>
      main.eval(`(() => {
        const p = ${TOOLS_PANEL}
        if (!p) return null
        const r = p.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return {
          inBody: p.parentElement === document.body,
          insideCard: p.closest('.cm-shuvix-fmcard') !== null,
          withinViewport:
            r.left >= 0 && r.top >= 0 &&
            r.right <= window.innerWidth && r.bottom <= window.innerHeight,
          centerHitsPanel: !!hit && p.contains(hit),
          width: r.width,
          height: r.height
        }
      })()`),
    toolItems: () =>
      main.eval(`${TOOL_LABELS}.map((l) => ({
        name: (l.querySelector('span')?.textContent ?? '').trim(),
        checked: !!l.querySelector('input')?.checked
      }))`),
    clickTool: (name) =>
      main.eval<boolean>(`(() => {
        const label = ${TOOL_LABELS}.find(
          (l) => (l.querySelector('span')?.textContent ?? '').trim() === ${JSON.stringify(name)}
        )
        if (!label) return false
        label.querySelector('input').click()
        return true
      })()`),
    mousedownInsideTools: async () => {
      await main.eval(
        `${TOOLS_PANEL}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`
      )
      await new Promise((r) => setTimeout(r, 200))
    },

    openModel: async () => {
      await main.eval(`${SLOT('shuvix-model')}.querySelector('button').click()`)
      await until(modelOpen, 'model picker panel mounted')
    },
    modelOpen,
    modelGroups: () =>
      main.eval(
        `${MODEL_BUTTONS}.filter((b) => !b.className.includes('pl-5')).map((b) => b.textContent.trim())`
      ),
    expandModelGroup: (label) =>
      main.eval<boolean>(`(() => {
        const head = ${MODEL_BUTTONS}.find(
          (b) => !b.className.includes('pl-5') && b.textContent.trim() === ${JSON.stringify(label)}
        )
        if (!head) return false
        head.click()
        return true
      })()`),
    pickModel: (modelId) =>
      main.eval<boolean>(`(() => {
        const item = ${MODEL_BUTTONS}.find(
          (b) => b.className.includes('pl-5') && b.textContent.trim() === ${JSON.stringify(modelId)}
        )
        if (!item) return false
        item.click()
        return true
      })()`),
    clearModel: async () => {
      await main.eval(`[...${SLOT('shuvix-model')}.querySelectorAll('button')][1].click()`)
      await new Promise((r) => setTimeout(r, 200))
    },

    pressEscape: async () => {
      await main.eval(
        `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
      )
      await new Promise((r) => setTimeout(r, 200))
    },
    clickOutside: async () => {
      await main.eval(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗侧栏「Bots」分组（BotGroup）—— 刻意只做最小面。
//
// 锚点：分组头按 `data-group="bots"`（SessionGroup 的 group/header 层）认，合法行按
// `data-bot-row=<name>`、同名里输掉的行按 `data-bot-shadowed-row=<fileName>`（紧跟胜出行，划线 +
// 覆盖徽标）、解析不过的琥珀行按 `data-bot-invalid-row=<fileName>`。点任一行打开的是
// 那份文件的**笔记本会话**（隐藏项目 `__bots__`）—— 主区就是普通笔记本，没有专门的档案页；
// 正文与属性卡经 `registryNotePane` 读写。活动行 = 活动会话正是这份文件的笔记本（rowClass 的
// active 分支 `bg-bg-active/80`）。分组是**懒扫**的：首次展开才扫，之后展开 / 窗口聚焦 / 组头
// 菜单「刷新」/ `bot.changed` 事件（笔记本写入 / 新建 / 删除）重扫 —— 磁盘外写入不广播，
// 种完 md 要 refresh。菜单走与会话行同一套桩（pickFromMenu / openMenu）。

/** 分组里的活动行：合法行给 name，同名里输掉的行与解析不过的琥珀行给文件名 */
export interface BotsActiveRow {
  row?: string
  shadowedRow?: string
  invalidRow?: string
}

/** 同名里输掉的一行（`data-bot-shadowed-row`） */
export interface BotsShadowedRow {
  fileName: string
  /** 显示名划线 */
  struck: boolean
  /** 「已被覆盖」徽标（按三语认，同设置页的 overriddenBadge） */
  badge: boolean
  /** 行的 title 提示（说清被哪份文件压过） */
  title: string
  /**
   * 紧挨着的上一行：`row:<name>`（胜出行）/ `shadowed:<fileName>`（另一份输掉的）/
   * `invalid:<fileName>`；认不出为 `other`，没有为空串 ——「输掉的行紧跟胜出行」的判据
   */
  after: string
}

export interface BotsPane {
  /** 组头显示的分组标签 */
  label(): Promise<string>
  /** 侧栏里 `data-group="bots"` 的组头个数（分组只该有一个） */
  headerCount(): Promise<number>
  /** 展开分组并等首次扫描落定（空态文案也算落定） */
  expand(): Promise<void>
  /** 合法行的 name（DOM 序） */
  rows(): Promise<string[]>
  /** 同名里输掉的行（DOM 序） */
  shadowedRows(): Promise<BotsShadowedRow[]>
  /** 非法文件行（琥珀）的文件名 */
  invalidRows(): Promise<string[]>
  /** 点一行并等它成为活动行（= 这份文件的笔记本成了活动会话） */
  selectRow(name: string): Promise<void>
  /** 点一行解析不过的文件并等它成为活动行 */
  selectInvalidRow(fileName: string): Promise<void>
  /** 当前活动行；活动会话不是任何 bot 文件的笔记本时为 null */
  activeRow(): Promise<BotsActiveRow | null>
  /** 开 bot 行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对） */
  pickRowMenu(name: string, actionId: 'new-bot-chat' | 'delete-bot'): Promise<void>
  /** 开同名里输掉那一行的 ⋮ 并选中一项（同上；它只能按文件名删） */
  pickShadowedRowMenu(fileName: string, actionId: 'delete-bot-file'): Promise<void>
  /** 开非法文件行的 ⋮ 并选中一项（同上） */
  pickInvalidRowMenu(fileName: string, actionId: 'delete-bot-file'): Promise<void>
  /** bot 行菜单里的动作 id（开一次 ⋮、不选任何项，分隔符滤掉）；⋮ 不在返回 null */
  rowMenuIds(name: string): Promise<string[] | null>
  /** 同名里输掉那一行的菜单动作 id（同上） */
  shadowedRowMenuIds(fileName: string): Promise<string[] | null>
  /** 组头菜单「新建 bot」—— 只触发；新文件落盘与笔记打开由调用方 until */
  newBot(): Promise<void>
  /** 组头菜单「刷新」—— 磁盘外改动不广播 bot.changed，需手动重扫 */
  refresh(): Promise<void>
}

export function botsPane(main: CdpClient): BotsPane {
  const HEADER_SEL = `div[class*="group/header"][data-group="bots"]`
  const HEADER = `document.querySelector('${HEADER_SEL}')`
  const TOGGLE = `[...(${HEADER}?.querySelectorAll(':scope > button') ?? [])].find((b) => b.querySelector('span.truncate'))`
  const COLLAPSE = `${HEADER}?.nextElementSibling`
  const BODY = `${COLLAPSE}?.firstElementChild?.firstElementChild`
  const ROWS = `[...document.querySelectorAll('[data-bot-row]')]`
  const SHADOWED_ROWS = `[...document.querySelectorAll('[data-bot-shadowed-row]')]`
  const INVALID_ROWS = `[...document.querySelectorAll('[data-bot-invalid-row]')]`
  const ROW = (name: string): string =>
    `document.querySelector('[data-bot-row=${JSON.stringify(name)}]')`
  const SHADOWED_ROW = (fileName: string): string =>
    `document.querySelector('[data-bot-shadowed-row=${JSON.stringify(fileName)}]')`
  const INVALID_ROW = (fileName: string): string =>
    `document.querySelector('[data-bot-invalid-row=${JSON.stringify(fileName)}]')`
  const ACTIVE = (list: string): string =>
    `${list}.find((r) => r.className.includes('bg-bg-active'))`

  /** 点一行并等它成为活动行（打开笔记是异步的：openNote → 重拉会话列表 → 选中） */
  const clickUntilActive = async (scope: string, what: string): Promise<void> => {
    await until(() => main.eval<boolean>(`${scope} !== null`), what)
    await main.eval(`${scope}.click()`)
    await until(
      () => main.eval<boolean>(`(${scope}?.className ?? '').includes('bg-bg-active')`),
      `${what} active`
    )
  }

  /** 开某一行的 ⋮（不选任何项 = 取消）并回菜单里的动作 id */
  const menuIds = async (scope: string, what: string): Promise<string[] | null> => {
    await until(() => main.eval<boolean>(`${scope} !== null`), what)
    const items = await openMenu(main, scope, 'menu-button')
    return items ? items.filter((it) => it.id).map((it) => it.id as string) : null
  }

  return {
    label: () =>
      main.eval<string>(`(${HEADER}?.querySelector('span.truncate')?.textContent ?? '').trim()`),

    headerCount: () => main.eval<number>(`document.querySelectorAll('${HEADER_SEL}').length`),

    expand: async () => {
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'bots group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (!open) await main.eval(`(${TOGGLE})?.click()`)
      // 扫描是懒的：展开才发第一次请求，正文有内容（行或空态文案）才算落定
      await until(
        () => main.eval<boolean>(`(${BODY}?.childElementCount ?? 0) > 0`),
        'bots group scanned'
      )
    },

    rows: () => main.eval<string[]>(`${ROWS}.map((r) => r.getAttribute('data-bot-row'))`),

    shadowedRows: () =>
      main.eval<BotsShadowedRow[]>(`${SHADOWED_ROWS}.map((r) => {
        const prev = r.previousElementSibling
        const after = !prev
          ? ''
          : prev.hasAttribute('data-bot-row')
            ? 'row:' + prev.getAttribute('data-bot-row')
            : prev.hasAttribute('data-bot-shadowed-row')
              ? 'shadowed:' + prev.getAttribute('data-bot-shadowed-row')
              : prev.hasAttribute('data-bot-invalid-row')
                ? 'invalid:' + prev.getAttribute('data-bot-invalid-row')
                : 'other'
        return {
          fileName: r.getAttribute('data-bot-shadowed-row') ?? '',
          struck: !!r.querySelector('.line-through'),
          badge: [...r.querySelectorAll('span')].some((s) => /覆盖|Overridden|上書き/.test(s.textContent ?? '')),
          title: r.getAttribute('title') ?? '',
          after
        }
      })`),

    invalidRows: () =>
      main.eval<string[]>(`${INVALID_ROWS}.map((r) => r.getAttribute('data-bot-invalid-row'))`),

    selectRow: (name) => clickUntilActive(ROW(name), `bot row "${name}"`),

    selectInvalidRow: (fileName) =>
      clickUntilActive(INVALID_ROW(fileName), `invalid bot row "${fileName}"`),

    activeRow: () =>
      main.eval<BotsActiveRow | null>(`(() => {
        const row = ${ACTIVE(ROWS)}
        if (row) return { row: row.getAttribute('data-bot-row') }
        const shadowed = ${ACTIVE(SHADOWED_ROWS)}
        if (shadowed) return { shadowedRow: shadowed.getAttribute('data-bot-shadowed-row') }
        const invalid = ${ACTIVE(INVALID_ROWS)}
        if (invalid) return { invalidRow: invalid.getAttribute('data-bot-invalid-row') }
        return null
      })()`),

    pickRowMenu: async (name, actionId) => {
      await until(() => main.eval<boolean>(`${ROW(name)} !== null`), `bot row "${name}"`)
      await pickFromMenu(main, ROW(name), actionId, `bot row "${name}"`)
    },

    pickShadowedRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${SHADOWED_ROW(fileName)} !== null`),
        `shadowed bot row "${fileName}"`
      )
      await pickFromMenu(main, SHADOWED_ROW(fileName), actionId, `shadowed bot row "${fileName}"`)
    },

    pickInvalidRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${INVALID_ROW(fileName)} !== null`),
        `invalid bot row "${fileName}"`
      )
      await pickFromMenu(main, INVALID_ROW(fileName), actionId, `invalid bot row "${fileName}"`)
    },

    rowMenuIds: (name) => menuIds(ROW(name), `bot row "${name}"`),

    shadowedRowMenuIds: (fileName) =>
      menuIds(SHADOWED_ROW(fileName), `shadowed bot row "${fileName}"`),

    newBot: () => pickFromMenu(main, HEADER, 'new-bot', 'bots group header'),

    refresh: async () => {
      await pickFromMenu(main, HEADER, 'refresh', 'bots group header')
      await sleep(200)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 「新建 Bot 会话」单选框（BotSessionDialog）+ bot 会话头部身份胶囊（BotBindingChip）+
// 空 bot 会话的自我介绍（WelcomeView 的 BotEmptyState）
//
// 锚点：单选框面板 `data-bot-dialog="create"`、候选行 `data-bot-pick=<name>`；胶囊外层
// `data-bot-binding=<bot>`、胶囊本体 `data-bot-bound=<bot>` + `data-bot-bound-missing="true"`
// （不缺失时属性不存在）；空态根 `data-bot-empty`、自我介绍卡 `data-bot-empty-member=<bot>`。
// 其余（加载占位、空态容器、「打开 Bots 文件夹」按钮、胶囊上的名字、卡片里的名字 / 描述）没有
// 锚点，按结构认。
//
// 「加载中」与「查无结果」在这三处渲染得一模一样：单选框都是零行、胶囊都顶身份键且不标缺失、
// 空态都只留提示行不出卡片 —— 否定断言必须先等到一个已落定的信号（见各方法说明）。

export interface BotPickerPane {
  /** 等单选框上屏 */
  waitOpen(): Promise<void>
  /** 等它真的卸载（Escape / 取消走 120ms 关闭动画，选中一行后则直接卸载） */
  waitClosed(): Promise<void>
  isOpen(): Promise<boolean>
  /** 候选行的 bot 名（DOM 序）。加载中与空列表都是 [] —— 先等行出现或 emptyStateShown */
  rows(): Promise<string[]>
  /** 点一行（行不存在返回 false） */
  pick(name: string): Promise<boolean>
  /**
   * 在**同一次** eval 里连点两下同一行。分两次 eval 的话 React 已在其间把按钮置成 disabled，
   * 第二下浏览器根本不派发 —— 防重入断言就会在没有守卫时也通过。
   *
   * `found`：行在不在。`secondClickLive`：第二下点出去那一刻按钮还没置灰 —— 这是防重入用例
   * 的**前提**，它为 false 时挡住第二下的是 disabled，测到的就不是守卫了。
   */
  pickTwiceSync(name: string): Promise<{ found: boolean; secondClickLive: boolean }>
  /**
   * 空态已落定：「打开 Bots 文件夹」按钮在屏。只做存在性判断，**绝不点**（它开的是 OS 文件
   * 管理器，e2e 关不掉）。加载占位同样零行，故「零行」只能在这个信号之后断。
   */
  emptyStateShown(): Promise<boolean>
  /** 面板整段文本 —— 归属行里的项目名是种子数据可以断，其余文案是本地化的，别断 */
  text(): Promise<string>
  /** Escape（单选框在 window 上听 keydown）；只派发不等待，关没关由 waitClosed 等 */
  pressEscape(): Promise<void>
}

/** 「新建 Bot 会话」单选框（组头菜单 new-bot-chat 拉起） */
export function botPickerPane(main: CdpClient): BotPickerPane {
  const PANEL = `document.querySelector('[data-bot-dialog="create"]')`
  const ROW = (name: string): string =>
    `${PANEL}?.querySelector('[data-bot-pick=${JSON.stringify(name)}]')`
  const isOpen = (): Promise<boolean> => main.eval<boolean>(`${PANEL} !== null`)

  return {
    waitOpen: async () => {
      await until(isOpen, 'bot picker open')
    },
    waitClosed: async () => {
      await until(async () => !(await isOpen()), 'bot picker closed')
    },
    isOpen,
    rows: () =>
      main.eval<string[]>(
        `[...(${PANEL}?.querySelectorAll('[data-bot-pick]') ?? [])].map((b) => b.getAttribute('data-bot-pick'))`
      ),
    pick: (name) =>
      main.eval<boolean>(`(() => {
        const btn = ${ROW(name)}
        if (!btn) return false
        btn.click()
        return true
      })()`),
    pickTwiceSync: (name) =>
      main.eval<{ found: boolean; secondClickLive: boolean }>(`(() => {
        const btn = ${ROW(name)}
        if (!btn) return { found: false, secondClickLive: false }
        btn.click()
        // 第二下点出去之前读一次：还没置灰 = 第二下真的派发到了按钮上
        const secondClickLive = !btn.disabled
        btn.click()
        return { found: true, secondClickLive }
      })()`),
    emptyStateShown: () =>
      main.eval<boolean>(`!!${PANEL}?.querySelector('svg.lucide-folder-open')?.closest('button')`),
    text: () => main.eval<string>(`(${PANEL}?.textContent ?? '').trim()`),
    pressEscape: async () => {
      await main.eval(`(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()`)
    }
  }
}

export interface BotChipSnapshot {
  /** `[data-bot-binding]` 的个数（头部只该有一枚；普通会话为 0） */
  count: number
  /** 胶囊绑定的 bot（`data-bot-bound`）；没有胶囊为空串 */
  bot: string
  /** md 已删的标注（`data-bot-bound-missing="true"`）。查询回来之前同样是 false */
  missing: boolean
  /** 胶囊上的名字：查到了是 displayName；查询回来之前与 md 已删时是身份键 */
  name: string
}

export interface BotChipPane {
  snapshot(): Promise<BotChipSnapshot>
}

/** bot 会话头部的身份胶囊（BotBindingChip） */
export function botChip(main: CdpClient): BotChipPane {
  return {
    snapshot: () =>
      main.eval<BotChipSnapshot>(`(() => {
        const all = [...document.querySelectorAll('[data-bot-binding]')]
        const pill = all[0]?.querySelector('[data-bot-bound]') ?? null
        return {
          count: all.length,
          bot: pill?.getAttribute('data-bot-bound') ?? '',
          missing: pill?.getAttribute('data-bot-bound-missing') === 'true',
          // 名字是胶囊本体的直接子 span（头像组件排在它前面，别让它的内部结构掺进来）
          name: (pill?.querySelector(':scope > span.truncate')?.textContent ?? '').trim()
        }
      })()`)
  }
}

export interface BotIntroSnapshot {
  /** bot 会话空态根（`data-bot-empty`）在屏 —— 只要是空的 bot 会话就在，与 md 在不在无关 */
  present: boolean
  /** 自我介绍卡绑定的 bot（`data-bot-empty-member`）；加载中与 md 已删时没有卡片，为空串 */
  member: string
  /** 卡片的整段文本（名字 + 描述）；不含卡片外那行本地化提示，没有卡片为空串 */
  text: string
}

export interface BotIntroPane {
  snapshot(): Promise<BotIntroSnapshot>
}

/** 空 bot 会话里 bot 的自我介绍（桌面 WelcomeView 的 BotEmptyState） */
export function botIntro(main: CdpClient): BotIntroPane {
  return {
    snapshot: () =>
      main.eval<BotIntroSnapshot>(`(() => {
        const root = document.querySelector('[data-bot-empty]')
        const card = root?.querySelector('[data-bot-empty-member]') ?? null
        return {
          present: root !== null,
          member: card?.getAttribute('data-bot-empty-member') ?? '',
          text: (card?.textContent ?? '').trim()
        }
      })()`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗侧栏「知识库」分组（KnowledgeGroup）+ 从它打开的知识库笔记本
//
// 锚点：组头 `data-group="knowledge"`（SessionGroup 的 group/header 层）；目录行
// `data-knowledge-dir=<目录 id>`、条目行 `data-knowledge-row=<条目 id>`。id 与清单同一个名字空间
// （`projects/<projectId>/…` 相对 knowledge-shuvix 根，`knowledge/<库名>/…` 相对用户根）；行名是行内
// 唯一的 span.truncate。
//
// 层级只能从行的内联 `padding-left` 读（最外层 0px —— Projects 容器与每个用户库平级 —— 每深一层 +12px）。
// 目录行与它的正文（AnimatedCollapse 根）是兄弟节点，折叠只收高度、行都还在 DOM 里：展开态读正文的内联
// `gridTemplateRows`，不数行。路径可能含中文：定位一律 getAttribute 逐个比对，不拼属性选择器。
//
// 清单是懒扫的：首次展开分组才拉，之后展开 / 窗口聚焦 / `knowledge.changed` / 组头菜单「刷新」重扫 ——
// 磁盘外写入不广播，种子要在首次展开之前写好，事后写的要 `refresh()`。点行打开的是那份文件的笔记本会话
// （隐藏承载项目），主区就是普通笔记本：同一时刻只有它一个 `.cm-content` / 属性卡，作用域取整个 document。
//
// ⚠️ 组头菜单的 `open-folder` 与行菜单的 `reveal` **只许读，绝不选**：隔离实例没有替换 `shell`，
// 选中会在运行 e2e 的真实桌面上弹出文件管理器 —— pickRowMenu 遇到它们直接抛错。
//
// ⚠️ 内联新建行（`data-knowledge-draft`）**失焦即取消**：草稿开着的时候任何 `click()` 都会顺手把它
// 杀掉，所以读断言一律走 main.eval（draftKind / draftValue / draftError），别点任何东西。输入走
// native value setter（React 受控输入不认直接赋值），Enter / Escape 是派发到输入框上的冒泡 keydown。

/** 知识库分组里的一行目录 */
export interface KnowledgeDirShot {
  /** `data-knowledge-dir`：`projects` / `projects/<projectId>` / `knowledge/<库名>` / 更深的子目录 */
  path: string
  /** 行上的名字（Projects 容器是本地化文案，项目库是项目当前名字，其余是目录名） */
  label: string
  /** 行的内联 padding-left（'0px' = 顶层，每深一层 +12px） */
  indent: string
  /** `data-knowledge-readonly`（随应用发布的内置库及其每一层）；普通目录该属性不在 → false */
  readonly: boolean
  /**
   * 行首那枚图标的 class 串（lucide 的组件名落在类名里）。**只比不解**：图标名会随
   * 设计改，用例断的是「这两行的图标不一样」「身份行的图标不随展开变」，不是某个具体名字。
   */
  icon: string
  /** 行尾那把锁（只读的内置库、只挂在库那一行；`span[aria-label]` 里的图标） */
  lock: boolean
}

/** 知识库分组里的一行条目 */
export interface KnowledgeRowShot {
  /** `data-knowledge-row`：条目 id */
  path: string
  /** 行上的名字（合规条目取 title，其余取文件名 stem） */
  label: string
}

/** 内联新建行的三种落点（`data-knowledge-draft` 的属性值） */
export type KnowledgeDraftKind = 'base' | 'folder' | 'entry'

/** 知识库笔记本里属性卡的读数 */
export interface KnowledgeCardShot {
  /** 类型徽章（兜底出的卡没有版本段：'OKF entry'；带自述行的是 'OKF entry · v0.2' 之类） */
  badge: string
  /** 卡上的下拉字段（行的 data-key + 当前值），卡片行序 */
  selects: Array<{ key: string; value: string }>
  /** 校验徽章节点（没有校验器的类型恒隐藏、无 is-* 类）；节点不在为 null */
  status: { hidden: boolean; className: string } | null
}

/**
 * 属性卡的**可编辑性**读数 —— 只读笔记本（内置知识库）里下拉与文本字段一律 disabled。
 * 与 `KnowledgeCardShot.selects` 分开两个读数：那一份被既有用例整体 `toEqual` 比对，
 * 往里加字段会把它们全弄红。
 */
export interface KnowledgeCardFieldsShot {
  /** 每个下拉字段的 data-key 与 disabled，卡片行序 */
  selects: Array<{ key: string; disabled: boolean }>
  /** 卡上文本类输入框的总数 / 其中 disabled 的个数（只读时两者相等且 > 0） */
  inputs: number
  inputsDisabled: number
}

export interface KnowledgePane {
  /** 展开分组并等首次清单落定（正文里出现行或空态文案） */
  expand(): Promise<void>
  /** 全部目录行（任意层级），DOM 序 */
  dirs(): Promise<KnowledgeDirShot[]>
  /** 顶层目录行（缩进 0px：Projects 容器与每个用户库），DOM 序 */
  topDirs(): Promise<KnowledgeDirShot[]>
  /** 目录是否展开；目录行不存在返回 false */
  dirOpen(path: string): Promise<boolean>
  /** 把目录设成指定展开态并等它落定（幂等） */
  setDirOpen(path: string, open: boolean): Promise<void>
  /** 全部条目行（含折叠目录里的 —— 折叠只收高度），DOM 序 */
  rows(): Promise<KnowledgeRowShot[]>
  /**
   * 点一行并等它成为活动行（行的 bg-bg-active）= 这份文件的笔记本成了活动会话
   * （openNote → 重拉会话列表 → 选中，全是异步的）。**不等正文**：切换后先 waitBody。
   */
  openRow(path: string): Promise<void>
  /** 活动行的条目 id；没有为空串 */
  activeRow(): Promise<string>
  /** 组头菜单的动作 id（开一次 ⋮、不选任何项，分隔符滤掉）；组头或 ⋮ 不在返回 null */
  groupMenuIds(): Promise<string[] | null>
  /** 组头菜单「刷新」—— 只触发；重扫的结果由调用方 until */
  refresh(): Promise<void>
  /** 组头菜单「新建知识库」—— 只触发；草稿行由调用方 until draftKind() */
  newBase(): Promise<void>
  /** 条目行菜单的原始 items（开一次 ⋮、不选任何项）；⋮ 不在返回 null */
  rowMenuShots(path: string): Promise<MenuItemShot[] | null>
  /** 开条目行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对；`reveal` 拒绝，见本节开头） */
  pickRowMenu(path: string, actionId: string): Promise<void>
  /** 目录行菜单的原始 items（开一次 ⋮、不选任何项）；固定文案的容器没有 ⋮ → null */
  dirMenuShots(path: string): Promise<MenuItemShot[] | null>
  /** 开目录行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对） */
  pickDirMenu(path: string, actionId: string): Promise<void>
  /** 当前那行内联新建行的落点类型；没有草稿行返回 null */
  draftKind(): Promise<KnowledgeDraftKind | null>
  /** 草稿输入框里的值；没有草稿行返回 null */
  draftValue(): Promise<string | null>
  /** 往草稿输入框里输入（native setter + input 事件 —— React 受控输入只认这一条路） */
  typeDraft(text: string): Promise<void>
  /** 草稿行 Enter（落地）；结果由调用方 until */
  submitDraft(): Promise<void>
  /** 草稿行 Escape（取消） */
  cancelDraft(): Promise<void>
  /** 草稿行失焦（同样取消）—— 见本节开头的「失焦即取消」 */
  blurDraft(): Promise<void>
  /** 草稿行里那条失败原因（宿主给的、已本地化）；没有草稿行或没出错返回 null */
  draftError(): Promise<string | null>
  /** 笔记本正文（.cm-content）文本；没有笔记为空串 */
  bodyText(): Promise<string>
  /** 等正文里出现特征串 —— 切换笔记之后先过这一关，免得读到上一份笔记的 DOM */
  waitBody(marker: string): Promise<void>
  /** 属性卡读数；当前笔记没有卡片为 null（槽位类字段要读先 fmCardPane.waitReady） */
  card(): Promise<KnowledgeCardShot | null>
  /** 属性卡的可编辑性读数；当前笔记没有卡片为 null */
  cardFields(): Promise<KnowledgeCardFieldsShot | null>
  /**
   * 笔记本编辑器可编辑吗 —— 读 `.cm-content` 的 `contenteditable`（只读时 CodeMirror 置成
   * `'false'`，此后**浏览器自己**就不把按键送进来了）。编辑器不在返回 null。
   *
   * ⚠️ 这里刻意不提供「模拟敲键」：本仓的 CDP 客户端只有 Runtime.evaluate（没有 Input 域），
   * 而 CodeMirror 6 不认合成的 `beforeinput` / `keydown`（实测两者都不会改文档，可写的笔记本
   * 也一样），所以那种助手只会造出一条两边都绿的假通道。要断「改不动」，断的是这个开关本身
   * ——**同一个读数在可写笔记本上必须回 true**（用例自带对照组），外加落盘字节不变。
   */
  editorEditable(): Promise<boolean | null>
  /**
   * 当前笔记本有没有那张悬浮输入卡（只读笔记本没有）。判据是**编辑器之外**的 textarea ——
   * 属性卡的文本字段也是 textarea，而它是 CodeMirror 的 widget，住在 `.cm-editor` 里面，
   * 裸查 `document.querySelector('textarea')` 必然误命中。
   */
  hasInputCard(): Promise<boolean>
}

/** 这两个动作开的是 OS 文件管理器（隔离实例没有替换 shell）—— e2e 只读不选 */
const KNOWLEDGE_NEVER_PICK: readonly string[] = ['open-folder', 'reveal']

export function knowledgePane(main: CdpClient): KnowledgePane {
  const sidebar = sidebarPane(main)
  const HEADER = `document.querySelector('div[class*="group/header"][data-group="knowledge"]')`
  // 分组正文 = 组头的下一个兄弟（AnimatedCollapse 的 grid 层）→ overflow 层 → SessionGroup 的内缩层
  const BODY = `${HEADER}?.nextElementSibling?.firstElementChild?.firstElementChild`
  const DIRS = `[...document.querySelectorAll('[data-knowledge-dir]')]`
  const ROWS = `[...document.querySelectorAll('[data-knowledge-row]')]`
  const DIR = (path: string): string =>
    `${DIRS}.find((el) => el.getAttribute('data-knowledge-dir') === ${JSON.stringify(path)})`
  const ROW = (path: string): string =>
    `${ROWS}.find((el) => el.getAttribute('data-knowledge-row') === ${JSON.stringify(path)})`
  const LABEL_OF = `((el) => (el.querySelector('span.truncate')?.textContent ?? '').trim())`
  /** 同一时刻至多一行内联新建行 */
  const DRAFT = `document.querySelector('[data-knowledge-draft]')`
  const DRAFT_INPUT = `${DRAFT}?.querySelector('input')`

  const dirs = (): Promise<KnowledgeDirShot[]> =>
    main.eval<KnowledgeDirShot[]>(`${DIRS}.map((el) => ({
      path: el.getAttribute('data-knowledge-dir') ?? '',
      label: ${LABEL_OF}(el),
      indent: el.style.paddingLeft,
      readonly: el.hasAttribute('data-knowledge-readonly'),
      // 行首图标 = 行里第一枚 svg（名字落在 class 上）；行尾的锁在 span[aria-label] 里，不算它
      icon: (el.querySelector('svg')?.getAttribute('class') ?? '').trim(),
      lock: !!el.querySelector('span[aria-label] svg')
    }))`)

  const dirOpen = (path: string): Promise<boolean> =>
    main.eval<boolean>(`(() => {
      const row = ${DIR(path)}
      // 目录行的下一个兄弟就是它的正文（AnimatedCollapse 根），展开态在那层的内联样式上
      return !!row && row.nextElementSibling?.style.gridTemplateRows === '1fr'
    })()`)

  const bodyText = (): Promise<string> =>
    main.eval<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)

  const waitRow = async (path: string): Promise<void> => {
    await until(() => main.eval<boolean>(`!!${ROW(path)}`), `knowledge row "${path}"`)
  }

  const waitDir = async (path: string): Promise<void> => {
    await until(() => main.eval<boolean>(`!!${DIR(path)}`), `knowledge dir "${path}"`)
  }

  /** 往草稿输入框上做点什么（草稿行不在就抛 —— 失焦即取消，失败点离真因近一点） */
  const onDraftInput = (body: string): Promise<unknown> =>
    main.eval(`(() => {
      const el = ${DRAFT_INPUT}
      if (!el) throw new Error('no knowledge draft row')
      ${body}
      return true
    })()`)

  const pressDraft = (key: string): Promise<unknown> =>
    onDraftInput(
      `el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`
    )

  return {
    expand: async () => {
      await sidebar.setGroupExpanded('knowledge', true)
      // 清单是展开才拉的：正文有内容（行或空态文案）才算落定
      await until(
        () => main.eval<boolean>(`(${BODY}?.childElementCount ?? 0) > 0`),
        'knowledge group listed'
      )
    },

    dirs,
    topDirs: async () => (await dirs()).filter((d) => d.indent === '0px'),
    dirOpen,

    setDirOpen: async (path, open) => {
      await waitDir(path)
      if ((await dirOpen(path)) === open) return
      await main.eval(`${DIR(path)}.click()`)
      await until(
        async () => (await dirOpen(path)) === open,
        `knowledge dir "${path}" ${open ? 'expanded' : 'collapsed'}`
      )
      // 内联样式已落定，高度过渡（150ms）还在走 —— 等它走完再往下
      await sleep(200)
    },

    rows: () =>
      main.eval<KnowledgeRowShot[]>(`${ROWS}.map((el) => ({
        path: el.getAttribute('data-knowledge-row') ?? '',
        label: ${LABEL_OF}(el)
      }))`),

    openRow: async (path) => {
      await waitRow(path)
      await main.eval(`${ROW(path)}.click()`)
      await until(
        () => main.eval<boolean>(`(${ROW(path)}?.className ?? '').includes('bg-bg-active')`),
        `knowledge row "${path}" active`
      )
    },

    activeRow: () =>
      main.eval<string>(
        `${ROWS}.find((el) => el.className.includes('bg-bg-active'))?.getAttribute('data-knowledge-row') ?? ''`
      ),

    groupMenuIds: () => sidebar.groupMenuItems('knowledge'),
    refresh: () => sidebar.pickGroupMenu('knowledge', 'refresh'),
    newBase: () => sidebar.pickGroupMenu('knowledge', 'new-base'),

    rowMenuShots: async (path) => {
      await waitRow(path)
      return openMenu(main, ROW(path), 'menu-button')
    },

    pickRowMenu: async (path, actionId) => {
      if (KNOWLEDGE_NEVER_PICK.includes(actionId)) {
        throw new Error(
          `refusing to pick "${actionId}" on knowledge row "${path}": it opens the real OS file manager`
        )
      }
      await waitRow(path)
      await pickFromMenu(main, ROW(path), actionId, `knowledge row "${path}"`)
    },

    dirMenuShots: async (path) => {
      await waitDir(path)
      return openMenu(main, DIR(path), 'menu-button')
    },

    pickDirMenu: async (path, actionId) => {
      await waitDir(path)
      await pickFromMenu(main, DIR(path), actionId, `knowledge dir "${path}"`)
    },

    draftKind: () =>
      main.eval<KnowledgeDraftKind | null>(
        `${DRAFT}?.getAttribute('data-knowledge-draft') ?? null`
      ),

    draftValue: () => main.eval<string | null>(`${DRAFT_INPUT}?.value ?? null`),

    typeDraft: async (text) => {
      // React 受控输入：直接赋 value 不会触发 onChange，得走原型上的 setter 再补一个 input 事件
      await onDraftInput(`
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set
        setter.call(el, ${JSON.stringify(text)})
        el.dispatchEvent(new Event('input', { bubbles: true }))`)
    },

    submitDraft: async () => {
      await pressDraft('Enter')
    },
    cancelDraft: async () => {
      await pressDraft('Escape')
    },
    blurDraft: async () => {
      // 真失焦一下；但窗口没有 OS 焦点时 blur() 可能什么都不派发（元素并非 document.activeElement），
      // 而 React 19 的 onBlur 听的是根容器上的 focusout —— 补一个冒泡的，保证「点走一下」是确定性的
      await onDraftInput(`
        el.blur()
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`)
    },

    draftError: () =>
      main.eval<string | null>(`(() => {
        const draft = ${DRAFT}
        if (!draft) return null
        // 草稿行 = 输入那层 +（失败时）下面那条红字；红字那层里没有 input
        const err = [...draft.children].find((c) => !c.querySelector('input'))
        return err ? (err.textContent ?? '').trim() : null
      })()`),

    bodyText,
    waitBody: async (marker) => {
      await until(
        async () => (await bodyText()).includes(marker),
        `knowledge note body shows ${JSON.stringify(marker)}`
      )
    },

    card: () =>
      main.eval<KnowledgeCardShot | null>(`(() => {
        const card = document.querySelector('.cm-shuvix-fmcard')
        if (!card) return null
        const status = card.querySelector('.cm-shuvix-fmcard-status')
        return {
          badge: (card.querySelector('.cm-shuvix-fmcard-badge')?.textContent ?? '').trim(),
          selects: [...card.querySelectorAll('.cm-shuvix-fmcard-row')]
            .map((r) => ({ key: r.dataset.key ?? '', sel: r.querySelector('.cm-shuvix-fmcard-enum select') }))
            .filter((x) => x.sel)
            .map((x) => ({ key: x.key, value: x.sel.value })),
          status: status ? { hidden: status.hidden, className: status.className } : null
        }
      })()`),

    cardFields: () =>
      main.eval<KnowledgeCardFieldsShot | null>(`(() => {
        const card = document.querySelector('.cm-shuvix-fmcard')
        if (!card) return null
        // 文本字段是 textarea（描述这类长文本在单行框里会被裁掉），槽位类字段是 input ——
        // 两者共用 .cm-shuvix-fmcard-input 这个类，也都有 .disabled
        const inputs = [...card.querySelectorAll('.cm-shuvix-fmcard-input')]
        return {
          selects: [...card.querySelectorAll('.cm-shuvix-fmcard-row')]
            .map((r) => ({ key: r.dataset.key ?? '', sel: r.querySelector('.cm-shuvix-fmcard-enum select') }))
            .filter((x) => x.sel)
            .map((x) => ({ key: x.key, disabled: x.sel.disabled })),
          inputs: inputs.length,
          inputsDisabled: inputs.filter((i) => i.disabled).length
        }
      })()`),

    editorEditable: () =>
      main.eval<boolean | null>(`(() => {
        const el = document.querySelector('.cm-content')
        return el ? el.getAttribute('contenteditable') !== 'false' : null
      })()`),

    hasInputCard: () =>
      main.eval<boolean>(
        `[...document.querySelectorAll('textarea')].some((t) => !t.closest('.cm-editor'))`
      )
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 说明气泡（InfoHint）与设置窗的 tab 导航
//
// 2026-09-17 起设置页的说明不再铺成正文，而是标题旁一个问号 + 悬浮/聚焦才展开的气泡
// （SettingsPrimitives 的 `InfoHint`）。屏幕上的判据因此从「这段字在不在」变成三件事：
// 收起时它**不在 DOM 里**、展开后它挂在 `document.body` 上（portal，逃出卡片的
// `overflow-hidden`）、按 `aria-describedby` 认得出它属于哪个问号。
//
// 定位一律从**标题文本**出发：SettingsSection 的 `<h3>` 与 SettingsRow 的标题行都把标题写成
// 直接文本子节点，认它比认 class 稳（那些 class 是 Tailwind 原子类，改个内边距就变）。标题
// 本身是本地化的，所以调用方传三语候选，命中任一即可。

/** 展开态下一个说明气泡的快照 */
export interface InfoHintShot {
  /** 气泡里的文字 */
  text: string
  /** 气泡挂在哪个元素下 —— portal 的判据（'BODY' = 直接挂在 document.body 上） */
  parentTag: string
  /** 视口坐标下的矩形 */
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number }
  /** 计算样式的 visibility：锚点整个滚出视野时实现把它置 hidden，元素本身仍挂着 */
  visibility: string
  /** 计算样式的 z-index —— 「有没有掉到弹窗遮罩之下」的判据（气泡是 pointer-events-none，遮挡看不出来） */
  zIndex: number
  /** 触发钮的 `aria-describedby` 是不是正好指向这个气泡 */
  describedBy: boolean
}

/** 触发钮的无障碍接线（只读属性，不触发任何事件） */
export interface InfoHintA11y {
  /** 读屏念出来的名字 —— 空串或裸键（`common.info`）都算坏了 */
  ariaLabel: string
  /** 收起时该没有这个属性（读作 ''）；展开时是气泡的 id */
  describedBy: string
  /** tooltip 不是展开/收起某块内容的控件，不该有这个属性 */
  hasAriaExpanded: boolean
  /** 焦点此刻在不在这个按钮上 */
  focused: boolean
}

/** 所在滚动容器的滚动余量 */
export interface HintScrollRoom {
  scrollTop: number
  /** 还能往下滚多少（0 = 已经到底或根本滚不动） */
  down: number
  /** 还能往上滚多少 */
  up: number
}

export interface InfoHintPane {
  /** 窗口里此刻**看得见**的文字（`innerText`）—— 「说明有没有铺在页面上」的判据 */
  visibleText(): Promise<string>
  /** 整个文档里展开着的气泡个数（收起的气泡不在 DOM 里，所以 0 = 一个都没展开） */
  openTips(): Promise<number>
  /** 这一行 / 这一节标题里问号的个数（0 = 这里没有说明）；找不到这个标题时抛 */
  count(titles: string[]): Promise<number>
  /** 等这个标题上屏（设置窗刚开出来时 React 还没挂完） */
  waitRow(titles: string[]): Promise<void>
  /**
   * 这一行 `subtitle` 的文字（没有就是 ''）—— 与 `count` 正好是一对：
   * 「这一行自己的内容」照旧铺在标题下方，「这一行是干嘛的」才收进问号。
   */
  subtitleOf(titles: string[]): Promise<string>
  /** 悬浮展开并等气泡上屏 —— **不**收起（后续还要读几何） */
  hoverOpen(titles: string[]): Promise<InfoHintShot>
  /** 移开鼠标（收起悬浮打开的那一个） */
  hoverOut(titles: string[]): Promise<void>
  /** 真 `focus()` 展开并等气泡上屏；一直没上屏时回 null */
  focus(titles: string[]): Promise<InfoHintShot | null>
  /** `blur()` 触发钮 */
  blur(titles: string[]): Promise<void>
  /** 此刻的快照，不触发任何事件；气泡不在 DOM 里时 null */
  peek(titles: string[]): Promise<InfoHintShot | null>
  /** 等这个问号的气泡从 DOM 里消失 */
  waitClosed(titles: string[]): Promise<void>
  a11y(titles: string[]): Promise<InfoHintA11y>
  /** 往触发钮上派一个真 keydown（冒泡到 document —— Escape 的监听挂在那儿） */
  pressKey(titles: string[], key: string): Promise<void>
  /** 触发钮（= 气泡的锚点）此刻的视口矩形 —— 位移与「贴不贴着锚点」的判据 */
  anchorRect(
    titles: string[]
  ): Promise<{ top: number; bottom: number; left: number; width: number }>
  /** 触发钮所在滚动容器的余量 —— 「这条用例在这个窗口里跑不跑得动」的前置判据 */
  scrollRoom(titles: string[]): Promise<HintScrollRoom>
  /** 滚动触发钮所在的滚动容器，回**实际**滚动的量（滚不动就是 0） */
  scrollBy(titles: string[], dy: number): Promise<number>
  /** 视口尺寸（气泡守不守得住 8px 边距要拿它比） */
  viewport(): Promise<{ width: number; height: number }>
}

/**
 * 说明气泡读取器。`scope` 是一个求值为 Element / Document 的**页内表达式**，用来把查找
 * 限制在某个容器里 —— 会话设置面板同时存在两份（弹窗里一份、空会话聊天区内联一份），
 * 裸查 document 会读到先出现的那一张。
 */
export function infoHintPane(client: CdpClient, scope = 'document'): InfoHintPane {
  /**
   * 标题命中的那一行（找不到为 null）：SettingsSection 的标题写在 `<h3>` 里、问号是它的**兄弟**，
   * 所以那一支往上取一层；SettingsRow / SettingsBlock 的标题行自己就装着问号。
   */
  const titleLine = (titles: string[]): string => `(() => {
    const want = ${JSON.stringify(titles)}
    const root = ${scope}
    const host = root && [...root.querySelectorAll('h3, div')].find((el) =>
      [...el.childNodes].some((n) => n.nodeType === 3 && want.includes((n.textContent ?? '').trim()))
    )
    if (!host) return null
    return host.tagName === 'H3' ? host.parentElement : host
  })()`

  /** 这一行里的那个问号（找不到行、或这一行没有说明时为 null） */
  const btn = (titles: string[]): string => `(() => {
    const line = ${titleLine(titles)}
    return line ? line.querySelector('[data-info-hint]') : null
  })()`

  /** 该问号此刻的气泡快照（按 aria-describedby 精确取，不认 document 里的第一个） */
  const shotOf = (titles: string[]): string => `(() => {
    const b = ${btn(titles)}
    if (!b) return null
    const id = b.getAttribute('aria-describedby')
    const tip = id ? document.getElementById(id) : null
    if (!tip) return null
    const r = tip.getBoundingClientRect()
    return {
      text: (tip.textContent ?? '').trim(),
      parentTag: tip.parentElement ? tip.parentElement.tagName : '',
      rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      visibility: getComputedStyle(tip).visibility,
      zIndex: Number(getComputedStyle(tip).zIndex) || 0,
      describedBy: true
    }
  })()`

  /** 问号所在的滚动容器（往上找第一个真能滚的祖先） */
  const scroller = (titles: string[]): string => `(() => {
    const b = ${btn(titles)}
    for (let p = b && b.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p
    }
    return null
  })()`

  const peek = (titles: string[]): Promise<InfoHintShot | null> =>
    client.eval<InfoHintShot | null>(shotOf(titles))

  /** 反复触发 open 直到气泡上屏（事件 → setState → 重渲染 → useLayoutEffect 定位，都是异步的） */
  const openWith = async (
    titles: string[],
    fire: string,
    what: string
  ): Promise<InfoHintShot | null> =>
    client.eval<InfoHintShot | null>(`(async () => {
      const b = ${btn(titles)}
      if (!b) throw new Error('info hint not found: ' + ${JSON.stringify(what)})
      let shot = null
      for (let attempt = 0; attempt < 5 && !shot; attempt++) {
        ${fire}
        for (let i = 0; i < 20 && !shot; i++) {
          shot = ${shotOf(titles)}
          if (!shot) await new Promise((r) => setTimeout(r, 10))
        }
      }
      return shot
    })()`)

  // React 的 onMouseEnter / onMouseLeave 是从 mouseover / mouseout 合成的（relatedTarget 在
  // 子树外才算进出），所以派 mouseover / mouseout —— mouseenter React 根本不监听
  const MOUSE = (type: string): string =>
    `b.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, relatedTarget: document.body }))`

  const count = (titles: string[]): Promise<number> =>
    client.eval<number>(`(() => {
      const line = ${titleLine(titles)}
      if (!line) throw new Error('settings title not on screen: ' + ${JSON.stringify(titles.join(' / '))})
      return line.querySelectorAll('[data-info-hint]').length
    })()`)

  return {
    visibleText: () => client.eval<string>('document.body.innerText'),
    openTips: () => client.eval<number>(`document.querySelectorAll('[data-info-tip]').length`),

    count,
    waitRow: async (titles) => {
      await until(
        async () => {
          await count(titles)
          return true
        },
        `settings title on screen: ${titles.join(' / ')}`
      )
    },

    // 标题行的下一个兄弟就是 subtitle 那一层（SettingsRow / SettingsBlock 同一形状；
    // 分节标题没有 subtitle 这回事，也就不会有人拿 `<h3>` 的标题来问）
    subtitleOf: (titles) =>
      client.eval<string>(`(() => {
        const line = ${titleLine(titles)}
        const sub = line && line.nextElementSibling
        return sub ? (sub.textContent ?? '').trim() : ''
      })()`),

    hoverOpen: async (titles) => {
      const shot = await openWith(titles, MOUSE('mouseover'), titles.join(' / '))
      if (!shot) throw new Error(`info hint never opened on hover: ${titles.join(' / ')}`)
      return shot
    },
    hoverOut: async (titles) => {
      await client.eval(`(() => {
        const b = ${btn(titles)}
        if (b) ${MOUSE('mouseout')}
        return true
      })()`)
    },

    focus: (titles) => openWith(titles, 'b.focus()', titles.join(' / ')),
    blur: async (titles) => {
      await client.eval(`(() => {
        const b = ${btn(titles)}
        if (b) b.blur()
        return true
      })()`)
    },

    peek,
    waitClosed: async (titles) => {
      await until(
        async () => ((await peek(titles)) === null ? true : null),
        `info hint closed: ${titles.join(' / ')}`
      )
    },

    a11y: (titles) =>
      client.eval<InfoHintA11y>(`(() => {
        const b = ${btn(titles)}
        if (!b) throw new Error('info hint not found')
        return {
          ariaLabel: b.getAttribute('aria-label') ?? '',
          describedBy: b.getAttribute('aria-describedby') ?? '',
          hasAriaExpanded: b.hasAttribute('aria-expanded'),
          focused: document.activeElement === b
        }
      })()`),

    pressKey: async (titles, key) => {
      await client.eval(`(() => {
        const b = ${btn(titles)}
        if (!b) throw new Error('info hint not found')
        b.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))
        return true
      })()`)
    },

    anchorRect: (titles) =>
      client.eval<{ top: number; bottom: number; left: number; width: number }>(`(() => {
        const b = ${btn(titles)}
        if (!b) throw new Error('info hint not found')
        const r = b.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, width: r.width }
      })()`),

    scrollRoom: (titles) =>
      client.eval<HintScrollRoom>(`(() => {
        const s = ${scroller(titles)}
        if (!s) return { scrollTop: 0, down: 0, up: 0 }
        return {
          scrollTop: s.scrollTop,
          down: s.scrollHeight - s.clientHeight - s.scrollTop,
          up: s.scrollTop
        }
      })()`),

    scrollBy: (titles, dy) =>
      client.eval<number>(`(() => {
        const s = ${scroller(titles)}
        if (!s) return 0
        const before = s.scrollTop
        s.scrollTop = before + ${dy}
        return s.scrollTop - before
      })()`),

    viewport: () =>
      client.eval<{ width: number; height: number }>(
        '({ width: window.innerWidth, height: window.innerHeight })'
      )
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 笔记本 live preview 里的 ```svg 图（atomic-editor 的 svg-blocks）
//
// 锚点：widget 自己的两个类名 `.cm-atomic-svg`（外壳）/ `.cm-atomic-svg-figure`（外框）。
// 这里只放两样单测够不着的东西 —— **级联**（happy-dom 不做级联，`var(--viz-1)` 在那里
// 永远解析不出颜色）与**布局**（happy-dom 的 getBoundingClientRect 全是 0）。

/** 一张已上屏的图的取样：颜色 + 两个盒子的几何 */
export interface SvgFigureShot {
  /** 图里第一个 `<rect>` 的 computed fill（Chromium 归一成 `rgb(r, g, b)`） */
  rectFill: string
  /** `<svg>` 自己的渲染矩形 */
  svg: { width: number; height: number; left: number; right: number; top: number; bottom: number }
  /** 外框的**内容盒**（border + padding 之内）—— 图整个落在里面才没被 overflow:hidden 切掉 */
  frame: { width: number; height: number; left: number; right: number; top: number; bottom: number }
  /** 根字号：CSS 上限写成 rem，换算成 px 才能比 */
  rootFontSize: number
}

export interface SvgFigurePane {
  /** 等图真正画出来（`.cm-atomic-svg-figure` 里有 `<svg>`；错误卡里没有） */
  waitFigure(): Promise<void>
  shot(): Promise<SvgFigureShot>
  /**
   * 当前生效的设计令牌值 —— 拿一个探针元素把 `var(--viz-1)` 交给浏览器解析再读 computed
   * color。不直接读 `--viz-1`：自定义属性回的是原始 token 串（`light-dark(#…, #…)`），
   * 而明暗哪一档生效取决于元素实际的 color-scheme。
   */
  tokenColor(token: string): Promise<string>
}

export function svgFigurePane(main: CdpClient): SvgFigurePane {
  const FIGURE = `document.querySelector('.cm-atomic-svg-figure')`
  const SVG = `document.querySelector('.cm-atomic-svg-figure svg')`

  return {
    waitFigure: async () => {
      await until(() => main.eval<boolean>(`${SVG} !== null`), 'svg figure rendered in notebook')
    },
    shot: () =>
      main.eval<SvgFigureShot>(`(() => {
        const fig = ${FIGURE}
        const svg = ${SVG}
        const rect = svg.querySelector('rect')
        const px = (v) => parseFloat(v) || 0
        const fr = fig.getBoundingClientRect()
        const cs = getComputedStyle(fig)
        const left = fr.left + px(cs.borderLeftWidth) + px(cs.paddingLeft)
        const right = fr.right - px(cs.borderRightWidth) - px(cs.paddingRight)
        const top = fr.top + px(cs.borderTopWidth) + px(cs.paddingTop)
        const bottom = fr.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom)
        const sr = svg.getBoundingClientRect()
        return {
          rectFill: rect ? getComputedStyle(rect).fill : '',
          svg: {
            width: sr.width, height: sr.height,
            left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom
          },
          frame: {
            width: right - left, height: bottom - top,
            left, right, top, bottom
          },
          rootFontSize: px(getComputedStyle(document.documentElement).fontSize)
        }
      })()`),
    tokenColor: (token) =>
      main.eval<string>(`(() => {
        const probe = document.createElement('span')
        probe.style.color = 'var(${token})'
        document.body.appendChild(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      })()`)
  }
}

/** 设置窗口的导航（左侧 tab 栏 + 「LLM 工具」页自己的工具子页栏） */
export interface SettingsNavPane {
  /** 切到某个 tab（按本地化标签认，三语候选命中任一） */
  selectTab(labels: string[]): Promise<void>
  /** 切到「LLM 工具」页左侧的某个工具子页（标签取自 `tools.definitions()` 的 label/name） */
  selectToolSubTab(label: string): Promise<void>
}

/**
 * `openSettings(tab)` 对**已存在**的窗口只聚焦、不切 tab，所以同一个实例里换 tab 只能点。
 * 按标签文本认按钮：tab 的 id 在 DOM 上没有留痕，而 class 全是 Tailwind 原子类。
 */
export function settingsNavPane(settings: CdpClient): SettingsNavPane {
  const clickButton = async (labels: string[], what: string): Promise<void> => {
    const expr = `[...document.querySelectorAll('button')].find((b) =>
      ${JSON.stringify(labels)}.includes((b.textContent ?? '').trim()))`
    await until(() => settings.eval<boolean>(`!!(${expr})`), `${what} button`)
    await settings.eval(`(() => { ${expr}.click(); return true })()`)
  }
  return {
    selectTab: (labels) => clickButton(labels, `settings tab ${labels.join(' / ')}`),
    selectToolSubTab: (label) => clickButton([label], `tool sub-tab ${label}`)
  }
}
