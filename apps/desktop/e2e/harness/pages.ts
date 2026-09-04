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

/** 工具行快照（ToolCallBlock 的 data-tool-*） */
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
  /** 落定条目（剔除流式合成占位项，便于与 message.list 对齐） */
  settledItems(): Promise<ChatItem[]>
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

  /** 待处理输入面板（PendingInputsPanel）是否在屏 + 是否顶格在输入卡片内 */
  pendingPanel(): Promise<{ open: boolean; firstInCard: boolean }>

  /**
   * 群聊气泡的署名（v2）：对话区里所有 `[data-bot-sender]` 气泡的快照（document 序）。
   * avatarBg 是 getComputedStyle 归一后的 `rgb(r, g, b)` —— 与 hexToRgb(botColorFor(name))
   * 做**精确**比较，不做近似。
   *
   * ⚠️ 连续同一个 bot 的消息**合并头部**（IM 惯例）：第二条起没有头像也没有显示名，
   * 只剩气泡。所以 display / avatar* 三项对 `merged: true` 的项恒为空串 ——
   * 断署名时要么先按 merged 过滤，要么正是在断合并本身。
   */
  botSenders(): Promise<BotSenderShot[]>
  /** 档案选择器在屏（输入卡工具行内含 .lucide-bot 的按钮 —— 别处的 bot 图标不算） */
  profilePickerPresent(): Promise<boolean>
  /** 上下文用量环在屏（输入卡工具行内的 circle[r="6"]，轨道圈即可认） */
  ctxRingPresent(): Promise<boolean>
  /** 模型选择器在屏（输入卡工具行选择器簇内 ModelSelect inline 触发器的 chevron） */
  modelPickerPresent(): Promise<boolean>
  /**
   * 选择器簇（工具行第一个子节点）的直接子节点数 —— 「少了哪个选择器」的判据。
   *
   * 普通会话是三个（档案 / 模型 / 工具），聊天会话只剩模型一个：v2 起 `ToolPicker`
   * 也对聊天会话隐藏（任务段的 agent 就是 bot 自己，工具来自它 md 里的 `shuvix-tools`）。
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

/** 群聊气泡的署名快照（BotBubble 根节点的 data-bot-sender + 头部的 BotAvatar） */
export interface BotSenderShot {
  /** bot 身份键（data-bot-sender 属性值） */
  name: string
  /** 头部被合并（连续同一 bot 的第二条起）—— 下面三项此时恒为空串 */
  merged: boolean
  /** 头部显示名（.truncate 那个 span） */
  display: string
  /** 头像色块的计算背景色（'rgb(r, g, b)'） */
  avatarBg: string
  /** 头像字（displayName 首个码点，可能是 emoji/CJK） */
  avatarInitial: string
}

/** '#rrggbb' → 'rgb(r, g, b)'（getComputedStyle 的归一形态；颜色断言做精确比较用） */
export function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`
}

/** 空闲确认间隔：取实测起流延迟（6~33ms）的十倍量级，满载也留得住余量 */
const IDLE_CONFIRM_MS = 300

/** 主窗对话区（会话已选中后调用） */
export function chatPane(main: CdpClient): ChatPane {
  const TEXTAREA = `document.querySelector('textarea')`
  const ITEMS = `[...document.querySelectorAll('[data-msg-id]')]`
  const TOOLS = `[...document.querySelectorAll('[data-tool-name]')]`
  const SCROLLER = `document.querySelector('.conversation-scroller')`
  // 合并行的计数徽章：对话列内唯一的 tabular-nums（侧栏待处理计数不在这棵子树里）
  const GROUP_BADGES = `[...(${SCROLLER}?.querySelectorAll('span.tabular-nums') ?? [])]`
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
      main.eval<ChatItem[]>(`${ITEM_SNAPSHOT}.filter((i) => i.id !== 'streaming-live')`),
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

    pendingPanel: () =>
      main.eval(`(() => {
        const panel = document.querySelector('.rounded-t-2xl')
        if (!panel) return { open: false, firstInCard: false }
        // 顶格 = 输入卡片（border rounded-2xl 那层）的第一个子节点
        return { open: true, firstInCard: panel.parentElement?.firstElementChild === panel }
      })()`),

    botSenders: () =>
      main.eval<BotSenderShot[]>(
        // 头部 = 含显示名 span.truncate 的那个直接子节点；合并头部时它整个不渲染。
        // 头像只在头部里找 —— 气泡本体另有一个 span[aria-hidden] 占位（合并时用来
        // 对齐头像列的那 18px），裸查 span[aria-hidden] 会把它当成头像读出空色块
        `[...document.querySelectorAll('[data-bot-sender]')].map((el) => {
          const hasName = (n) => !!n && !!n.querySelector(':scope > span.truncate')
          const head = hasName(el) ? el : [...el.children].find(hasName)
          const avatar = head?.querySelector('span[aria-hidden]') ?? null
          return {
            name: el.getAttribute('data-bot-sender') ?? '',
            merged: !head,
            display: (head?.querySelector('span.truncate')?.textContent ?? '').trim(),
            avatarBg: avatar ? getComputedStyle(avatar).backgroundColor : '',
            avatarInitial: (avatar?.textContent ?? '').trim()
          }
        })`
      ),
    // 选择器簇是工具行的第一个子节点（pickers），bot 图标只可能是档案选择器的
    profilePickerPresent: () =>
      main.eval<boolean>(`!!${TOOL_ROW}?.firstElementChild?.querySelector('.lucide-bot')`),
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
// A3 · 输入框 `@` 提及弹层（AtMentionPopover）
//
// 行锚点是组件自带的 data-at-suggestion：bot 行的值是 `bot:<name>`（身份键），
// 文件行的值是工作区相对路径 —— 两个名字空间天然不撞。徽标/选中态按**结构类**认
// （徽标 = 行内 bg-warning/10 的 span；键盘选中 = bg-accent/15），
// 不认 i18n 文案。bot 候选是异步拉的（bots.list()），行何时出现由 spec 用 until 等。
//
// v3 起没有 mention-only 这种逐 bot 的门控模式，弹层行上的那枚徽标随之退场 ——
// `mentionBadge` 留着只为**否定断言**（任何一行都不该再长出它）。

/** @ 弹层里的一行 */
export interface AtSuggestionRow {
  /** data-at-suggestion 属性值：bot 行 `bot:<name>`，文件行为相对路径 */
  key: string
  /** 徽标节点在不在（按 bg-warning/10 结构类认）—— v3 起恒应为 false */
  mentionBadge: boolean
  /** 键盘选中态（bg-accent/15） */
  selected: boolean
}

export interface AtPopoverPane {
  /** 弹层是否在屏（有至少一行） */
  open(): Promise<boolean>
  /** 行快照（document 序 = bot 成员序在前、文件在后） */
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
          mentionBadge: [...b.querySelectorAll('span')].some((s) =>
            s.className.includes('bg-warning/10')
          ),
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
 * CSS uppercase 不改 textContent），临时组按 `data-group="temp"` 锚点认
 * —— 临时组是摊开的纯分节（无图标无 toggle 按钮），只剩这个属性可认。
 */
export type GroupTarget = { project: string } | 'temp'

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
  /** 点父行行首那枚图标（折叠钮）；行不存在返回 false */
  toggleSubs(title: string): Promise<boolean>
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
  /** 走分组头菜单的「新建 Bot 会话」（打开成员多选对话框；等待用 botDialogPane.waitOpen） */
  clickNewBotChat(target: GroupTarget): Promise<void>
  /** 当前活动会话行（bg-bg-active）存在且带 bot 图标 */
  activeRowIsBot(): Promise<boolean>
  /** 按标题认的会话行带 bot 图标；行不存在返回 false */
  rowIsBot(title: string): Promise<boolean>
  /**
   * 会话行的未读呈现（A4）：badge = 计数徽标的 data-unread 属性值（无徽标为 null），
   * bold = 标题 span 是否加粗（font-semibold）。行不存在返回 null。
   */
  rowUnread(title: string): Promise<{ badge: string | null; bold: boolean } | null>
}

/**
 * 主窗侧栏会话列表（SessionItem 无 data-*，按「含 span.truncate 的可点击行」认）。
 *
 * 行与组头的动作只剩一个入口：悬停浮现的 ⋮（点它与右键弹的是同一份菜单）。菜单本身是
 * 原生的，e2e 驱动不了 —— bootstrap.cjs 把 `contextMenu:popup` 顶成了可脚本化的桩，
 * 这里只需「钉好要选哪一项 → 点 ⋮ → 顺带核对该项在不在菜单里」（见 pickFromMenu）。
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
  /** 分组头行（SessionGroup 的 group/header 那层）—— 见 GroupTarget 的定位说明 */
  const HEADERS = `[...document.querySelectorAll('div[class*="group/header"]')]`
  const HEADER = (target: GroupTarget): string =>
    target === 'temp'
      ? `${HEADERS}.find((h) => h.getAttribute('data-group') === 'temp')`
      : `${HEADERS}.find(
          (h) =>
            (h.querySelector('button span.truncate')?.textContent ?? '').trim() ===
            ${JSON.stringify(target.project)}
        )`
  /** 第一个「能建会话」的组头 —— 知识库组的菜单里只有刷新（原先它也没有那颗 + 按钮） */
  const ACTION_HEADER = `${HEADERS}.find((h) => h.getAttribute('data-group') !== 'wiki')`
  /** 行/组头尾部那颗 ⋮（RowMenuButton）—— 侧栏一切动作如今的唯一入口 */
  const MENU_BTN = (scope: string): string =>
    `${scope}?.querySelector('.lucide-ellipsis-vertical')?.closest('button')`

  /**
   * 菜单桩（bootstrap.cjs 顶掉了 contextMenu:popup）：钉下一次弹出要选中的项，
   * 并清掉上一次记下的 items。钉 null = 取消（只看菜单内容时用）。
   */
  const armMenu = (actionId: string | null): Promise<unknown> =>
    main.eval(`(() => {
      window.__E2E_MENU_PICK = ${JSON.stringify(actionId)}
      window.__E2E_MENU_ITEMS = null
      return true
    })()`)

  /** 桩记下的最近一次菜单项 id（弹出是异步的，等它到） */
  const lastMenuIds = async (): Promise<string[]> => {
    await until(
      () => main.eval<boolean>(`Array.isArray(window.__E2E_MENU_ITEMS)`),
      'context menu popped'
    )
    return main.eval<string[]>(`window.__E2E_MENU_ITEMS.filter((it) => it.id).map((it) => it.id)`)
  }

  /**
   * 打开某处的 ⋮ 并选中一项：先钉选择再点按钮，随后核对该项**真的在**菜单里 ——
   * 桩是照钉的 id 回的，菜单里没有这一项也不会报错，只是什么都不会发生（失败点会离真因很远）。
   */
  const pickFromMenu = async (scope: string, actionId: string, what: string): Promise<void> => {
    await until(() => main.eval<boolean>(`!!${MENU_BTN(scope)}`), `${what} menu button`)
    await armMenu(actionId)
    await main.eval(`${MENU_BTN(scope)}.click()`)
    const ids = await lastMenuIds()
    if (!ids.includes(actionId)) {
      throw new Error(
        `menu item "${actionId}" not offered by ${what} (got: ${ids.join(', ') || '-'})`
      )
    }
  }

  return {
    clickNewChat: async () => {
      await pickFromMenu(ACTION_HEADER, 'new-chat', 'session group header')
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
          const btn = ${ROW(title)}?.querySelector(':scope > button')
          if (!btn) return false
          btn.click()
          return true
        })()`
      )
      // 折叠动画 150ms（AnimatedCollapse 缺省）——等它落定再断言
      if (clicked) await new Promise((r) => setTimeout(r, 250))
      return clicked
    },
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
      await armMenu(null)
      const clicked = await main.eval<boolean>(`(() => {
        const btn = ${MENU_BTN(HEADER(target))}
        if (!btn) return false
        btn.click()
        return true
      })()`)
      if (!clicked) return null
      return lastMenuIds()
    },
    clickNewBotChat: async (target) => {
      await until(() => main.eval<boolean>(`${HEADER(target)} !== undefined`), 'group header')
      await pickFromMenu(HEADER(target), 'new-bot-chat', 'group header')
      await sleep(200)
    },
    activeRowIsBot: () =>
      main.eval<boolean>(`(() => {
        const row = ${ROWS}.find((d) => d.className.includes('bg-bg-active'))
        return !!row && !!row.querySelector('.lucide-bot')
      })()`),
    rowIsBot: (title) => main.eval<boolean>(`!!${ROW(title)}?.querySelector('.lucide-bot')`),
    rowUnread: (title) =>
      main.eval(`(() => {
        const row = ${ROW(title)}
        if (!row) return null
        const badge = row.querySelector('[data-unread]')
        const titleSpan = row.querySelector(':scope > div > span.truncate')
        return {
          badge: badge ? badge.getAttribute('data-unread') : null,
          bold: (titleSpan?.className ?? '').includes('font-semibold')
        }
      })()`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 新建 Bot 会话对话框（BotSessionDialog）
//
// 结构锚点全部来自组件自带的 data-*（data-bot-dialog / data-bot-pick /
// data-bot-dialog-create）；成员行的勾选态走 aria-checked（role=checkbox）。
// 「打开 Bots 文件夹」按钮**只断存在、绝不点击**：点了会真的弹 Finder 窗口，
// 隔离实例收不回来。

export interface BotDialogRow {
  /** bot 身份键（data-bot-pick 属性值） */
  name: string
  /** aria-checked 勾选态 */
  checked: boolean
}

export interface BotDialogPane {
  /**
   * 等对话框**就绪**（由 sidebarPane.clickNewBotChat 触发后调用）：不止元素上屏，
   * 还要成员列表落定 —— items 是异步拉的（bots.list()），加载中只有一个 '…' 占位，
   * 这时候读 rows/空态都会踩进空窗期。就绪 = 有成员行，或空态分支已渲染（flex-col 那层）。
   */
  waitOpen(): Promise<void>
  isOpen(): Promise<boolean>
  /** 等对话框真的卸载（关闭动画 120ms 之后才离开 DOM，不能同步断） */
  waitClosed(): Promise<void>
  /** 成员行快照（DOM 序 = bots.list() 序） */
  rows(): Promise<BotDialogRow[]>
  /**
   * 幽灵成员行快照（A4 manage 模式：名单里有、注册表里没有 —— data-bot-pick-ghost）。
   * DOM 序 = 原名单相对序。
   */
  ghostRows(): Promise<BotDialogRow[]>
  /** 点一行切换勾选；行不存在返回 false */
  toggle(name: string): Promise<boolean>
  /** 点幽灵行切换勾选；行不存在返回 false */
  toggleGhost(name: string): Promise<boolean>
  /** 点「创建」（成功后对话框自关，另用 waitClosed 等） */
  create(): Promise<void>
  /** 同一次 eval 里连点两下「创建」（防重入用例专用 —— 两下之间不给 React 任何喘息） */
  createDoubleClick(): Promise<void>
  createDisabled(): Promise<boolean>
  /** 空态证据：对话框**内**的「打开 Bots 文件夹」按钮是否存在（只认，不点！） */
  emptyState(): Promise<{ openFolderButton: boolean }>
  /** 无项目警示块（bg-warning/10 那条）是否在屏 */
  noProjectHintShown(): Promise<boolean>
  /** 页脚项目归属文案（项目名，或本地化的「无」—— 断言只钉自己种的项目名） */
  projectLabelText(): Promise<string>
  /** Escape 关闭（对话框在 window 上听 keydown，直接派发到 window） */
  pressEscape(): Promise<void>
}

export function botDialogPane(main: CdpClient): BotDialogPane {
  const DIALOG = `document.querySelector('[data-bot-dialog]')`
  // 成员列表容器是唯一的 flex-1 直接子节点（header/footer/操作行都不是）
  const LIST = `${DIALOG}?.querySelector(':scope > .flex-1')`
  const CREATE = `${DIALOG}?.querySelector('[data-bot-dialog-create]')`
  const ROWS = `[...(${DIALOG}?.querySelectorAll('[data-bot-pick]') ?? [])]`
  const GHOST_ROWS = `[...(${DIALOG}?.querySelectorAll('[data-bot-pick-ghost]') ?? [])]`

  const isOpen = (): Promise<boolean> => main.eval<boolean>(`${DIALOG} !== null`)

  return {
    waitOpen: async () => {
      await until(
        () =>
          main.eval<boolean>(`(() => {
            const list = ${LIST}
            if (!list) return false
            if (list.querySelector('[data-bot-pick]')) return true
            // 空态分支（flex-col）已渲染 = items 已从加载态落定为 []
            return !!list.firstElementChild?.className.includes('flex-col')
          })()`),
        'bot dialog ready (members resolved)'
      )
    },
    isOpen,
    waitClosed: async () => {
      await until(async () => !(await isOpen()), 'bot dialog closed')
    },
    rows: () =>
      main.eval<BotDialogRow[]>(
        `${ROWS}.map((d) => ({
          name: d.dataset.botPick ?? '',
          checked: d.getAttribute('aria-checked') === 'true'
        }))`
      ),
    ghostRows: () =>
      main.eval<BotDialogRow[]>(
        `${GHOST_ROWS}.map((d) => ({
          name: d.dataset.botPickGhost ?? '',
          checked: d.getAttribute('aria-checked') === 'true'
        }))`
      ),
    toggle: async (name) => {
      const clicked = await main.eval<boolean>(`(() => {
        const row = ${ROWS}.find((d) => d.dataset.botPick === ${JSON.stringify(name)})
        if (!row) return false
        row.click()
        return true
      })()`)
      await sleep(150)
      return clicked
    },
    toggleGhost: async (name) => {
      const clicked = await main.eval<boolean>(`(() => {
        const row = ${GHOST_ROWS}.find((d) => d.dataset.botPickGhost === ${JSON.stringify(name)})
        if (!row) return false
        row.click()
        return true
      })()`)
      await sleep(150)
      return clicked
    },
    create: async () => {
      await main.eval(`${CREATE}?.click()`)
      await sleep(200)
    },
    createDoubleClick: async () => {
      // 两下必须落在同一个 eval：隔一个 CDP 来回 React 早已 re-render 出禁用态，
      // 那测的就不是防重入而是禁用属性
      await main.eval(`(() => {
        const btn = ${CREATE}
        btn.click()
        btn.click()
        return true
      })()`)
      await sleep(200)
    },
    createDisabled: () => main.eval<boolean>(`${CREATE}?.disabled ?? true`),
    emptyState: () =>
      main.eval(`({
        openFolderButton: !!${DIALOG}?.querySelector('.lucide-folder-open')
      })`),
    noProjectHintShown: () =>
      main.eval<boolean>(
        `[...(${DIALOG}?.querySelectorAll('p') ?? [])].some((p) => p.className.includes('bg-warning/10'))`
      ),
    projectLabelText: () =>
      main.eval<string>(`(() => {
        const dialog = ${DIALOG}
        if (!dialog) return ''
        const footer = [...dialog.querySelectorAll(':scope > div')].find((d) =>
          d.querySelector(':scope > span.text-text-secondary')
        )
        return (footer?.querySelector(':scope > span.text-text-secondary')?.textContent ?? '').trim()
      })()`),
    pressEscape: async () => {
      await main.eval(
        `(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`
      )
      await sleep(100)
    }
  }
}

export interface AgentsPaneRow {
  displayName: string
  struck: boolean
  overriddenBadge: boolean
}

export interface AgentsPane {
  rows(): Promise<AgentsPaneRow[]>
  selectRow(displayName: string): Promise<void>
  /**
   * 详情面板 —— 智能体页已改为 **md 原文编辑**（frontmatter 由属性卡渲染），
   * 故这里读的是卡片而非表单：
   *   fieldKeys  卡片各行的 frontmatter 键（`data-key`，locale-free，优先用它断言）
   *   cardBadge  类型徽章文案（'ShuviX agent · v1'）
   *   toggles / togglesDisabled  布尔字段开关数与是否全部只读（内置档案只读）
   *   slots      选择器槽位数（model / tools 可编辑时各一个）
   *   hasDeleteButton / hasSaveButton  头部操作
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
  /**
   * 打开新建对话框并等它**几何落定**：
   *   'add'       列表底栏的「添加」（预填新建模板，正文很短）
   *   'override'  内置详情头部的「创建覆盖副本」（预填整份内置 md，几千字，
   *               长文档才照得出对话框的溢出问题）
   *
   * 就绪判据不是「元素出现」——`animate-scale-in` 期间卡片带着 transform，
   * 这时候读 rect 得到的是动画中间态，几何断言会随机红。故还要求编辑器已填充
   * 且卡片 rect 连续两次读数一致。
   */
  openCreateDialog(via: 'add' | 'override'): Promise<void>
  /**
   * 新建对话框的几何快照 —— 「长档案能不能在对话框里滚」这件事的全部证据。
   * 卡片 = 对话框根的 firstElementChild（固定 85vh 的那层）；
   * 滚动体 = 卡片内第一个 `.overflow-y-auto`（SubAgentEditor 的根）。
   */
  createDialogMetrics(): Promise<AgentsCreateDialogMetrics>
  /** 把滚动体拉到底，返回落定后的 scrollTop */
  scrollCreateDialogToBottom(): Promise<number>
  /** 把滚动体复位到顶，返回落定后的 scrollTop */
  scrollCreateDialogToTop(): Promise<number>
  /** Esc 关闭并等对话框真的卸载（关闭动画结束） */
  closeCreateDialog(): Promise<void>
  /**
   * 点保存并等对话框**自行**关闭 —— 那是保存成功的唯一信号（失败会留在原地并
   * 就地显示原因）。故这里不许用 Esc 兜底：那会把失败伪装成成功。
   * 超时抛错，消息里带上就地显示的失败原因。
   */
  saveCreateDialog(): Promise<void>
}

/** 新建对话框的几何快照（单位 px；bottom 取自 getBoundingClientRect） */
export interface AgentsCreateDialogMetrics {
  cardClientHeight: number
  cardScrollHeight: number
  cardBottom: number
  scrollerClientHeight: number
  scrollerScrollHeight: number
  scrollerBottom: number
  scrollerScrollTop: number
  /** 计算后的 overflow-y —— 'visible' 说明那两个自滚类没生效 */
  scrollerOverflowY: string
  /** 对话框里的编辑器确实在滚动体内（认对话框内的 .cm-content，页面上还有详情那一个） */
  scrollerHasEditor: boolean
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

/** 设置窗口「智能体」tab（openSettings('agents') 后调用；等编辑器就绪） */
export async function agentsPane(settings: CdpClient): Promise<AgentsPane> {
  await until(
    () => settings.eval<boolean>(`document.querySelector('.cm-content') !== null`),
    'agents tab ready'
  )

  const ROWS = `(() => {
    const col = [...document.querySelectorAll('.w-\\\\[220px\\\\]')].pop()
    return [...col.querySelectorAll('button')].filter((b) => b.querySelector('.lucide-bot'))
  })()`

  // 新建对话框：唯一的全屏遮罩层（未打开时为 null）
  const DIALOG = `document.querySelector('.fixed.inset-0.z-50')`
  const CARD = `${DIALOG}?.firstElementChild`
  const SCROLLER = `${CARD}?.querySelector('.overflow-y-auto')`
  const CARD_RECT = `(() => {
    const r = ${CARD}?.getBoundingClientRect()
    return r ? [r.top, r.left, r.width, r.height].join(',') : ''
  })()`

  /** 滚动体挪到指定位置，返回浏览器实际落定的 scrollTop（挪不动时就是 0） */
  const scrollTo = (top: string): Promise<number> =>
    settings.eval<number>(`(() => {
      const s = ${SCROLLER}
      s.scrollTop = ${top}
      return s.scrollTop
    })()`)

  return {
    rows: () =>
      settings.eval(`${ROWS}.map((r) => ({
        displayName: r.querySelector('.font-medium')?.textContent.trim() ?? '',
        struck: !!r.querySelector('.line-through'),
        overriddenBadge: [...r.querySelectorAll('span')].some((s) => /已覆盖|Overridden|上書き/.test(s.textContent))
      }))`),
    selectRow: async (displayName) => {
      await settings.eval(
        `${ROWS}.find((r) => r.querySelector('.font-medium')?.textContent.trim() === ${JSON.stringify(displayName)}).click()`
      )
      await new Promise((r) => setTimeout(r, 500))
    },
    detail: () =>
      settings.eval(`(() => {
        // 右面板恒是列表列的下一个兄弟（两栏布局）—— 编辑态下 .flex-1.min-w-0 会命中
        // 头部标题 div 与 LivePreviewEditor 根，认不准（同 policiesPane 的教训）
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
      })()`),

    openCreateDialog: async (via) => {
      // 已经开着一个就早失败：再点入口只换预填文本，而 CM6 不会因此重置文档，
      // 于是对话框里还是上一份 md —— 后面的断言会围着「看起来对但内容是别人的」打转
      if (await settings.eval<boolean>(`${DIALOG} !== null`)) {
        throw new Error('create dialog already open (leaked by a previous case?)')
      }
      const icon = via === 'add' ? '.lucide-plus' : '.lucide-copy'
      await settings.eval(
        `(() => {
          const col = [...document.querySelectorAll('.w-\\\\[220px\\\\]')].pop()
          // 「添加」在列表列底栏，「创建覆盖副本」在右侧详情头部（= 列表列的兄弟）
          const scope = ${JSON.stringify(via)} === 'add' ? col : col.nextElementSibling
          const btn = [...scope.querySelectorAll('button')].find((b) => b.querySelector(${JSON.stringify(icon)}))
          if (!btn) throw new Error('create dialog entry not found: ' + ${JSON.stringify(icon)})
          btn.click()
          return true
        })()`
      )
      // 覆盖副本预填整份内置 md（几千字）；新建模板只有十来行，故只对前者要求长度
      const minChars = via === 'override' ? 500 : 0
      await until(
        () =>
          settings.eval<boolean>(`(() => {
            const editor = ${DIALOG}?.querySelector('.cm-content')
            return !!editor && (editor.textContent ?? '').length > ${minChars}
          })()`),
        `create dialog (${via}) editor filled`
      )
      // animate-scale-in 期间卡片带 transform，此时读 rect 拿到的是动画中间态
      await until(async () => {
        const first = await settings.eval<string>(CARD_RECT)
        await sleep(120)
        const second = await settings.eval<string>(CARD_RECT)
        return first && first === second ? first : null
      }, 'create dialog geometry settled')
    },

    createDialogMetrics: () =>
      settings.eval(`(() => {
        const dialog = ${DIALOG}
        const card = dialog.firstElementChild
        const scroller = card.querySelector('.overflow-y-auto')
        return {
          cardClientHeight: card.clientHeight,
          cardScrollHeight: card.scrollHeight,
          cardBottom: card.getBoundingClientRect().bottom,
          scrollerClientHeight: scroller.clientHeight,
          scrollerScrollHeight: scroller.scrollHeight,
          scrollerBottom: scroller.getBoundingClientRect().bottom,
          scrollerScrollTop: scroller.scrollTop,
          scrollerOverflowY: getComputedStyle(scroller).overflowY,
          // 页面上还有详情面板那一个 .cm-content —— 必须在对话框内取，否则恒 false
          scrollerHasEditor: scroller.contains(dialog.querySelector('.cm-content'))
        }
      })()`),

    scrollCreateDialogToBottom: () => scrollTo(`${SCROLLER}.scrollHeight`),
    scrollCreateDialogToTop: () => scrollTo('0'),

    closeCreateDialog: async () => {
      // 对话框自己在 window 上听 keydown（不是聚焦元素），故直接派发到 window
      await settings.eval(
        `(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          return true
        })()`
      )
      await until(() => settings.eval<boolean>(`${DIALOG} === null`), 'create dialog closed')
    },

    saveCreateDialog: async () => {
      await settings.eval(
        `(() => {
          const btn = [...${DIALOG}.querySelectorAll('button')].find((b) => b.querySelector('.lucide-save'))
          if (!btn) throw new Error('create dialog save button not found')
          btn.click()
          return true
        })()`
      )
      // 成功 = 对话框自己卸载；失败会留在原地并就地显示原因。
      // until 把轮询期异常当「未就绪」吞掉，故失败用返回值传出去再抛
      let reason = ''
      const outcome = await until<boolean | 'rejected'>(
        async () => {
          if (await settings.eval<boolean>(`${DIALOG} === null`)) return true
          reason = await settings.eval<string>(
            `(${DIALOG}.querySelector('.text-red-500')?.textContent ?? '').trim()`
          )
          return reason ? 'rejected' : false
        },
        'create dialog saved & closed',
        10_000
      )
      if (outcome !== true) throw new Error(`create dialog save rejected: ${reason}`)
    }
  }
}

export interface PoliciesPaneRow {
  name: string
  struck: boolean
  overriddenBadge: boolean
  /** 当前选中行（选中态是 accent 配色，不是 aria 属性） */
  selected: boolean
}

/**
 * md 原文编辑态的快照 —— 编辑器与详情共用右面板，但**锚点不同**：
 * 详情用「最后一个 .flex-1.min-w-0」，编辑态下那个选择器会命中 PolicyEditor 的
 * 头部标题 div（它同样带 flex-1 min-w-0），故这里一律以「含 .cm-content 的面板」为锚。
 */
export interface PoliciesPaneEditor {
  /** 编辑器是否上屏 */
  open: boolean
  /** 屏幕上的文本：CM6 文档文本 + 属性卡各输入框的当前值（后者不进 textContent） */
  text: string
  /** 属性卡类型徽章（policy md 应为 'ShuviX policy · v1'） */
  cardBadge: string
  /** 属性卡里的规则摘要行数（policyRules 结构摘要） */
  cardRules: number
  /** 属性卡校验徽章的语义类：'ok' | 'warn' | 'err' | ''（未上屏） */
  cardStatus: string
  /** 保存失败横幅文案（解析器/服务层原文；无横幅为空串） */
  error: string
}

export interface PoliciesPane {
  rows(): Promise<PoliciesPaneRow[]>
  /** 点击底部「重扫描」—— 列表只在挂载时加载一次，运行中写入的策略文件需手动重扫 */
  refresh(): Promise<void>
  selectRow(name: string): Promise<void>
  /**
   * 详情 —— 策略页已与智能体页统一：详情就是 md 原文的 LivePreview（属性卡 + 正文），
   * 内置只读、用户可编辑，没有单独的结构化详情视图了。故这里读的是卡片：
   *   sourceBadge      来源徽标（内置 / 自定义）
   *   cardBadge        类型徽章（'ShuviX policy · v1'）
   *   fieldKeys        卡片各行的 frontmatter 键（data-key，locale-free）
   *   effectBadges/Texts  规则摘要里的 effect 徽章数与**原始 effect 名**
   *                    （卡片按 md 原文展示 deny/ask/force-allow，不做本地化 —— 所见即引擎所评估）
   *   hasScope         策略级 scope 行有值（非「未设置」）
   *   conditionLines   各规则行的条件/match 摘要文本
   *   rulePrompts      各规则的人读提示语行（prompt 不混进 mono 的条件串，单独散排一行；
   *                    没写 prompt 的规则不产生这一行，故长度可小于规则数）
   *   hasRationale     正文（Rationale）已渲染进 CM6
   *   actionButtons    头部操作数（内置未覆盖=1 覆盖副本；被遮蔽内置=0；用户=2 保存+删除）
   *   inputs/slots     可编辑控件数（内置只读时均为 0）
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
  /**
   * 左栏「无法解析」分组里的文件名。这些文件不生效也不遮蔽内置，但必须可见 ——
   * 它们的行不含 .font-medium（rows() 因此天然排除它们），以 font-mono 标识。
   */
  invalidRows(): Promise<string[]>
  /** 详情操作条各按钮的文案（本地化；断言用三语兜底正则） */
  detailActionTexts(): Promise<string[]>
  /**
   * 点详情操作条上的某个动作 —— **按图标认，不按位置**：操作条会随功能增减
   * （如新增的「渲染/源码」视图切换），按 index 认会全线错位。
   * 这些按钮的图标是语义固定的，与列表行图标（随 object.type 变）不同。
   */
  clickDetailAction(action: 'edit' | 'delete' | 'createOverride' | 'toggleView'): Promise<void>
  /** 点左栏底部「新建」并等编辑器上屏 */
  clickNew(): Promise<void>
  /** 编辑态快照（未进入编辑态时 open=false，其余字段为空） */
  editor(): Promise<PoliciesPaneEditor>
  /** 点编辑器「保存」，等到编辑器关闭或错误横幅上屏 */
  save(): Promise<void>
  /** 点编辑器「取消」，等编辑器落下 */
  cancelEdit(): Promise<void>
  /** ConfirmDialog 当前态（标题 / 描述；未弹出时 open=false） */
  confirmDialog(): Promise<{ open: boolean; title: string; description: string }>
  /** 点 ConfirmDialog 的确认按钮（页脚第二个按钮） */
  confirmDialogConfirm(): Promise<void>
}

/** 设置窗口「安全策略」tab（openSettings('policies') 后调用；只读查看） */
export async function policiesPane(settings: CdpClient): Promise<PoliciesPane> {
  const COLUMN = `[...document.querySelectorAll('.w-\\\\[220px\\\\]')].pop()`
  // 按「含策略名的 .font-medium」认行，**不要**按图标认：列表图标随 object.type 变
  // （path→FileText / command→Terminal / gitTool→GitBranch / database→Database，
  // 未声明 object.type 的策略才回退 Shield），按图标筛会只剩零星几行。
  // 底栏的「打开目录」「重扫描」两个按钮不含 .font-medium，天然被排除。
  const ROWS = `(() => {
    const col = ${COLUMN}
    return [...col.querySelectorAll('button')].filter((b) => b.querySelector('.font-medium'))
  })()`
  const REFRESH = `[...${COLUMN}.querySelectorAll('button')].find((b) => b.querySelector('.lucide-refresh-cw'))`
  const NEW = `[...${COLUMN}.querySelectorAll('button')].find((b) => b.querySelector('.lucide-plus'))`
  // 编辑态**不能**用 .flex-1.min-w-0 认面板：PolicyEditor 的头部标题 div 与
  // LivePreviewEditor 的根都带这两个类，pop()/find() 会分别落在错误的一层。
  // 右面板恒是列表列的下一个兄弟（PolicySettings 的两栏布局），详情/编辑两态通用。
  const PANEL = `${COLUMN}.nextElementSibling`
  // 编辑器自身的操作按钮 = 面板内、不属于 CM6 的按钮（排除属性卡的开关/跳源码按钮）
  // 顺序即 DOM 顺序：0 = 取消，1 = 保存
  // 头部动作一律按图标认（位置会随功能增减而漂）：取消=x、保存=save/check
  const HEAD_BTN = (icon: string): string =>
    `[...${PANEL}.querySelectorAll('button')].filter((b) => !b.closest('.cm-editor')).find((b) => b.querySelector('${icon}'))`
  const DIALOG = `document.querySelector('.dialog-panel')`
  await until(() => settings.eval<boolean>(`${ROWS}.length > 0`), 'policies tab ready')

  const editorSnapshot = (): Promise<PoliciesPaneEditor> =>
    settings.eval(`(() => {
      const panel = ${PANEL}
      // 统一后「详情就是编辑器」，故 .cm-content 恒存在 —— open 特指 create/fix 这类
      // 临时编辑态，它们才有「取消」（lucide-x）。选中项的常态编辑不算 open。
      const cancelBtn = [...(panel?.querySelectorAll('button') ?? [])].find(
        (b) => !b.closest('.cm-editor') && b.querySelector('.lucide-x')
      )
      if (!panel?.querySelector('.cm-content') || !cancelBtn) {
        return { open: false, text: '', cardBadge: '', cardRules: 0, cardStatus: '', error: '' }
      }
      const status = panel.querySelector('.cm-shuvix-fmcard-status')
      const cls = status ? status.className : ''
      // 保存失败横幅是 PolicyEditor 自己的（红色 tailwind 类）——属性卡的校验横幅在 CM6 内
      const banner = [...panel.querySelectorAll('div')].find(
        (d) => !d.closest('.cm-editor') && d.className.includes('text-red-500')
      )
      return {
        open: true,
        // 卡片把 name/displayName/description 渲染成 <input>，其值不进 textContent —— 
        // 「屏幕上看得见的文本」要把输入框的 value 一并算上，否则断言会漏掉这几个字段
        text:
          (panel.querySelector('.cm-content')?.textContent ?? '') +
          [...panel.querySelectorAll('.cm-shuvix-fmcard-input')].map((i) => ' ' + i.value).join(''),
        cardBadge: panel.querySelector('.cm-shuvix-fmcard-badge')?.textContent.trim() ?? '',
        cardRules: panel.querySelectorAll('.cm-shuvix-fmcard-rule').length,
        cardStatus: /is-(ok|warn|err)/.exec(cls)?.[1] ?? '',
        error: banner ? banner.textContent.trim() : ''
      }
    })()`)

  return {
    refresh: async () => {
      await settings.eval(`${REFRESH}.click()`)
      await new Promise((r) => setTimeout(r, 400))
    },
    rows: () =>
      settings.eval(`${ROWS}.map((r) => ({
        name: r.querySelector('.font-medium')?.textContent.trim() ?? '',
        struck: !!r.querySelector('.line-through'),
        overriddenBadge: [...r.querySelectorAll('span')].some((s) => /已覆盖|Overridden|上書き/.test(s.textContent)),
        selected: r.className.includes('bg-accent/10')
      }))`),
    selectRow: async (name) => {
      await settings.eval(
        `${ROWS}.find((r) => r.querySelector('.font-medium')?.textContent.trim() === ${JSON.stringify(name)}).click()`
      )
      await new Promise((r) => setTimeout(r, 300))
    },
    detail: () =>
      settings.eval(`(() => {
        const pane = ${PANEL}
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
      })()`),
    invalidRows: () =>
      settings.eval(`[...${COLUMN}.querySelectorAll('button')]
        .filter((b) => !b.querySelector('.font-medium') && b.querySelector('.font-mono'))
        .map((b) => b.textContent.trim())`),
    // 头部动作一律以右面板（PANEL）为锚：DETAIL 的 .flex-1.min-w-0 在编辑态会命中
    // 头部标题 div（详情已统一为编辑器，这个坑对策略页现在是常态）
    detailActionTexts: () =>
      settings.eval(
        `[...${PANEL}.querySelectorAll('button')]
          .filter((b) => !b.closest('.cm-editor'))
          .map((b) => b.textContent.trim())`
      ),
    clickDetailAction: async (action) => {
      const ICON = {
        edit: 'lucide-pencil',
        delete: 'lucide-trash-2',
        createOverride: 'lucide-copy',
        // 视图切换按钮的图标随当前视图变（渲染态显示 code，源码态显示 eye）
        toggleView: 'lucide-code, .lucide-eye'
      }[action]
      await settings.eval(
        `[...${PANEL}.querySelectorAll('button')]
          .filter((b) => !b.closest('.cm-editor'))
          .find((b) => b.querySelector('.${ICON}'))
          ?.click()`
      )
      await new Promise((r) => setTimeout(r, 300))
    },
    clickNew: async () => {
      await settings.eval(`${NEW}.click()`)
      await until(async () => (await editorSnapshot()).open, 'policy editor mounted')
    },
    editor: editorSnapshot,
    save: async () => {
      await settings.eval(`(${HEAD_BTN('.lucide-save')} ?? ${HEAD_BTN('.lucide-check')})?.click()`)
      // 成功 → 编辑器落下并回详情；失败 → 编辑器留在原位并显示解析器原因
      await until(async () => {
        const state = await editorSnapshot()
        return !state.open || state.error !== ''
      }, 'policy editor save settled')
    },
    cancelEdit: async () => {
      await settings.eval(`${HEAD_BTN('.lucide-x')}?.click()`)
      await until(async () => !(await editorSnapshot()).open, 'policy editor closed')
    },
    confirmDialog: () =>
      settings.eval(`(() => {
        const panel = ${DIALOG}
        if (!panel) return { open: false, title: '', description: '' }
        return {
          open: true,
          title: panel.querySelector('h3')?.textContent.trim() ?? '',
          description: panel.querySelector('h3 + div')?.textContent.trim() ?? ''
        }
      })()`),
    confirmDialogConfirm: async () => {
      await settings.eval(`[...${DIALOG}.querySelectorAll('button')][1].click()`)
      await new Promise((r) => setTimeout(r, 500))
    }
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
// A2 · 对话流完整渲染（v2 群聊形态）—— 「正在输入」行 / 失败气泡 / BotReply 双形态 /
// mailbox 回执 / 子代理面板行。
//
// 锚点全部是 data-*（data-bot-activity / data-bot-activity-phase / data-bot-stop /
// data-bot-failure / data-bot-reply / data-bot-receipt / data-subagent-run），
// 文案一概不认。IPC 能断的（metadata.botFailure、事件序列）不在这里断 ——
// 这里只认「屏幕上真的长出来了什么」。
//
// v2 删掉的三个锚点（连同它们描述的能力）：`data-bot-deciding`（「正在判断」合并行 ——
// 现在每个在飞成员各占一行，判断中即 phase='started'）、`data-bot-rescue-chip`
// （误压制救济，随仲裁一并退场）、`data-bot-silence{,-dismiss}`（全体沉默提示，同上）。

/** 一行「正在输入」的快照（BotTypingIndicator 的一行；v1 是一张占位卡） */
export interface BotTypingRowShot {
  /** bot 稳定名（data-bot-activity 属性值） */
  name: string
  /** 相位（data-bot-activity-phase：started / queued / working —— v2 没有 claimed 了） */
  phase: string
  /** 停止钮在不在（data-bot-stop；排队那行刻意没有 —— 还没开始做，无处可停） */
  hasStop: boolean
}

/** 一条 bot 消息上与呈现相关的位 */
export interface BotMessageFlags {
  /** 头部「失败」角标（data-bot-failure）在不在 */
  failureBadge: boolean
  /**
   * 气泡容器的 className（失败气泡 = 含 border-error 的错误色盒）。
   * 取气泡而不是 `.markdown-body`：v2 的错误色镶在气泡上，正文那一层是干净的。
   */
  bubbleClassName: string
  /** BotReply 双形态容器（data-bot-reply）在不在 */
  replyCard: boolean
}

/** BotReply 双形态渲染的结构快照（在某条消息卡内） */
export interface BotReplyShot {
  present: boolean
  /** 加粗结论行（p.font-bold）的文本；无则空串 */
  headline: string
  /** 结论行是否真的加粗（font-bold 类） */
  headlineBold: boolean
  bullets: string[]
  /** 表格单元格文本（含表头行），每行一个数组 */
  tableRows: string[][]
  /** data-bot-status 属性值；无 chip 则 null */
  status: string | null
  followups: string[]
}

export interface SubAgentRowShot {
  /** 阶段 agent 名（data-subagent-run 属性值，如 bot-intent） */
  agent: string
  expanded: boolean
}

export interface BotFlowPane {
  /** 对话尾部的「正在输入」行（document 序） */
  typingRows(): Promise<BotTypingRowShot[]>
  /** 点某个 bot 那一行上的停止钮；无钮返回 false */
  clickStop(botName: string): Promise<boolean>

  /** 某条 bot 消息上的失败/回复呈现位 */
  messageFlags(msgId: string): Promise<BotMessageFlags>
  /** 某条消息内 BotReply 的结构快照 */
  replyShape(msgId: string): Promise<BotReplyShot>
  /** 点某条消息内第 i 个追问 chip（data-bot-followup）；无则 false */
  clickFollowup(msgId: string, index: number): Promise<boolean>

  /** 用户消息下的 mailbox 回执（data-bot-receipt；names 是逗号连的 botName 串） */
  receipts(): Promise<Array<{ msgId: string; names: string }>>

  /**
   * 打开会话面板的 Sub-agent 页。入口是状态横幅右侧工具栏的胶囊按钮 ——
   * 全应用唯一「.lucide-bot 与数量徽标（span.tabular-nums）同居一个 button」的地方
   * （侧栏组头的新建 bot 会话钮只有图标，档案选择器只有图标+文字，会话行不是 button）。
   * 按钮只在当前会话有子会话时存在；找不到返回 false。
   */
  openSubAgentPanel(): Promise<boolean>
  /** 子代理面板里的行（document 序 = startedAt 升序） */
  subAgentRows(): Promise<SubAgentRowShot[]>
  /** 点第 i 行的折叠头（开合切换） */
  toggleSubAgentRow(index: number): Promise<void>
}

export function botFlowPane(main: CdpClient): BotFlowPane {
  const ROWS = `[...document.querySelectorAll('[data-bot-activity]')]`
  const MSG = (id: string): string =>
    `document.querySelector('[data-msg-id=${JSON.stringify(id)}]')`
  const SUB_ROWS = `[...document.querySelectorAll('[data-subagent-run]')]`

  return {
    typingRows: () =>
      main.eval<BotTypingRowShot[]>(
        `${ROWS}.map((el) => ({
          name: el.getAttribute('data-bot-activity') ?? '',
          phase: el.getAttribute('data-bot-activity-phase') ?? '',
          hasStop: el.querySelector('[data-bot-stop]') !== null
        }))`
      ),
    clickStop: async (botName) => {
      const hit = await main.eval<boolean>(`(() => {
        const btn = document.querySelector('[data-bot-stop=${JSON.stringify(botName)}]')
        if (!btn) return false
        btn.click()
        return true
      })()`)
      await sleep(200)
      return hit
    },

    messageFlags: (msgId) =>
      main.eval<BotMessageFlags>(`(() => {
        const el = ${MSG(msgId)}
        // 气泡是署名根节点里第一个 .rounded-lg —— 头像用 rounded-[5px]、状态 chip 与
        // 追问 chip 用 rounded-full，气泡是这棵子树里唯一戴 rounded-lg 的那层
        const bubble = el?.querySelector('[data-bot-sender] .rounded-lg') ?? null
        return {
          failureBadge: !!el?.querySelector('[data-bot-failure]'),
          bubbleClassName: bubble?.className ?? '',
          replyCard: !!el?.querySelector('[data-bot-reply]')
        }
      })()`),
    replyShape: (msgId) =>
      main.eval<BotReplyShot>(`(() => {
        const card = ${MSG(msgId)}?.querySelector('[data-bot-reply]')
        if (!card) {
          return { present: false, headline: '', headlineBold: false, bullets: [],
                   tableRows: [], status: null, followups: [] }
        }
        const head = card.querySelector('p')
        return {
          present: true,
          headline: (head?.textContent ?? '').trim(),
          headlineBold: (head?.className ?? '').includes('font-bold'),
          bullets: [...card.querySelectorAll('ul li')].map((li) => (li.textContent ?? '').trim()),
          tableRows: [...card.querySelectorAll('table tr')].map((tr) =>
            [...tr.querySelectorAll('th, td')].map((c) => (c.textContent ?? '').trim())
          ),
          status: card.querySelector('[data-bot-status]')?.getAttribute('data-bot-status') ?? null,
          followups: [...card.querySelectorAll('[data-bot-followup]')]
            .map((b) => (b.textContent ?? '').trim())
        }
      })()`),
    clickFollowup: async (msgId, index) => {
      const hit = await main.eval<boolean>(`(() => {
        const chips = [...(${MSG(msgId)}?.querySelectorAll('[data-bot-followup]') ?? [])]
        if (!chips[${index}]) return false
        chips[${index}].click()
        return true
      })()`)
      await sleep(300)
      return hit
    },

    receipts: () =>
      main.eval(
        `[...document.querySelectorAll('[data-bot-receipt]')].map((el) => ({
          msgId: el.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? '',
          names: el.getAttribute('data-bot-receipt') ?? ''
        }))`
      ),

    openSubAgentPanel: async () => {
      const hit = await main.eval<boolean>(`(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.querySelector('.lucide-bot') && b.querySelector('span.tabular-nums')
        )
        if (!btn) return false
        btn.click()
        return true
      })()`)
      await sleep(300)
      return hit
    },
    subAgentRows: () =>
      main.eval<SubAgentRowShot[]>(
        `${SUB_ROWS}.map((el) => ({
          agent: el.getAttribute('data-subagent-run') ?? '',
          expanded: el.getAttribute('data-subagent-expanded') === 'true'
        }))`
      ),
    toggleSubAgentRow: async (index) => {
      // 行根的第一个子节点是折叠头（onClick=toggle）；展开内容是其后的兄弟
      await main.eval(`${SUB_ROWS}[${index}]?.firstElementChild?.click()`)
      await sleep(250)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// A1 · 设置页「Bots」tab —— 列表 / md 编辑器 / 运行时读数条 / 门控模型选择器 /
// 丢更新冲突对话框。
//
// 锚点全部是 A1 落的 data-*（data-bot-new / data-bot-row / data-bot-save /
// data-bot-new-session / data-bot-inspect{,-warnings} / data-bot-slots /
// data-bot-slot{,-select} / data-bot-body-chars / data-bot-gate-model /
// data-bot-conflict-{reload,overwrite}），左栏与右面板按 DOM 结构从 [data-bot-new]
// 反推（底栏的父级 = 列表列，其下一个兄弟 = 右面板），不认宽度类。ModelSelect 面板
// 沿用 fmCardPane 的 `.picker-panel` 约定（body portal）。
//
// v3 删掉两个锚点（连同它们描述的能力）：`data-bot-notes-status`（笔记段没了，正文由
// bot 自己维护）与 `data-bot-limits`（bot→bot 接力没了，hop/扇出上限随之退场）。
// 它们只在 `retiredAnchors()` 里作否定断言。

export interface BotsPaneRow {
  /** bot 身份键（data-bot-row 属性值 = frontmatter name） */
  name: string
  displayName: string
  description: string
  selected: boolean
}

/** 读数条槽位编辑器里的一行（`<label data-bot-slot>` + `<select data-bot-slot-select>`） */
export interface BotsSlotRow {
  /** 槽位名（data-bot-slot 属性值 = 管线 input schema 里的 agents.properties 键） */
  role: string
  /** 必填星标（`*`）在不在 */
  required: boolean
  /** 下拉当前值：'' = 未填 */
  value: string
  /** 下拉候选（含 '' 那项）—— 注册表里未被遮蔽的 agent 名 */
  options: string[]
  /** 警示配色（必填未填 / 填了不存在的 agent） */
  warned: boolean
}

/** 运行时读数条快照（data-bot-inspect 未上屏时 present=false 其余为空） */
export interface BotsInspectShot {
  present: boolean
  /** 管线行文案：`<workflow>` 或 `<workflow> · <concurrency>` */
  pipelineText: string
  /** 槽位行（DOM 序 = 管线声明序，bot 额外填的槽位缀尾） */
  slots: BotsSlotRow[]
  /** 正文字符数（data-bot-body-chars 属性值） */
  bodyChars: number
  /** 问题区条目数（data-bot-inspect-warnings 属性值）；块未上屏为 0 */
  warningsCount: number
  /** 问题区各条文案（DOM 序）—— 只用于「含某个槽位名」这类弱断言，不认整句 i18n */
  warnings: string[]
  /** 门控模型选择器行（仅 intent 仍指向内置 bot-intent 时上屏） */
  gateModelPresent: boolean
}

/** 右面板编辑器快照（编辑 / 新建 / 修复三态通用） */
export interface BotsEditorShot {
  present: boolean
  /** 头部有取消按钮 —— 新建/修复这类临时编辑态（常态编辑没有取消） */
  transient: boolean
  /** 屏幕上的文本：CM6 文档 + 属性卡各输入框 value（后者不进 textContent） */
  text: string
  /** 属性卡 name 行输入框的当前值 */
  nameInput: string
  /** 属性卡类型徽章（bot md 应为 'ShuviX bot · v1'） */
  cardBadge: string
  /** 红色错误横幅文案（保存失败/加载失败；无横幅为空串） */
  error: string
  /** 「新建会话」按钮在屏（仅 edit 态） */
  newSessionPresent: boolean
}

export interface BotsPane {
  /** 设置窗口当前 hash（tab 路由断言用） */
  hash(): Promise<string>
  newButtonPresent(): Promise<boolean>
  rows(): Promise<BotsPaneRow[]>
  /** 「无法解析」琥珀分组里的文件名（无分组时空数组） */
  invalidRows(): Promise<string[]>
  selectRow(name: string): Promise<void>
  selectInvalid(fileName: string): Promise<void>
  /** 底栏重扫按钮（列表只在挂载/保存后刷新，磁盘外改动需手动重扫） */
  refresh(): Promise<void>
  /** 非法文件详情（文件名 + 解析器拒绝理由） */
  invalidDetail(): Promise<{ fileName: string; error: string }>
  /** 非法详情里的「点击修复」按钮 → 打开修复编辑器 */
  clickInvalidEdit(): Promise<void>
  editor(): Promise<BotsEditorShot>
  /** 底栏「新建 bot」 */
  clickNew(): Promise<void>
  /** 编辑器头部保存（data-bot-save） */
  clickSave(): Promise<void>
  /** 编辑器头部取消（仅 transient 态存在） */
  clickCancel(): Promise<void>
  /** 编辑器头部「新建会话」（data-bot-new-session） */
  clickNewSession(): Promise<void>
  inspect(): Promise<BotsInspectShot>
  /**
   * 改某个槽位的下拉（native value setter + change 事件，走 React 的 onChange）：
   * 组件据此给 md 打补丁（`shuvix-bot-agents.<role>` 行）并 `bot:save`。
   * '' = 清掉该槽位。下拉不存在（槽位没上屏）返回 false。
   */
  setSlot(role: string, value: string): Promise<boolean>
  /** v3 已退场的锚点里此刻还在屏上的（应恒为空数组） */
  retiredAnchors(): Promise<string[]>

  /** 丢更新冲突对话框是否在屏（以 data-bot-conflict-reload 的存在为准） */
  conflictOpen(): Promise<boolean>
  /** 冲突对话框三个决议：加载磁盘版本 / 仍然覆盖 / 取消 */
  clickConflictReload(): Promise<void>
  clickConflictOverwrite(): Promise<void>
  clickConflictCancel(): Promise<void>

  /** 门控模型：开面板（trigger 监听 click）并等 portal 上屏 */
  openGateModel(): Promise<void>
  gateModelOpen(): Promise<boolean>
  /** 面板里的提供商分组名（型号按钮带 pl-5，据此与分组头区分 —— 同 fmCardPane） */
  gateModelGroups(): Promise<string[]>
  expandGateModelGroup(label: string): Promise<boolean>
  pickGateModel(modelId: string): Promise<boolean>
  /** 触发器文案（未选态 = 「跟随会话」占位） */
  gateModelTriggerText(): Promise<string>
  /** 已选态的清除按钮（.lucide-x）；未选态不存在 → 返回 false */
  clearGateModel(): Promise<boolean>
}

/** 设置窗口「Bots」tab（openSettings('bots') 后调用；就绪判据 = data-bot-new 上屏） */
export async function botsPane(settings: CdpClient): Promise<BotsPane> {
  await until(
    () => settings.eval<boolean>(`document.querySelector('[data-bot-new]') !== null`),
    'bots tab ready'
  )

  // 列表列 = 底栏（data-bot-new 的父级）的父级；右面板 = 列表列的下一个兄弟
  const COLUMN = `document.querySelector('[data-bot-new]').parentElement.parentElement`
  const PANEL = `${COLUMN}.nextElementSibling`
  const ROWS = `[...document.querySelectorAll('[data-bot-row]')]`
  // 非法行：列表列里带 font-mono 文件名的按钮（合法行显示 displayName，无 font-mono）
  const INVALID_ROWS = `[...${COLUMN}.querySelectorAll('button')].filter((b) => b.querySelector('span.font-mono'))`
  const MODEL_PANEL = `document.querySelector('.picker-panel')`
  const MODEL_BUTTONS = `[...document.querySelectorAll('.picker-panel button')]`
  const GATE_ROW = `document.querySelector('[data-bot-gate-model]')`
  const CONFLICT_RELOAD = `document.querySelector('[data-bot-conflict-reload]')`

  const editorSnapshot = (): Promise<BotsEditorShot> =>
    settings.eval(`(() => {
      const panel = ${PANEL}
      if (!panel?.querySelector('.cm-content')) {
        return { present: false, transient: false, text: '', nameInput: '', cardBadge: '', error: '', newSessionPresent: false }
      }
      const cancelBtn = [...panel.querySelectorAll('button')].find(
        (b) => !b.closest('.cm-editor') && b.querySelector('.lucide-x')
      )
      // 错误横幅（红色 tailwind 类）在 CM6 之外；属性卡的校验横幅不算
      const banner = [...panel.querySelectorAll('div')].find(
        (d) => !d.closest('.cm-editor') && d.className.includes('text-red-500')
      )
      return {
        present: true,
        transient: !!cancelBtn,
        // 属性卡把 name/description 渲染成 <input>，其值不进 textContent —— 一并算上
        text:
          (panel.querySelector('.cm-content')?.textContent ?? '') +
          [...panel.querySelectorAll('.cm-shuvix-fmcard-input')].map((i) => ' ' + i.value).join(''),
        nameInput:
          panel.querySelector('.cm-shuvix-fmcard-row[data-key="name"] .cm-shuvix-fmcard-input')
            ?.value ?? '',
        cardBadge: panel.querySelector('.cm-shuvix-fmcard-badge')?.textContent.trim() ?? '',
        error: banner ? banner.textContent.trim() : '',
        newSessionPresent: !!panel.querySelector('[data-bot-new-session]')
      }
    })()`)

  const gateModelOpen = (): Promise<boolean> => settings.eval<boolean>(`${MODEL_PANEL} !== null`)

  return {
    hash: () => settings.eval<string>('location.hash'),
    newButtonPresent: () =>
      settings.eval<boolean>(`document.querySelector('[data-bot-new]') !== null`),
    rows: () =>
      settings.eval(`${ROWS}.map((r) => ({
        name: r.getAttribute('data-bot-row') ?? '',
        displayName: r.querySelector('.font-medium')?.textContent.trim() ?? '',
        description: r.querySelector('.text-\\\\[10px\\\\]')?.textContent.trim() ?? '',
        selected: r.className.includes('bg-accent/10')
      }))`),
    invalidRows: () =>
      settings.eval(
        `${INVALID_ROWS}.map((b) => b.querySelector('span.font-mono').textContent.trim())`
      ),
    selectRow: async (name) => {
      await settings.eval(
        `${ROWS}.find((r) => r.getAttribute('data-bot-row') === ${JSON.stringify(name)}).click()`
      )
      // 选中 → 拉原文 + inspect，各是一趟 IPC —— 等编辑器真挂上再回
      await until(
        () =>
          settings.eval<boolean>(`(() => {
            const row = ${ROWS}.find((r) => r.getAttribute('data-bot-row') === ${JSON.stringify(name)})
            return !!row && row.className.includes('bg-accent/10') && ${PANEL}?.querySelector('.cm-content') !== null
          })()`),
        `bot row selected: ${name}`
      )
    },
    selectInvalid: async (fileName) => {
      await settings.eval(
        `${INVALID_ROWS}.find(
          (b) => b.querySelector('span.font-mono').textContent.trim() === ${JSON.stringify(fileName)}
        ).click()`
      )
      await until(
        () => settings.eval<boolean>(`${PANEL}?.querySelector('.font-mono') !== null`),
        `invalid bot file selected: ${fileName}`
      )
    },
    refresh: async () => {
      await settings.eval(
        `[...${COLUMN}.querySelectorAll('button')].find((b) => b.querySelector('.lucide-refresh-cw')).click()`
      )
      await sleep(400)
    },
    invalidDetail: () =>
      settings.eval(`(() => {
        const panel = ${PANEL}
        const amber = [...panel.querySelectorAll('div')].find((d) =>
          d.className.includes('bg-amber-500/10')
        )
        return {
          fileName: panel.querySelector('.font-mono')?.textContent.trim() ?? '',
          error: amber ? amber.textContent.trim() : ''
        }
      })()`),
    clickInvalidEdit: async () => {
      await settings.eval(
        `[...${PANEL}.querySelectorAll('button')].find((b) => b.className.includes('bg-accent')).click()`
      )
      await until(async () => (await editorSnapshot()).present, 'bot fix editor mounted')
    },
    editor: editorSnapshot,
    clickNew: async () => {
      await settings.eval(`document.querySelector('[data-bot-new]').click()`)
      await until(async () => (await editorSnapshot()).transient, 'bot create editor mounted')
    },
    clickSave: async () => {
      await settings.eval(`document.querySelector('[data-bot-save]').click()`)
    },
    clickCancel: async () => {
      await settings.eval(
        `[...${PANEL}.querySelectorAll('button')].find(
          (b) => !b.closest('.cm-editor') && b.querySelector('.lucide-x')
        ).click()`
      )
      await until(async () => !(await editorSnapshot()).transient, 'bot editor closed')
    },
    clickNewSession: async () => {
      await settings.eval(`document.querySelector('[data-bot-new-session]').click()`)
    },
    inspect: () =>
      settings.eval(`(() => {
        const strip = document.querySelector('[data-bot-inspect]')
        if (!strip) {
          return { present: false, pipelineText: '', slots: [], bodyChars: 0, warningsCount: 0, warnings: [], gateModelPresent: false }
        }
        // 管线行是槽位列表之前唯一的 font-mono span（槽位名各自也是 font-mono，但住在 label 里）
        const pipeline = [...strip.querySelectorAll('span.font-mono')].find((s) => !s.closest('[data-bot-slot]'))
        const warn = strip.querySelector('[data-bot-inspect-warnings]')
        const chars = strip.querySelector('[data-bot-body-chars]')
        return {
          present: true,
          pipelineText: pipeline?.textContent.trim() ?? '',
          slots: [...strip.querySelectorAll('[data-bot-slot]')].map((l) => {
            const sel = l.querySelector('[data-bot-slot-select]')
            return {
              role: l.getAttribute('data-bot-slot') ?? '',
              required: (l.querySelector('span.font-mono')?.textContent ?? '').includes('*'),
              value: sel?.value ?? '',
              options: sel ? [...sel.options].map((o) => o.value) : [],
              warned: !!sel && sel.className.includes('border-warning')
            }
          }),
          bodyChars: chars ? Number(chars.getAttribute('data-bot-body-chars')) : 0,
          warningsCount: warn ? Number(warn.getAttribute('data-bot-inspect-warnings')) : 0,
          warnings: warn ? [...warn.children].map((d) => d.textContent.trim()) : [],
          gateModelPresent: ${GATE_ROW} !== null
        }
      })()`),
    setSlot: async (role, value) => {
      const hit = await settings.eval<boolean>(`(() => {
        const sel = document.querySelector('[data-bot-slot-select=${JSON.stringify(role)}]')
        if (!sel) return false
        // React 给受控 select 装了 value tracker：直接赋 .value 会被判「没变」而不派 onChange，
        // 必须绕到原型上的原生 setter（同 chatPane.type 对 textarea 的做法）
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        setter.call(sel, ${JSON.stringify(value)})
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      // 补丁 + bot:save + 重扫 + 编辑器重挂各是一趟 IPC/渲染 —— 调用方按结果 until 等
      await sleep(200)
      return hit
    },
    retiredAnchors: () =>
      settings.eval<string[]>(
        `['data-bot-notes-status', 'data-bot-limits'].filter((a) => document.querySelector('[' + a + ']'))`
      ),

    conflictOpen: () => settings.eval<boolean>(`${CONFLICT_RELOAD} !== null`),
    clickConflictReload: async () => {
      await settings.eval(`${CONFLICT_RELOAD}.click()`)
      await sleep(200)
    },
    clickConflictOverwrite: async () => {
      await settings.eval(`document.querySelector('[data-bot-conflict-overwrite]').click()`)
      await sleep(200)
    },
    clickConflictCancel: async () => {
      // 取消是决议行里唯一不带 data-* 的按钮（JSX 序第一个）
      await settings.eval(
        `[...${CONFLICT_RELOAD}.parentElement.querySelectorAll('button')].find(
          (b) => !b.hasAttribute('data-bot-conflict-reload') && !b.hasAttribute('data-bot-conflict-overwrite')
        ).click()`
      )
      await sleep(200)
    },

    openGateModel: async () => {
      await settings.eval(`${GATE_ROW}.querySelector('button').click()`)
      await until(gateModelOpen, 'gate model picker panel mounted')
    },
    gateModelOpen,
    gateModelGroups: () =>
      settings.eval(
        `${MODEL_BUTTONS}.filter((b) => !b.className.includes('pl-5')).map((b) => b.textContent.trim())`
      ),
    expandGateModelGroup: (label) =>
      settings.eval<boolean>(`(() => {
        const head = ${MODEL_BUTTONS}.find(
          (b) => !b.className.includes('pl-5') && b.textContent.trim() === ${JSON.stringify(label)}
        )
        if (!head) return false
        head.click()
        return true
      })()`),
    pickGateModel: (modelId) =>
      settings.eval<boolean>(`(() => {
        const item = ${MODEL_BUTTONS}.find(
          (b) => b.className.includes('pl-5') && b.textContent.trim() === ${JSON.stringify(modelId)}
        )
        if (!item) return false
        item.click()
        return true
      })()`),
    gateModelTriggerText: () =>
      settings.eval<string>(`(${GATE_ROW}?.querySelector('button')?.textContent ?? '').trim()`),
    clearGateModel: () =>
      settings.eval<boolean>(`(() => {
        const btn = [...${GATE_ROW}.querySelectorAll('button')].find((b) => b.querySelector('.lucide-x'))
        if (!btn) return false
        btn.click()
        return true
      })()`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// A4 · 会话配套 —— 头部成员条 / 会话工具栏胶囊 / 聊天会话空态。
//
// 锚点全部是 A4 落的 data-*（data-bot-members / data-bot-member{,-missing} /
// data-bot-manage-members / data-bot-empty{,-member}），外加会话工具栏胶囊的
// data-session-tool（共享 SessionToolbar，工具 id 与 SessionPanelTool 一一对应）。
//
// v2 删掉「Bot 决策」面板（连同 `bot:decisions` IPC 与 data-bot-decision* 三个锚点）：
// 竞争与仲裁取消之后，那个面板回答的「谁赢了谁让位」已经不是会发生的事。
// `decisions.jsonl` 本身留着 —— L0 剔除根本不产生 run，没有那个文件就什么线索都不剩。
// v3 删掉空态里的建议问题 chip（`data-bot-suggestion`，随 `shuvix-bot-suggestions` 一并退场）：
// 空态只剩成员介绍行；`suggestionChips` 留着做否定断言。

/** 头部成员条里的一枚胶囊 */
export interface BotMemberChip {
  /** bot 身份键（data-bot-member 属性值） */
  name: string
  /** 胶囊可见文本（displayName；缺失成员回落身份键） */
  display: string
  /** 缺失标注（data-bot-member-missing）在不在 */
  missing: boolean
}

export interface BotSessionPane {
  /** 头部成员条快照：present = data-bot-members 在屏；chips 按 DOM 序 = 名单序 */
  membersBar(): Promise<{ present: boolean; chips: BotMemberChip[] }>
  /** 点成员条的「管理成员」入口（data-bot-manage-members；随后用 botDialogPane 驱动）；无则 false */
  clickManageMembers(): Promise<boolean>

  /** 会话工具栏的工具胶囊 id 列表（data-session-tool 属性值，DOM 序） */
  toolbarTools(): Promise<string[]>
  /** 点某个工具胶囊（开合面板/切换工具）；无则 false */
  clickToolbarTool(tool: string): Promise<boolean>

  /**
   * 聊天会话空态快照：present = data-bot-empty；cards 按 DOM 序 = 名单序
   * （display / description 按结构认：成员行里的 .font-medium 与 .text-text-tertiary）；
   * suggestionChips = 整个空态里 data-bot-suggestion 的个数（v3 起恒应为 0）。
   */
  emptyState(): Promise<{
    present: boolean
    cards: Array<{ name: string; display: string; description: string }>
    suggestionChips: number
  }>
}

/** 主窗聊天会话的 A4 配套面（会话已选中后调用） */
export function botSessionPane(main: CdpClient): BotSessionPane {
  const MEMBERS = `document.querySelector('[data-bot-members]')`
  const TOOL_BTNS = `[...document.querySelectorAll('[data-session-tool]')]`
  const EMPTY = `document.querySelector('[data-bot-empty]')`

  return {
    membersBar: () =>
      main.eval(`(() => {
        const bar = ${MEMBERS}
        if (!bar) return { present: false, chips: [] }
        return {
          present: true,
          chips: [...bar.querySelectorAll('[data-bot-member]')].map((c) => ({
            name: c.getAttribute('data-bot-member') ?? '',
            display: (c.querySelector('span.truncate')?.textContent ?? '').trim(),
            missing: c.hasAttribute('data-bot-member-missing')
          }))
        }
      })()`),
    clickManageMembers: async () => {
      const hit = await main.eval<boolean>(`(() => {
        const btn = document.querySelector('[data-bot-manage-members]')
        if (!btn) return false
        btn.click()
        return true
      })()`)
      await sleep(200)
      return hit
    },

    toolbarTools: () =>
      main.eval<string[]>(`${TOOL_BTNS}.map((b) => b.getAttribute('data-session-tool') ?? '')`),
    clickToolbarTool: async (tool) => {
      const hit = await main.eval<boolean>(`(() => {
        const btn = ${TOOL_BTNS}.find(
          (b) => b.getAttribute('data-session-tool') === ${JSON.stringify(tool)}
        )
        if (!btn) return false
        btn.click()
        return true
      })()`)
      await sleep(300)
      return hit
    },

    emptyState: () =>
      main.eval(`(() => {
        const root = ${EMPTY}
        if (!root) return { present: false, cards: [], suggestionChips: 0 }
        return {
          present: true,
          cards: [...root.querySelectorAll('[data-bot-empty-member]')].map((c) => ({
            name: c.getAttribute('data-bot-empty-member') ?? '',
            display: (c.querySelector('.font-medium')?.textContent ?? '').trim(),
            description: (c.querySelector('.text-text-tertiary')?.textContent ?? '').trim()
          })),
          suggestionChips: root.querySelectorAll('[data-bot-suggestion]').length
        }
      })()`)
  }
}
