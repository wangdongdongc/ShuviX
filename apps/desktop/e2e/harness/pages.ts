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
 * 工具行的完整快照（ToolCallBlock → StepRow）—— 「这一行画成了什么样」：
 * 呈现（图标 / 标签 / 摘要）是内置 MCP 工具那张兜底呈现表的出口，状态图标会顶替类型图标。
 */
export interface ChatToolRowShot extends ChatToolRow {
  /** 标签位文本（工具显示名；随界面语言变） */
  label: string
  /**
   * 图标槽里那枚 lucide 图标的类名（如 `lucide-globe`）。状态图标（运行中 / 出错 / 待询问）
   * 会顶替类型图标 —— 这里读到的就是屏幕上那一枚；没有图标槽时为空串。
   */
  icon: string
  /** 摘要位文本（`buildToolSummary` 的首行，限长 60） */
  detail: string
  /** 图标槽是待询问的盾牌（`lucide-shield-alert`）：这一行有一条挂着的询问，按 toolCallId 认领 */
  awaiting: boolean
  /** 这一行在一个展开的步骤合并行里（StepGroup 展开后逐条列出的原始行） */
  inGroup: boolean
  /**
   * 展开之后的终端形态详情（chat-ui TerminalView，`data-terminal-view`）的全文 —— 提示符行
   * （主机 / 目录 + 命令）连同输出；没展开、或这一行的详情不是终端形态时为 null。
   */
  terminal: string | null
}

/** 步骤合并行（StepGroup）的完整快照 */
export interface ChatStepGroupShot extends ChatStepGroup {
  /** 头行图标（全是同一个工具时有；混合段不出图标 → 空串） */
  icon: string
  /** 标签位：同一工具时是工具显示名；混合段是「每种工具各几次」（`浏览器 ×3`） */
  label: string
  /** 摘要位：各次调用摘要去重后以 ` · ` 拼接，限长 60 */
  detail: string
  /** 计数徽章（`data-group-count`）上的数字 */
  count: number
}

/** 输入卡片顶上那张询问卡片（AskForm）的快照 */
export interface PendingAskShot {
  /** 标题：路径类是「读取 / 写入文件」一类的动作名，其余是工具显示名（随界面语言变） */
  title: string
  /** 标题前那枚图标的 lucide 类名 */
  icon: string
  /** 工具自己给的一句话说明（`request.description`） */
  description: string
  /** 预览块的文字：路径类是那条路径，其余是命令原文 */
  preview: string
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

/**
 * 末条助手气泡里**真正落进 DOM 的标记**的快照 —— markdown 白名单闸的 e2e 判据。
 *
 * 单测断的是 hast 树，证不了「树过了 React 之后 DOM 里是什么」；这份快照就是那一半。
 * 两条认法上的坑，写在类型上免得再踩：
 *   - `.markdown-body` 里**合法地**有 lucide 的 `<svg>`（代码块的复制按钮），所以永远
 *     不要断言「气泡里没有 svg」—— 要么数 `svg script`，要么数可执行标签本身；
 *   - 文本一律取 `textContent`：`innerText` 在这里实测回空串。
 */
export interface BubbleMarkup {
  /** 气泡正文（textContent） */
  text: string
  /** 气泡里出现过的元素名（去重、字典序） */
  tags: string[]
  /** 气泡内 script / style / link / iframe / object / embed / form 的总个数 */
  executable: number
  /** 气泡内 `svg script` 的个数（`<svg>` 本身不算 —— 见上） */
  svgScripts: number
  /** 气泡内计算样式为 position: fixed 的元素个数（整屏遮罩的判据） */
  fixed: number
  /** 气泡里每个 `<a>` 的 href（拿不到 href 的记空串） */
  hrefs: string[]
}

/** 「气泡有没有影响到整个窗口」的判据 —— 全局样式表、body 计算样式、输入框可点性 */
export interface WindowMarkup {
  /** `document.styleSheets.length`（气泡里的 `<style>` 活下来就会 +1） */
  styleSheets: number
  /** `getComputedStyle(document.body).outlineWidth` —— 全局 CSS 注入的可见信号 */
  bodyOutlineWidth: string
  /** 输入框正中 `elementFromPoint` 命中的元素名（遮罩存在时命中的是遮罩） */
  composerHitTag: string
  /** 那一击是不是落在输入框自己身上 */
  composerReachable: boolean
}

/** 页内被「执行」过的痕迹 —— 非空证与它同取一次 eval，见 `pwnMarks` */
export interface PwnMarks {
  /** `window.__PWNED__` 里记下的 id（未被写过时为空数组） */
  hits: string[]
  /**
   * `typeof window.api.terminal` —— **必须**和 hits 同一次 eval 取。
   * 没有它，「hits 是空的」也可能只是因为跑在一个根本没有特权面的页面上。
   */
  apiTerminal: string
}

export interface ChatPane {
  /** 输入框就绪（会话已选中、ChatView 已挂载） */
  ready(): Promise<void>

  /** 往输入框填字（native value setter + input 事件，走 React 的 onChange） */
  type(text: string): Promise<void>
  /** 把光标（选区折叠）设到指定字符位置 —— 退格整体删引用等用例需要光标紧贴引用尾部 */
  setCaret(pos: number): Promise<void>
  /** 输入框镜像层（MentionHighlighter）画出的胶囊明文（含前导 @，与底层 textarea 逐字一致） */
  composerChips(): Promise<string[]>
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
  /** 用户气泡内的内联 Token 胶囊文本（TokenChip 的 span[role=button]，读 data-token-display 锚点） */
  tokenBadges(msgId: string): Promise<string[]>
  /** 用户气泡内的附图解码状态 */
  images(): Promise<Array<{ naturalWidth: number; complete: boolean }>>
  /** 思考块数量（ThinkingText 的 font-serif 按钮） */
  thinkingBlocks(): Promise<number>
  /** 错误行数量（error_event 条目） */
  errorRows(): Promise<number>
  toolRows(): Promise<ChatToolRow[]>
  /** 工具行的完整快照（DOM 序，含展开的合并行里逐条列出的那些） */
  toolRowShots(): Promise<ChatToolRowShot[]>
  /** 步骤合并行的完整快照（DOM 序） */
  stepGroupShots(): Promise<ChatStepGroupShot[]>
  /** 输入卡片顶上的询问卡片；没有挂着的询问时为 null */
  pendingAskShot(): Promise<PendingAskShot | null>
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
  /** 点 ConfirmDialog 的确认（页脚第二个按钮） */
  confirmAccept(): Promise<void>

  /** 末条助手气泡的标记快照（见 BubbleMarkup） */
  bubbleMarkup(): Promise<BubbleMarkup>
  /**
   * 等到末条助手气泡的正文含 marker 后再取快照。
   * `waitIdle()` 只保证流结束，实测它返回时气泡还没画上去 —— 中间这一手不能省。
   */
  waitBubbleMarkup(marker: string, timeoutMs?: number): Promise<BubbleMarkup>
  /** 窗口级快照（见 WindowMarkup） */
  windowMarkup(): Promise<WindowMarkup>
  /** `window.__PWNED__` + 特权面的非空证（见 PwnMarks） */
  pwnMarks(): Promise<PwnMarks>
  /** 程序化点击气泡里正文等于 label 的 `<a>`，回它当时的 href（没有 href 时回空串） */
  clickBubbleLink(label: string): Promise<string>
  /** 展开气泡里第一个 `<details>`（真的触发 toggle，好让 ontoggle 那条不至于假绿） */
  openBubbleDetails(): Promise<void>
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

  // 末条助手正文的 .markdown-body —— 认法同 ITEM_SNAPSHOT（`.min-w-0` 的直接子节点），
  // 过程区里的中间文本块也用 .markdown-body，靠这一层父子关系区分
  const BUBBLE = `[...document.querySelectorAll(
    '[data-msg-role="assistant"][data-msg-type="message"] .markdown-body'
  )].filter((m) => (m.parentElement?.className ?? '').includes('min-w-0')).pop()`

  /**
   * StepRow（工具行 / 合并行共用的单行骨架）的三段：图标槽 / 标签 / 摘要。
   * 图标槽是按钮的第一个子节点、且它的直接子节点是 svg（没有图标时整槽不渲染，第一个子节点
   * 就成了标签）；标签是 `span.font-medium`，摘要是占满剩余宽度的 `span.flex-1`。
   * 不认 Tailwind 的宽度类（`w-3.5` 带点号，拼选择器要转义两层）。
   */
  const STEP_ROW_PARTS = `(btn) => {
    const first = btn?.firstElementChild
    const svg = first && first.tagName === 'SPAN' ? first.querySelector(':scope > svg') : null
    return {
      icon: svg ? ([...svg.classList].find((c) => c.startsWith('lucide-')) ?? '') : '',
      label: (btn?.querySelector(':scope > span.font-medium')?.textContent ?? '').trim(),
      detail: (btn?.querySelector(':scope > span.flex-1')?.textContent ?? '').trim()
    }
  }`

  const isBusy = (): Promise<boolean> =>
    main.eval<boolean>(`document.querySelector('[data-msg-id="streaming-live"]') !== null`)

  const bubbleMarkup = (): Promise<BubbleMarkup> =>
    main.eval<BubbleMarkup>(`(() => {
      const body = ${BUBBLE}
      if (!body) throw new Error('no assistant .markdown-body on screen')
      const all = [...body.querySelectorAll('*')]
      return {
        text: body.textContent ?? '',
        tags: [...new Set(all.map((el) => el.tagName.toLowerCase()))].sort(),
        executable: body.querySelectorAll(
          'script, style, link, iframe, object, embed, form'
        ).length,
        svgScripts: body.querySelectorAll('svg script').length,
        fixed: all.filter((el) => getComputedStyle(el).position === 'fixed').length,
        hrefs: [...body.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
      }
    })()`)

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
    setCaret: async (pos) => {
      await main.eval(
        `(() => {
          const ta = ${TEXTAREA}
          ta.focus()
          ta.selectionStart = ta.selectionEnd = ${pos}
          return true
        })()`
      )
    },
    // 镜像层 = textarea 容器里那个 aria-hidden 的覆层（MentionHighlighter），胶囊是它里面的
    // span[role=button]；斜杠命令芯片也在同一容器但**不在**镜像层内，故必须锚进镜像层取
    composerChips: () =>
      main.eval<string[]>(
        `(() => {
          const mirror = ${TEXTAREA}?.parentElement?.querySelector('[aria-hidden="true"]')
          return [...(mirror?.querySelectorAll('span[role="button"]') ?? [])]
            .map((s) => (s.textContent ?? '').trim())
        })()`
      ),
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
          .map((s) => ((s instanceof HTMLElement && s.dataset.tokenDisplay) || (s.textContent ?? '')).trim())`
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
    toolRowShots: () =>
      main.eval<ChatToolRowShot[]>(
        `(() => {
          const parts = ${STEP_ROW_PARTS}
          return ${TOOLS}.map((el) => {
            const p = parts(el.querySelector(':scope > button'))
            return {
              name: el.dataset.toolName ?? '',
              status: el.dataset.toolStatus ?? '',
              ...p,
              awaiting: p.icon === 'lucide-shield-alert',
              inGroup: el.closest('[data-step-group]') !== null,
              terminal: (() => {
                const term = el.querySelector('[data-terminal-view]')
                return term ? (term.textContent ?? '').trim() : null
              })()
            }
          })
        })()`
      ),
    stepGroupShots: () =>
      main.eval<ChatStepGroupShot[]>(
        `(() => {
          const parts = ${STEP_ROW_PARTS}
          return ${GROUPS}.map((el) => {
            const btn = el.querySelector(':scope > button')
            return {
              state: el.dataset.groupState ?? '',
              size: Number(el.dataset.groupSize ?? 0),
              text: (btn?.textContent ?? '').trim(),
              ...parts(btn),
              count: Number((btn?.querySelector('[data-group-count]')?.textContent ?? '').trim() || 0)
            }
          })
        })()`
      ),
    // 询问卡片 = 待处理面板（输入卡片顶上的 rounded-t-2xl）里的 AskForm：标题是一个不换行的
    // font-medium 段落，它所在那一行的第一枚 svg 是标题图标，标题行的下一个兄弟是预览块
    pendingAskShot: () =>
      main.eval<PendingAskShot | null>(`(() => {
        const title = [...document.querySelectorAll('.rounded-t-2xl p.font-medium.whitespace-nowrap')][0]
        if (!title) return null
        const row = title.parentElement
        const svg = row?.querySelector('svg')
        return {
          title: (title.textContent ?? '').trim(),
          icon: svg ? ([...svg.classList].find((c) => c.startsWith('lucide-')) ?? '') : '',
          description: (title.nextElementSibling?.textContent ?? '').trim(),
          preview: (row?.nextElementSibling?.textContent ?? '').trim()
        }
      })()`),
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
    },

    bubbleMarkup,
    waitBubbleMarkup: async (marker, timeoutMs = 25_000) =>
      until(
        async () => {
          const shot = await bubbleMarkup()
          return shot.text.includes(marker) ? shot : null
        },
        `bubble painted with ${JSON.stringify(marker)}`,
        timeoutMs
      ),
    windowMarkup: () =>
      main.eval<WindowMarkup>(`(() => {
        const ta = ${TEXTAREA}
        const box = ta?.getBoundingClientRect()
        const hit = box
          ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          : null
        return {
          styleSheets: document.styleSheets.length,
          bodyOutlineWidth: getComputedStyle(document.body).outlineWidth,
          composerHitTag: (hit?.tagName ?? 'none').toLowerCase(),
          composerReachable: !!hit && !!ta && (hit === ta || ta.contains(hit) || hit.contains(ta))
        }
      })()`),
    // CDP 把 undefined 按 null 回传，页内就先映射成哨兵字符串
    pwnMarks: () =>
      main.eval<PwnMarks>(`(() => ({
        hits: Array.isArray(window.__PWNED__) ? window.__PWNED__.map(String) : [],
        apiTerminal: typeof window.api?.terminal === 'undefined'
          ? 'unset'
          : typeof window.api.terminal
      }))()`),
    clickBubbleLink: (label) =>
      main.eval<string>(`(() => {
        const body = ${BUBBLE}
        const a = [...(body?.querySelectorAll('a') ?? [])]
          .find((el) => (el.textContent ?? '').trim() === ${JSON.stringify(label)})
        if (!a) throw new Error('no bubble link: ' + ${JSON.stringify(label)})
        const href = a.getAttribute('href') ?? ''
        a.click()
        return href
      })()`),
    openBubbleDetails: async () => {
      await main.eval(`${BUBBLE}?.querySelector('details > summary')?.click()`)
      await sleep(250)
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
// 对话里的 ```mermaid 图（chat-ui 的 MermaidBlock）
//
// 锚点全是组件自己打的 data 属性：`data-mermaid-figure`（放图那一格，值是布局 fit / clip /
// natural）、`data-mermaid-pending`（占位行）、`data-mermaid-error`（错误卡）、`data-mermaid-expand`
// （放大按钮）、`data-mermaid-dialog`（放大弹窗的面板；遮罩是它的父节点，面板本身不是遮罩）。
// 卡片上的东西一律在**正文里含本轮标记的那条**助手消息里找（见 assistantBodyWith）—— 同一会话
// 前几轮的图还在上面；弹窗 portal 到 body 上，全局只会有一个。弹窗里的图认「不是 `.lucide` 的
// 那个 svg」：关闭按钮的 X 也是 svg。

/**
 * 正文里含 `marker` 的最后一条助手正文的 .markdown-body（认法同 chatPane 的 BUBBLE：`.min-w-0` 的
 * 直接子节点）。按标记认而不是直接取最后一条：新一轮刚发出、流式卡还没上屏时，「最后一条」是
 * 上一轮的那条 —— 它的图早就在了，等图的断言会在旧 DOM 上直接通过。
 */
const assistantBodyWith = (marker: string): string => `[...document.querySelectorAll(
  '[data-msg-role="assistant"][data-msg-type="message"] .markdown-body'
)].filter(
  (m) =>
    (m.parentElement?.className ?? '').includes('min-w-0') &&
    (m.textContent ?? '').includes(${JSON.stringify(marker)})
).pop()`

/** 那条助手正文里 mermaid 卡的此刻 */
export interface MermaidShot {
  /** 放图那一格的布局（`data-mermaid-figure` 的值：fit / clip / natural）；没有图 = null */
  figure: string | null
  /** 占位行的文字；没有 = null（流式中带行数，写完后是「渲染中」） */
  pending: string | null
  /** 错误卡里的源码；没有错误卡 = null */
  error: string | null
  /** 正文里 `<pre>` 的个数（卡片切到源码时会多一个） */
  pres: number
  /** 「放大查看」按钮在不在 */
  expandable: boolean
}

/** 颜色取样 —— 图里读的与令牌解析出来的，**同一次 eval** 里取（中间切了主题也不会错位） */
export interface MermaidColors {
  /** 第一个节点形状（fill 不是 none 的那个）的 computed fill */
  nodeFill: string
  /** 第一个节点标签的 computed color（`<text>` 标签取 fill） */
  labelColor: string
  /** 此刻 `var(--theme-bg-tertiary)` 的解析值 */
  bgTertiary: string
  /** 此刻 `var(--theme-text-primary)` 的解析值 */
  textPrimary: string
  /** 放图那一格的 computed background-color（透明 = 图直接坐在卡片底色上） */
  figureBackground: string
}

/** 放图那一格与图本身的几何（CSS px） */
export interface MermaidGeometry {
  mode: string
  /** 图的原始尺寸（根 `<svg>` 的 viewBox 宽高） */
  viewBox: { width: number; height: number }
  /** `<svg>` 的渲染矩形 */
  svg: { width: number; height: number }
  /** 放图那一格的外框（border-box） */
  box: { width: number; height: number }
  /** 截断时外框的上限：480 + 上下内边距 1.5rem（按根字号换算） */
  capHeight: number
}

export interface MermaidDialogShot {
  open: boolean
  /** 遮罩进入了关闭动效（`dialog-closing`） */
  closing: boolean
  /** 弹窗里那张图的渲染宽度 */
  svgWidth: number
  /** 它的 viewBox 宽（原宽） */
  viewBoxWidth: number
  /** 弹窗滚动区（图外面那层 overflow-auto） */
  scrollHeight: number
  clientHeight: number
}

/** 绑在「正文里含某个标记」的那条助手消息上（见 assistantBodyWith）；弹窗与主题是全局的 */
export interface MermaidPane {
  /** 那条正文里的 mermaid 卡；正文还没上屏、或里面没有 mermaid 卡 = null */
  shot(): Promise<MermaidShot | null>
  /** 等图画出来（`[data-mermaid-figure] > svg`） */
  waitFigure(timeoutMs?: number): Promise<void>
  colors(): Promise<MermaidColors>
  geometry(): Promise<MermaidGeometry>
  /** mermaid 失败时可能留在 body 上的东西：临时容器 `#d<id>`、它自己画的错误图 */
  leftovers(): Promise<{ tempNodes: number; syntaxError: boolean }>
  /** 根上的 data-theme */
  theme(): Promise<string>
  /** 直接改根上的 data-theme（MermaidBlock 观察的就是这个属性；不经设置，不落盘） */
  setTheme(id: string): Promise<void>
  /** 点「放大查看」并等弹窗出现 */
  openDialog(): Promise<void>
  dialog(): Promise<MermaidDialogShot>
  /** 三种关法之一，并等弹窗卸下（关闭动效 120ms） */
  closeDialog(via: 'escape' | 'backdrop' | 'button'): Promise<void>
}

export function mermaidPane(main: CdpClient, marker: string): MermaidPane {
  const BODY = assistantBodyWith(marker)
  const FIGURE = `(${BODY})?.querySelector('[data-mermaid-figure]')`
  const PANEL = `document.querySelector('[data-mermaid-dialog]')`

  const dialog = (): Promise<MermaidDialogShot> =>
    main.eval<MermaidDialogShot>(`(() => {
      const panel = ${PANEL}
      if (!panel) {
        return { open: false, closing: false, svgWidth: 0, viewBoxWidth: 0, scrollHeight: 0, clientHeight: 0 }
      }
      const svg = [...panel.querySelectorAll('svg')].find((s) => !s.classList.contains('lucide'))
      const scroller = svg?.closest('.overflow-auto')
      const vb = (svg?.getAttribute('viewBox') ?? '').trim().split(/[\\s,]+/).map(Number)
      return {
        open: true,
        closing: panel.parentElement?.classList.contains('dialog-closing') ?? false,
        svgWidth: svg ? svg.getBoundingClientRect().width : 0,
        viewBoxWidth: vb[2] ?? 0,
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0
      }
    })()`)

  return {
    shot: () =>
      main.eval<MermaidShot | null>(`(() => {
        const body = ${BODY}
        if (!body) return null
        const figure = body.querySelector('[data-mermaid-figure]')
        const pending = body.querySelector('[data-mermaid-pending]')
        const error = body.querySelector('[data-mermaid-error]')
        if (!figure && !pending && !error && !body.querySelector('[data-mermaid-expand]')) {
          // 切到源码的卡片没有上面任何一个锚点，只剩 <pre> —— 靠工具栏的「Mermaid」字样认
          const card = [...body.querySelectorAll('span')].find((s) => s.textContent === 'Mermaid')
          if (!card) return null
        }
        return {
          figure: figure ? figure.getAttribute('data-mermaid-figure') : null,
          pending: pending ? (pending.textContent ?? '').trim() : null,
          error: error ? (error.querySelector('pre')?.textContent ?? '') : null,
          pres: body.querySelectorAll('pre').length,
          expandable: !!body.querySelector('[data-mermaid-expand]')
        }
      })()`),
    waitFigure: async (timeoutMs = 25_000) => {
      await until(
        () => main.eval<boolean>(`!!(${BODY})?.querySelector('[data-mermaid-figure] > svg')`),
        `mermaid figure painted in the bubble with ${JSON.stringify(marker)}`,
        timeoutMs
      )
    },
    colors: () =>
      main.eval<MermaidColors>(`(() => {
        const figure = ${FIGURE}
        const svg = figure?.querySelector(':scope > svg')
        if (!svg) throw new Error('no mermaid figure on screen')
        const shape = [...svg.querySelectorAll('.node rect, .node path, .node polygon, .node circle')]
          .find((el) => {
            const fill = getComputedStyle(el).fill
            return !!fill && fill !== 'none'
          })
        const label = svg.querySelector('.node .nodeLabel, .node text')
        const probe = document.createElement('span')
        document.body.appendChild(probe)
        const resolve = (token) => {
          probe.style.color = 'var(' + token + ')'
          return getComputedStyle(probe).color
        }
        const bgTertiary = resolve('--theme-bg-tertiary')
        const textPrimary = resolve('--theme-text-primary')
        probe.remove()
        const labelStyle = label ? getComputedStyle(label) : null
        return {
          nodeFill: shape ? getComputedStyle(shape).fill : '',
          labelColor: !labelStyle
            ? ''
            : label.tagName.toLowerCase() === 'text'
              ? labelStyle.fill
              : labelStyle.color,
          bgTertiary,
          textPrimary,
          figureBackground: getComputedStyle(figure).backgroundColor
        }
      })()`),
    geometry: () =>
      main.eval<MermaidGeometry>(`(() => {
        const figure = ${FIGURE}
        const svg = figure?.querySelector(':scope > svg')
        if (!svg) throw new Error('no mermaid figure on screen')
        const vb = (svg.getAttribute('viewBox') ?? '').trim().split(/[\\s,]+/).map(Number)
        const sr = svg.getBoundingClientRect()
        const fr = figure.getBoundingClientRect()
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
        return {
          mode: figure.getAttribute('data-mermaid-figure') ?? '',
          viewBox: { width: vb[2] ?? 0, height: vb[3] ?? 0 },
          svg: { width: sr.width, height: sr.height },
          box: { width: fr.width, height: fr.height },
          capHeight: 480 + 1.5 * rem
        }
      })()`),
    leftovers: () =>
      main.eval<{ tempNodes: number; syntaxError: boolean }>(`({
        tempNodes: document.querySelectorAll('[id^="dmermaid"]').length,
        syntaxError: (document.body.innerText ?? '').includes('Syntax error in text')
      })`),
    theme: () => main.eval<string>(`document.documentElement.getAttribute('data-theme') ?? ''`),
    setTheme: async (id) => {
      await main.eval(
        `document.documentElement.setAttribute('data-theme', ${JSON.stringify(id)}); true`
      )
    },
    openDialog: async () => {
      await main.eval(`(() => {
        const btn = (${BODY})?.querySelector('[data-mermaid-expand]')
        if (!btn) throw new Error('no mermaid expand button on screen')
        btn.click()
        return true
      })()`)
      await until(() => main.eval<boolean>(`${PANEL} !== null`), 'mermaid dialog opened')
      // 等入场动效（.dialog-panel 从 scale(0.96) 放大，120ms）走完 —— 动效期间量到的矩形
      // 是缩小过的，「原宽」会差出 4%
      await main.eval(`(async () => {
        const panel = ${PANEL}
        await Promise.all(
          [panel, panel.parentElement].flatMap((el) => el.getAnimations()).map((a) => a.finished)
        )
        return true
      })()`)
    },
    dialog,
    closeDialog: async (via) => {
      const act =
        via === 'escape'
          ? `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
          : via === 'backdrop'
            ? // 点的是遮罩本身（面板的父节点）：点在面板里面不该关
              `${PANEL}.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }))`
            : `${PANEL}.querySelector('button[aria-label="Close"]').click()`
      await main.eval(`(() => { ${act}; return true })()`)
      await until(() => main.eval<boolean>(`${PANEL} === null`), `mermaid dialog closed via ${via}`)
    }
  }
}

/** 流式过程中 mermaid 卡的一帧（页内 MutationObserver 记录，连续相同的帧合并） */
export interface MermaidFrame {
  /** `Date.now()`（渲染进程的墙钟，与 spec 进程是同一台机器） */
  t: number
  /** 占位行的文字；没有 = null */
  pending: string | null
  /** 图在不在 */
  figure: boolean
  /** 错误卡在不在 */
  error: boolean
  /** 流式占位卡（`streaming-live`）在不在 = 这一轮还没结束 */
  busy: boolean
  /** 正文里是否已出现尾部标记（= 最后一片已经上屏） */
  tail: boolean
}

export interface MermaidWatch {
  /**
   * 开始观察正文里含 `headMarker` 的那条助手消息（幂等：重复调用重新开始）；那条消息还没上屏时
   * 记的是全空的帧。`tailMarker` 用来认「最后一片到了」
   */
  start(headMarker: string, tailMarker: string): Promise<void>
  frames(): Promise<MermaidFrame[]>
  /** 停止观察（不清空已记录的帧） */
  stop(): Promise<void>
}

/**
 * mermaid 卡的变动观察器 —— 「写围栏期间一直只有占位」「最后一片之后多久出图」都是**时段**断言，
 * 轮询（400ms 一次）会漏掉中间态；装在页内，每次 DOM 变动记一帧（同 bubbleWatch）。
 */
export function mermaidWatch(main: CdpClient): MermaidWatch {
  const KEY = '__e2eMermaidWatch'
  return {
    start: async (headMarker, tailMarker) => {
      await main.eval(`(() => {
        const prev = window.${KEY}
        if (prev && prev.obs) prev.obs.disconnect()
        const marker = ${JSON.stringify(tailMarker)}
        const state = { frames: [], obs: null }
        const snap = () => {
          const body = ${assistantBodyWith(headMarker)}
          const pending = body?.querySelector('[data-mermaid-pending]')
          const frame = {
            t: Date.now(),
            pending: pending ? (pending.textContent ?? '').trim() : null,
            figure: !!body?.querySelector('[data-mermaid-figure] > svg'),
            error: !!body?.querySelector('[data-mermaid-error]'),
            busy: !!document.querySelector('[data-msg-id="streaming-live"]'),
            tail: (body?.textContent ?? '').includes(marker)
          }
          const last = state.frames[state.frames.length - 1]
          if (
            last &&
            last.pending === frame.pending &&
            last.figure === frame.figure &&
            last.error === frame.error &&
            last.busy === frame.busy &&
            last.tail === frame.tail
          )
            return
          state.frames.push(frame)
        }
        snap()
        state.obs = new MutationObserver(snap)
        state.obs.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        })
        window.${KEY} = state
        return true
      })()`)
    },
    frames: () => main.eval<MermaidFrame[]>(`(window.${KEY}?.frames ?? []).map((f) => f)`),
    stop: async () => {
      await main.eval(`(() => {
        if (window.${KEY}?.obs) window.${KEY}.obs.disconnect()
        return true
      })()`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// A3 · 输入框 `@` 提及弹层（AtMentionPopover）—— 多源
//
// 裸 `@` 合并分区（文件 / 知识库两段，每源 ≤5，方向键跨段扁平循环）；`@源:query` 显式
// 路由单源（此时只一段、不出段头）。行锚点是组件自带的 data-at-suggestion：
//   - 文件     = 工作区相对路径（如 `docs/alpha-guide.md`）
//   - 知识条目 = `knowledge:` + 条目 id（如 `knowledge:knowledge/kb-a/notes/x.md`）
// 段头按 data-at-section 认（仅多源并出时渲染）；选中态按**结构类**认（键盘选中 =
// bg-accent/15），不认 i18n 文案。
// 候选表是异步拉的（files.scan / mentions.listKnowledgeEntries），行何时出现由 spec 用 until 等。

/** @ 弹层里的一行 */
export interface AtSuggestionRow {
  /** data-at-suggestion 属性值：文件=工作区相对路径；知识条目=`knowledge:`+条目 id */
  key: string
  /** 主文案（文件名 / 条目标题） */
  label: string
  /** 次文案（文件=所在目录；知识条目=所属库显示名）；无则空串 */
  detail: string
  /** 键盘选中态（bg-accent/15） */
  selected: boolean
}

export interface AtPopoverPane {
  /** 弹层是否在屏（有至少一行） */
  open(): Promise<boolean>
  /** 行快照（document 序 = 扁平循环序；段头不在其中） */
  rows(): Promise<AtSuggestionRow[]>
  /** 段头序列（data-at-section 值，DOM 序）；单源不出段头时为空 */
  sections(): Promise<string[]>
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
          label: (b.querySelector('span.text-accent')?.textContent ?? '').trim(),
          detail: (b.querySelector('span.text-text-tertiary')?.textContent ?? '').trim(),
          selected: b.className.includes('bg-accent/15')
        }))`
      ),
    sections: () =>
      main.eval<string[]>(
        `[...document.querySelectorAll('[data-at-section]')]
          .map((d) => d.getAttribute('data-at-section') ?? '')`
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
  /**
   * 某个分组头是否在屏。「组头消失」只能用它断：groupMenuShots 内部会先等组头**出现**，
   * 拿它断「不在」会把用例挂死而不是返回 null。
   */
  groupHeaderPresent(target: GroupTarget): Promise<boolean>
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
    groupHeaderPresent: (target) => main.eval<boolean>(`${HEADER(target)} !== undefined`),
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
  /**
   * 这一条由会话的 agent 档案声明（`data-declared`）：恒生效，画成已勾、禁用、挂锁 —— 不在
   * 会话勾选里，也不会被写进勾选。它的禁用与「运行时已建」的只读是两回事，按这个标记区分。
   */
  declared: boolean
  /** 悬停提示（`title`）：可改时是条目自己的说明，只读时换成「为什么改不了」，声明项说是谁声明的 */
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
      declared: label.hasAttribute('data-declared'),
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
    // 页脚 = 两个按钮那一层（[0] 取消，[1] 确认）
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
  /**
   * 这一行由会话的 agent 档案声明（`data-declared`）：恒生效，画成已勾、禁用、挂一把小锁 ——
   * 与「运行时已建」的只读不是一回事（那时整排压暗、触发钮挂锁），按这个标记区分。
   */
  declared: boolean
  /** 悬停提示（`title`）：只读时是「为什么改不了」，声明项是「谁声明的」，其余可改时没有 */
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
          declared: label.hasAttribute('data-declared'),
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
// 注册表笔记（bot / agent / 策略 / hook md 的笔记本会话）的正文与属性卡 —— 两个窗口共用。
//
// 作用域：点 Bots / 智能体 / 策略 / Hooks 分组的一行，主区就是那份文件的笔记本（同一时刻
// 只有它一个 .cm-content），作用域是整个 document。注册表笔记不再出现在设置窗
// （RegistryNoteView 随设置页注册表 tab 一并拆除）。
//
// 写入只走两条路，**绝不往 CodeMirror 里打字**：属性卡字段 `commitField`（真实编辑路径：失焦
// 提交 → 行级 scoped edit → 200ms 防抖自动保存落盘），或 seed.ts 的 `noteWrite`（写路径 IPC）。
//
// 「改名 / 合法性翻面时笔记没被卸载重开」请按会话 id 断（registryNoteSessions）：CM6 编辑器
// 本就按设计随外部写入重挂载（NotebookView 的 reloadNonce），DOM 侧钉不住。

/** 属性卡校验徽章的语义类（'' = 未上屏，或该类型没有校验器） */
export type FmCardStatus = 'ok' | 'warn' | 'err' | ''

/**
 * 「这条笔记本是只读的吗」的两个读数 —— 内置知识库条目与随包发布的内置档案 md 共用同一套
 * 只读笔记本，所以这两个读数也只该有一份（`knowledgePane` 与 `registryNotePane` 都摊开它）。
 *
 * ⚠️ 这里刻意不提供「模拟敲键」：本仓的 CDP 客户端只有 Runtime.evaluate（没有 Input 域），
 * 而 CodeMirror 6 不认合成的 `beforeinput` / `keydown`（实测两者都不会改文档，**可写**的
 * 笔记本也一样），所以那种助手只会造出一条两边都绿的假通道。要断「改不动」，断的是
 * `contenteditable` 这个开关本身 —— 同一个读数在可写笔记本上必须回 true（用例自带对照组），
 * 外加落盘字节不变。
 */
export interface NotebookReadOnlyProbes {
  /**
   * 笔记本编辑器可编辑吗 —— 读 `.cm-content` 的 `contenteditable`（只读时 CodeMirror 置成
   * `'false'`，此后**浏览器自己**就不把按键送进来了）。编辑器不在返回 null。
   */
  editorEditable(): Promise<boolean | null>
  /**
   * 当前笔记本有没有那张悬浮输入卡（只读笔记本没有）。判据是**编辑器之外**的 textarea ——
   * 属性卡的文本字段也是 textarea，而它是 CodeMirror 的 widget，住在 `.cm-editor` 里面，
   * 裸查 `document.querySelector('textarea')` 必然误命中。
   */
  hasInputCard(): Promise<boolean>
}

/** 上面那两个读数的实现（`scope` 是一段求值出容器元素或 document 的表达式） */
function notebookReadOnlyProbes(client: CdpClient, scope = 'document'): NotebookReadOnlyProbes {
  return {
    editorEditable: () =>
      client.eval<boolean | null>(`(() => {
        const el = ${scope}?.querySelector('.cm-content')
        return el ? el.getAttribute('contenteditable') !== 'false' : null
      })()`),

    hasInputCard: () =>
      client.eval<boolean>(
        `[...(${scope}?.querySelectorAll('textarea') ?? [])].some((t) => !t.closest('.cm-editor'))`
      )
  }
}

export interface RegistryNotePane extends NotebookReadOnlyProbes {
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
}

export function registryNotePane(client: CdpClient): RegistryNotePane {
  const ROOT = 'document'
  const FIELD = (key: string): string =>
    `${ROOT}?.querySelector('.cm-shuvix-fmcard-input[data-key=${JSON.stringify(key)}]')`

  const bodyText = (): Promise<string> =>
    client.eval<string>(`${ROOT}?.querySelector('.cm-content')?.textContent ?? ''`)
  const cardStatus = (): Promise<FmCardStatus> =>
    client.eval<FmCardStatus>(`(() => {
      const cls = ${ROOT}?.querySelector('.cm-shuvix-fmcard-status')?.className ?? ''
      return /is-(ok|warn|err)/.exec(cls)?.[1] ?? ''
    })()`)

  return {
    ...notebookReadOnlyProbes(client, ROOT),
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
// 主窗侧栏「智能体」分组（AgentGroup）—— 原设置页那个「智能体」tab 搬到前台之后的面。
//
// 锚点：分组头按 `data-group="agents"`（SessionGroup 的 group/header 层）认；内置行按
// `data-agent-builtin-row=<name>`（它没有文件，身份只能是 name），用户档案行按
// `data-agent-row=<fileName>`（名字随编辑在变、文件名不变），解析不过的琥珀行按
// `data-agent-invalid-row=<fileName>`；同名里不生效的那份（被覆盖的内置 / 输掉的用户文件）
// 另带 `data-agent-overridden`（划线 + 「已覆盖」徽标）。
//
// 点用户行 / 非法行打开的是那份文件的**笔记本会话**（隐藏项目 `__agents__`）—— 主区就是普通
// 笔记本，正文与属性卡经 `registryNotePane(main)` 读写，活动行 = 活动会话正是这份文件的笔记本。
// 内置行走的是**同一条路**：它的 md 随包发布在应用包里（运行时读的就是它），点行开的是那份文件的
// **只读**笔记本（载体项目 `__agents_builtin__`）。所以这里没有任何「预览框」的读数 —— 正文与
// 属性卡照样经 `registryNotePane(main)`，只读那一半经它的 `hasInputCard()` / `editorEditable()`。
// 分组是**懒扫**的：首次展开才扫，之后展开 / 窗口聚焦 /
// 组头菜单「刷新」/ `agent.changed` 事件（经宿主落盘的写入）重扫 —— 磁盘外写入不广播，
// 种完 md 要 refresh。菜单走与会话行同一套桩（pickFromMenu / openMenu）。
//
// ⚠️ 组头菜单的 `open-folder` **只许做存在性断言，绝不点**：它开的是 OS 文件管理器，e2e 关不掉。

/** 内置档案的一行（随包发布、没有文件） */
export interface AgentsBuiltinRow {
  name: string
  /** 显示名（本地化） */
  label: string
  /** 被同名用户档案压过：划线 */
  struck: boolean
  /** 「已覆盖」徽标（按三语认，同 Bots 组的口径） */
  badge: boolean
  /** 行首的锁 —— 内置恒有（生效与否都只能看），用户档案行首是空格 */
  locked: boolean
  /** 行的 title 提示（未被覆盖时是档案描述，被覆盖时说清「有个同名的自定义档案」） */
  title: string
}

/** 用户档案的一行 */
export interface AgentsUserRow {
  fileName: string
  label: string
  /** 同名里输掉了：划线 */
  struck: boolean
  badge: boolean
  /** 行首的锁（用户档案**不该**有：它可编辑，锁是内置的标记） */
  locked: boolean
  /** 行的 title 提示（输掉的那份说清被谁压过） */
  title: string
}

/** 分组里的活动行：用户档案与琥珀行给文件名，内置行给 name（它的身份就是 name） */
export interface AgentsActiveRow {
  row?: string
  invalidRow?: string
  builtinRow?: string
}

export interface AgentsSidebarPane {
  /** 组头显示的分组标签 */
  label(): Promise<string>
  /** 侧栏里 `data-group="agents"` 的组头个数（分组只该有一个） */
  headerCount(): Promise<number>
  /** 展开分组并等首次扫描落定 */
  expand(): Promise<void>
  builtinRows(): Promise<AgentsBuiltinRow[]>
  userRows(): Promise<AgentsUserRow[]>
  /** 非法文件行（琥珀）的文件名 */
  invalidRows(): Promise<string[]>
  /** 点一行用户档案并等它成为活动行（= 这份文件的笔记本成了活动会话） */
  selectUserRow(fileName: string): Promise<void>
  /** 点一行解析不过的文件并等它成为活动行 */
  selectInvalidRow(fileName: string): Promise<void>
  /** 当前活动行；活动会话不是任何档案文件的笔记本时为 null */
  activeRow(): Promise<AgentsActiveRow | null>
  /** 内置行的菜单项（开一次 ⋮、不选任何项）—— 要断 enabled，故回完整 items */
  builtinRowMenu(name: string): Promise<MenuItemShot[] | null>
  /** 开内置行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对） */
  pickBuiltinRowMenu(name: string, actionId: 'create-override'): Promise<void>
  /** 用户档案行菜单里的动作 id（生效的那份按名删、输掉的那份按文件名删） */
  userRowMenuIds(fileName: string): Promise<string[] | null>
  pickUserRowMenu(fileName: string, actionId: 'delete-agent' | 'delete-agent-file'): Promise<void>
  pickInvalidRowMenu(fileName: string, actionId: 'delete-agent-file'): Promise<void>
  /** 组头菜单里的动作 id（开一次 ⋮、不选任何项） */
  groupMenuIds(): Promise<string[] | null>
  /** 组头菜单「新建智能体」—— 只触发；新文件落盘与笔记打开由调用方 until */
  newAgent(): Promise<void>
  /** 组头菜单「刷新」—— 磁盘外改动不广播 agent.changed，需手动重扫 */
  refresh(): Promise<void>
  /** 点一行内置档案并等它成为活动行（= 随包那份 md 的只读笔记本成了活动会话） */
  openBuiltin(name: string): Promise<void>
}

export function agentsSidebarPane(main: CdpClient): AgentsSidebarPane {
  const HEADER_SEL = `div[class*="group/header"][data-group="agents"]`
  const HEADER = `document.querySelector('${HEADER_SEL}')`
  const TOGGLE = `[...(${HEADER}?.querySelectorAll(':scope > button') ?? [])].find((b) => b.querySelector('span.truncate'))`
  const COLLAPSE = `${HEADER}?.nextElementSibling`
  const BODY = `${COLLAPSE}?.firstElementChild?.firstElementChild`
  const BUILTIN_ROWS = `[...document.querySelectorAll('[data-agent-builtin-row]')]`
  const USER_ROWS = `[...document.querySelectorAll('[data-agent-row]')]`
  const INVALID_ROWS = `[...document.querySelectorAll('[data-agent-invalid-row]')]`
  const BUILTIN_ROW = (name: string): string =>
    `document.querySelector('[data-agent-builtin-row=${JSON.stringify(name)}]')`
  const USER_ROW = (fileName: string): string =>
    `document.querySelector('[data-agent-row=${JSON.stringify(fileName)}]')`
  const INVALID_ROW = (fileName: string): string =>
    `document.querySelector('[data-agent-invalid-row=${JSON.stringify(fileName)}]')`
  const ACTIVE = (list: string): string =>
    `${list}.find((r) => r.className.includes('bg-bg-active'))`
  /** 行的标签与徽标读法（三种行同构：span.truncate 是标签，划线在它身上） */
  const rowShot = (extra: string): string => `({
    label: (r.querySelector('span.truncate')?.textContent ?? '').trim(),
    struck: !!r.querySelector('.line-through'),
    badge: [...r.querySelectorAll('span')].some((s) => /覆盖|Overridden|上書き/.test(s.textContent ?? '')),
    ${extra}
  })`

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
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'agents group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (!open) await main.eval(`(${TOGGLE})?.click()`)
      // 扫描是懒的：展开才发第一次请求，正文有内容才算落定（内置档案恒非空）
      await until(
        () => main.eval<boolean>(`(${BODY}?.childElementCount ?? 0) > 0`),
        'agents group scanned'
      )
    },

    builtinRows: () =>
      main.eval<AgentsBuiltinRow[]>(
        `${BUILTIN_ROWS}.map((r) => ${rowShot(`name: r.getAttribute('data-agent-builtin-row') ?? '',
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    userRows: () =>
      main.eval<AgentsUserRow[]>(
        `${USER_ROWS}.map((r) => ${rowShot(`fileName: r.getAttribute('data-agent-row') ?? '',
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    invalidRows: () =>
      main.eval<string[]>(`${INVALID_ROWS}.map((r) => r.getAttribute('data-agent-invalid-row'))`),

    selectUserRow: (fileName) => clickUntilActive(USER_ROW(fileName), `agent row "${fileName}"`),

    selectInvalidRow: (fileName) =>
      clickUntilActive(INVALID_ROW(fileName), `invalid agent row "${fileName}"`),

    activeRow: () =>
      main.eval<AgentsActiveRow | null>(`(() => {
        const row = ${ACTIVE(USER_ROWS)}
        if (row) return { row: row.getAttribute('data-agent-row') }
        const invalid = ${ACTIVE(INVALID_ROWS)}
        if (invalid) return { invalidRow: invalid.getAttribute('data-agent-invalid-row') }
        // 内置行也会成为活动行（它的 md 同样开笔记本，只是只读）—— 少了这一段，
        // 「开着内置笔记时活动行是谁」只能答 null，与「谁都没选中」分不开
        const builtin = ${ACTIVE(BUILTIN_ROWS)}
        if (builtin) return { builtinRow: builtin.getAttribute('data-agent-builtin-row') }
        return null
      })()`),

    builtinRowMenu: async (name) => {
      await until(
        () => main.eval<boolean>(`${BUILTIN_ROW(name)} !== null`),
        `builtin row "${name}"`
      )
      return openMenu(main, BUILTIN_ROW(name), 'menu-button')
    },

    pickBuiltinRowMenu: async (name, actionId) => {
      await until(
        () => main.eval<boolean>(`${BUILTIN_ROW(name)} !== null`),
        `builtin row "${name}"`
      )
      await pickFromMenu(main, BUILTIN_ROW(name), actionId, `builtin agent row "${name}"`)
    },

    userRowMenuIds: (fileName) => menuIds(USER_ROW(fileName), `agent row "${fileName}"`),

    pickUserRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${USER_ROW(fileName)} !== null`),
        `agent row "${fileName}"`
      )
      await pickFromMenu(main, USER_ROW(fileName), actionId, `agent row "${fileName}"`)
    },

    pickInvalidRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${INVALID_ROW(fileName)} !== null`),
        `invalid agent row "${fileName}"`
      )
      await pickFromMenu(main, INVALID_ROW(fileName), actionId, `invalid agent row "${fileName}"`)
    },

    groupMenuIds: async () => {
      const items = await openMenu(main, HEADER, 'menu-button')
      return items ? items.filter((it) => it.id).map((it) => it.id as string) : null
    },

    newAgent: () => pickFromMenu(main, HEADER, 'new-agent', 'agents group header'),

    refresh: async () => {
      await pickFromMenu(main, HEADER, 'refresh', 'agents group header')
      await sleep(200)
    },

    // 与点用户行同一条路（openBuiltinNote → 重拉会话列表 → 选中），只是开出来的笔记是只读的。
    // **不等正文**：切换后先 note.waitBody(...)
    openBuiltin: (name) => clickUntilActive(BUILTIN_ROW(name), `builtin agent row "${name}"`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗侧栏「安全策略」分组（PolicyGroup）—— 与 agentsSidebarPane 同形面。
//
// 锚点：分组头按 `data-group="policies"`（SessionGroup 的 group/header 层）认；内置行按
// `data-policy-builtin-row=<name>`（身份是 name），用户策略行按 `data-policy-row=<fileName>`
// （名字随编辑在变、文件名不变），解析不过的琥珀行按 `data-policy-invalid-row=<fileName>`；
// 同名里不生效的那份（被覆盖的内置 / 输掉的用户文件）另带 `data-policy-overridden`
// （划线 + 「已覆盖」徽标）。
//
// 点用户行 / 非法行打开的是那份文件的**笔记本会话**（隐藏项目 `__policies__`）—— 主区就是普通
// 笔记本，正文与属性卡经 `registryNotePane(main)` 读写，活动行 = 活动会话正是这份文件的笔记本。
// 内置行走的是同一条路：它的 md 随包发布在应用包里（运行时读的就是它），点行开的是那份文件的
// **只读**笔记本（载体项目 `__policies_builtin__`）—— 只读那一半经 `registryNotePane(main)`
// 的 `hasInputCard()` / `editorEditable()` 断言。
// 分组是**懒扫**的：首次展开才扫，之后展开 / 窗口聚焦 / 组头菜单「刷新」/ `policy.changed`
// 事件（经宿主落盘的写入，300ms 合并广播）重扫 —— 磁盘外写入不广播，种完 md 要 refresh。
// 菜单走与会话行同一套桩（pickFromMenu / openMenu）。
//
// ⚠️ 组头菜单的 `open-folder` **只许做存在性断言，绝不点**：它开的是 OS 文件管理器，e2e 关不掉。

/** 内置策略的一行（随包发布、运行时按语言挑中的那份 md） */
export interface PoliciesBuiltinRow {
  name: string
  /** 显示名（本地化） */
  label: string
  /** 被同名用户策略压过：划线 */
  struck: boolean
  /** 「已覆盖」徽标（按三语认，同 Bots / 智能体组的口径） */
  badge: boolean
  /** 行首的锁 —— 内置恒有（生效与否都只能看）；用户策略行首留空 */
  locked: boolean
  /** 行的 title 提示（未被覆盖时是策略描述，被覆盖时说清「有个同名的自定义策略」） */
  title: string
}

/** 用户策略的一行 */
export interface PoliciesUserRow {
  fileName: string
  label: string
  /** 同名里输掉了：划线 */
  struck: boolean
  badge: boolean
  /** 行首的锁（用户策略**不该**有：它可编辑，锁是内置的标记） */
  locked: boolean
  /** 行的 title 提示（输掉的那份说清被谁压过） */
  title: string
}

/** 解析不过的琥珀行（身份是文件名 —— 它解析不出 name） */
export interface PoliciesInvalidRow {
  fileName: string
  /** 行上显示的字 = 文件名（font-mono） */
  label: string
  /** 文件名是 font-mono 排的（与用户策略行的正文字体区分开） */
  mono: boolean
  /** 行的 title 提示 = 解析器的人读拒绝理由 */
  title: string
  /** 琥珀行没有锁 / 划线 / 徽标 —— 留这三个读数是为了能断「没有」 */
  locked: boolean
  struck: boolean
  badge: boolean
}

/** 分组里的活动行：用户策略与琥珀行给文件名，内置行给 name（它的身份就是 name） */
export interface PoliciesActiveRow {
  row?: string
  invalidRow?: string
  builtinRow?: string
}

export interface PoliciesSidebarPane {
  /** 组头显示的分组标签 */
  label(): Promise<string>
  /** 侧栏里 `data-group="policies"` 的组头个数（分组只该有一个） */
  headerCount(): Promise<number>
  /**
   * 分组正文的子节点数 —— **懒扫**的判据：首次展开前 scanned 为 null，正文一个子节点都不渲染。
   * 扫过之后折叠只是收高度（AnimatedCollapse），行仍在 DOM 里，此读数不再归零。
   */
  bodyChildCount(): Promise<number>
  /** 组头高亮（活动会话是某份策略 md 的笔记本时 SessionGroup 的 active 分支） */
  headerActive(): Promise<boolean>
  /** 展开分组并等首次扫描落定（内置策略恒非空，正文有内容即落定） */
  expand(): Promise<void>
  /** 折叠分组（幂等）—— 再展开会触发一次重扫 */
  collapse(): Promise<void>
  builtinRows(): Promise<PoliciesBuiltinRow[]>
  userRows(): Promise<PoliciesUserRow[]>
  /** 非法文件行（琥珀）的快照（DOM 序） */
  invalidRows(): Promise<PoliciesInvalidRow[]>
  /** 点一行用户策略并等它成为活动行（= 这份文件的笔记本成了活动会话） */
  selectUserRow(fileName: string): Promise<void>
  /** 点一行解析不过的文件并等它成为活动行 */
  selectInvalidRow(fileName: string): Promise<void>
  /** 点一行内置策略并等它成为活动行（= 随包那份 md 的只读笔记本成了活动会话） */
  openBuiltin(name: string): Promise<void>
  /** 当前活动行；活动会话不是任何策略文件的笔记本时为 null */
  activeRow(): Promise<PoliciesActiveRow | null>
  /** 内置行的菜单项（开一次 ⋮、不选任何项）—— 要断 enabled，故回完整 items */
  builtinRowMenu(name: string): Promise<MenuItemShot[] | null>
  /** 开内置行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对） */
  pickBuiltinRowMenu(name: string, actionId: 'create-override'): Promise<void>
  /** 用户策略行菜单里的动作 id（生效的那份按名删、输掉的那份按文件名删） */
  userRowMenuIds(fileName: string): Promise<string[] | null>
  pickUserRowMenu(fileName: string, actionId: 'delete-policy' | 'delete-policy-file'): Promise<void>
  pickInvalidRowMenu(fileName: string, actionId: 'delete-policy-file'): Promise<void>
  /** 组头菜单的**原始 items**（开一次 ⋮、不选任何项；含分隔符 —— PS-C1 断的是形状） */
  groupMenuItems(): Promise<MenuItemShot[] | null>
  /** 组头菜单「新建策略」—— 只触发；新文件落盘与笔记打开由调用方 until */
  newPolicy(): Promise<void>
  /** 组头菜单「刷新」—— 磁盘外改动不广播 policy.changed，需手动重扫 */
  refresh(): Promise<void>
}

export function policiesSidebarPane(main: CdpClient): PoliciesSidebarPane {
  const HEADER_SEL = `div[class*="group/header"][data-group="policies"]`
  const HEADER = `document.querySelector('${HEADER_SEL}')`
  const TOGGLE = `[...(${HEADER}?.querySelectorAll(':scope > button') ?? [])].find((b) => b.querySelector('span.truncate'))`
  const COLLAPSE = `${HEADER}?.nextElementSibling`
  const BODY = `${COLLAPSE}?.firstElementChild?.firstElementChild`
  const BUILTIN_ROWS = `[...document.querySelectorAll('[data-policy-builtin-row]')]`
  const USER_ROWS = `[...document.querySelectorAll('[data-policy-row]')]`
  const INVALID_ROWS = `[...document.querySelectorAll('[data-policy-invalid-row]')]`
  const BUILTIN_ROW = (name: string): string =>
    `document.querySelector('[data-policy-builtin-row=${JSON.stringify(name)}]')`
  const USER_ROW = (fileName: string): string =>
    `document.querySelector('[data-policy-row=${JSON.stringify(fileName)}]')`
  const INVALID_ROW = (fileName: string): string =>
    `document.querySelector('[data-policy-invalid-row=${JSON.stringify(fileName)}]')`
  const ACTIVE = (list: string): string =>
    `${list}.find((r) => r.className.includes('bg-bg-active'))`
  /** 行的标签与徽标读法（三种行同构：span.truncate 是标签，划线在它身上） */
  const rowShot = (extra: string): string => `({
    label: (r.querySelector('span.truncate')?.textContent ?? '').trim(),
    struck: !!r.querySelector('.line-through'),
    badge: [...r.querySelectorAll('span')].some((s) => /覆盖|Overridden|上書き/.test(s.textContent ?? '')),
    ${extra}
  })`

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

    bodyChildCount: () => main.eval<number>(`${BODY}?.childElementCount ?? 0`),

    // 组头高亮在 SessionGroup 的包裹层（active 分支给 data-group 那层的父级加 bg-bg-primary/30）
    headerActive: () =>
      main.eval<boolean>(
        `(${HEADER}?.parentElement?.className ?? '').includes('bg-bg-primary/30')`
      ),

    expand: async () => {
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'policies group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (!open) await main.eval(`(${TOGGLE})?.click()`)
      // 扫描是懒的：展开才发第一次请求，正文有内容才算落定（内置策略恒非空）
      await until(
        () => main.eval<boolean>(`(${BODY}?.childElementCount ?? 0) > 0`),
        'policies group scanned'
      )
    },

    collapse: async () => {
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'policies group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (open) await main.eval(`(${TOGGLE})?.click()`)
      await until(
        () => main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '0fr'`),
        'policies group collapsed'
      )
    },

    builtinRows: () =>
      main.eval<PoliciesBuiltinRow[]>(
        `${BUILTIN_ROWS}.map((r) => ${rowShot(`name: r.getAttribute('data-policy-builtin-row') ?? '',
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    userRows: () =>
      main.eval<PoliciesUserRow[]>(
        `${USER_ROWS}.map((r) => ${rowShot(`fileName: r.getAttribute('data-policy-row') ?? '',
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    invalidRows: () =>
      main.eval<PoliciesInvalidRow[]>(
        `${INVALID_ROWS}.map((r) => ${rowShot(`fileName: r.getAttribute('data-policy-invalid-row') ?? '',
    mono: !!r.querySelector('.font-mono'),
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    selectUserRow: (fileName) => clickUntilActive(USER_ROW(fileName), `policy row "${fileName}"`),

    selectInvalidRow: (fileName) =>
      clickUntilActive(INVALID_ROW(fileName), `invalid policy row "${fileName}"`),

    // 与点用户行同一条路（openBuiltinNote → 重拉会话列表 → 选中），只是开出来的笔记是只读的。
    // **不等正文**：切换后先 note.waitCard() / waitBody(...)
    openBuiltin: (name) => clickUntilActive(BUILTIN_ROW(name), `builtin policy row "${name}"`),

    activeRow: () =>
      main.eval<PoliciesActiveRow | null>(`(() => {
        const row = ${ACTIVE(USER_ROWS)}
        if (row) return { row: row.getAttribute('data-policy-row') }
        const invalid = ${ACTIVE(INVALID_ROWS)}
        if (invalid) return { invalidRow: invalid.getAttribute('data-policy-invalid-row') }
        // 内置行也会成为活动行（它的 md 同样开笔记本，只是只读）—— 少了这一段，
        // 「开着内置笔记时活动行是谁」只能答 null，与「谁都没选中」分不开
        const builtin = ${ACTIVE(BUILTIN_ROWS)}
        if (builtin) return { builtinRow: builtin.getAttribute('data-policy-builtin-row') }
        return null
      })()`),

    builtinRowMenu: async (name) => {
      await until(
        () => main.eval<boolean>(`${BUILTIN_ROW(name)} !== null`),
        `builtin policy row "${name}"`
      )
      return openMenu(main, BUILTIN_ROW(name), 'menu-button')
    },

    pickBuiltinRowMenu: async (name, actionId) => {
      await until(
        () => main.eval<boolean>(`${BUILTIN_ROW(name)} !== null`),
        `builtin policy row "${name}"`
      )
      await pickFromMenu(main, BUILTIN_ROW(name), actionId, `builtin policy row "${name}"`)
    },

    userRowMenuIds: (fileName) => menuIds(USER_ROW(fileName), `policy row "${fileName}"`),

    pickUserRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${USER_ROW(fileName)} !== null`),
        `policy row "${fileName}"`
      )
      await pickFromMenu(main, USER_ROW(fileName), actionId, `policy row "${fileName}"`)
    },

    pickInvalidRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${INVALID_ROW(fileName)} !== null`),
        `invalid policy row "${fileName}"`
      )
      await pickFromMenu(main, INVALID_ROW(fileName), actionId, `invalid policy row "${fileName}"`)
    },

    groupMenuItems: () => openMenu(main, HEADER, 'menu-button'),

    newPolicy: () => pickFromMenu(main, HEADER, 'new-policy', 'policies group header'),

    refresh: async () => {
      await pickFromMenu(main, HEADER, 'refresh', 'policies group header')
      await sleep(200)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗侧栏「Hooks」分组（HookGroup）—— 与 policiesSidebarPane 同形面。
//
// 锚点：分组头按 `data-group="hooks"`（SessionGroup 的 group/header 层）认；内置行按
// `data-hook-builtin-row=<name>`（身份是 name），用户 hook 行按 `data-hook-row=<fileName>`
// （名字随编辑在变、文件名不变），解析不过的琥珀行按 `data-hook-invalid-row=<fileName>`；
// 同名里不生效的那份（被覆盖的内置 / 输掉的用户文件）另带 `data-hook-overridden`
// （划线 + 「已覆盖」徽标 —— 徽标带 `group-hover:invisible`，悬停隐去不挡 ⋮，DOM 里恒在）。
// 行标签是行的**直接子** span.truncate（不包一层 div —— 侧栏 e2e 按「div > span.truncate」
// 认会话行，hook 行刻意避开那个形状）。
//
// 点用户行 / 非法行打开的是那份文件的**笔记本会话**（隐藏项目 `__hooks__`）—— 主区就是普通
// 笔记本，正文与属性卡经 `registryNotePane(main)` 读写，活动行 = 活动会话正是这份文件的笔记本。
// 内置行走同一条路：它的 md 随包发布（运行时读的就是它），点行开的是那份文件的**只读**笔记本
// （载体项目 `__hooks_builtin__`）—— 只读那一半经 `registryNotePane(main)` 的
// `hasInputCard()` / `editorEditable()` 断言。
// 分组是**懒扫**的：首次展开才扫，之后展开 / 窗口聚焦 / 组头菜单「刷新」/ `hook.changed`
// 事件（经宿主落盘的写入，300ms 合并广播）重扫 —— 磁盘外写入不广播，种完 md 要 refresh。
// 菜单走与会话行同一套桩（pickFromMenu / openMenu）。
//
// ⚠️ 组头菜单的 `open-folder` **只许做存在性断言，绝不点**：它开的是 OS 文件管理器，e2e 关不掉。

/** 内置 hook 的一行（随包发布、运行时按语言挑中的那份 md） */
export interface HooksBuiltinRow {
  name: string
  /** 显示名（本地化） */
  label: string
  /** 被同名用户 hook 压过：划线 */
  struck: boolean
  /** 「已覆盖」徽标（按三语认，同策略组的口径） */
  badge: boolean
  /** 行首的锁 —— 内置恒有（生效与否都只能看）；用户 hook 行首留空 */
  locked: boolean
  /** 行的 title 提示（未被覆盖时是 hook 描述，被覆盖时说清「有个同名的自定义 hook」） */
  title: string
}

/** 用户 hook 的一行 */
export interface HooksUserRow {
  fileName: string
  label: string
  /** 同名里输掉了：划线 */
  struck: boolean
  badge: boolean
  /** 行首的锁（用户 hook **不该**有：它可编辑，锁是内置的标记） */
  locked: boolean
  /** 行的 title 提示（输掉的那份说清被谁压过） */
  title: string
}

/** 解析不过的琥珀行（身份是文件名 —— 它解析不出 name） */
export interface HooksInvalidRow {
  fileName: string
  /** 行上显示的字 = 文件名（font-mono） */
  label: string
  /** 文件名是 font-mono 排的（与用户 hook 行的正文字体区分开） */
  mono: boolean
  /** 行的 title 提示 = 解析器的人读拒绝理由 */
  title: string
  /** 琥珀行没有锁 / 划线 / 徽标 —— 留这三个读数是为了能断「没有」 */
  locked: boolean
  struck: boolean
  badge: boolean
}

/** 分组里的活动行：用户 hook 与琥珀行给文件名，内置行给 name（它的身份就是 name） */
export interface HooksActiveRow {
  row?: string
  invalidRow?: string
  builtinRow?: string
}

export interface HooksSidebarPane {
  /** 组头显示的分组标签 */
  label(): Promise<string>
  /** 侧栏里 `data-group="hooks"` 的组头个数（分组只该有一个） */
  headerCount(): Promise<number>
  /**
   * 分组正文的子节点数 —— **懒扫**的判据：首次展开前 scanned 为 null，正文一个子节点都不渲染。
   * 扫过之后折叠只是收高度（AnimatedCollapse），行仍在 DOM 里，此读数不再归零。
   */
  bodyChildCount(): Promise<number>
  /** 组头高亮（活动会话是某份 hook md 的笔记本时 SessionGroup 的 active 分支） */
  headerActive(): Promise<boolean>
  /** 展开分组并等首次扫描落定（内置 hook 恒非空，正文有内容即落定） */
  expand(): Promise<void>
  /** 折叠分组（幂等）—— 再展开会触发一次重扫 */
  collapse(): Promise<void>
  builtinRows(): Promise<HooksBuiltinRow[]>
  userRows(): Promise<HooksUserRow[]>
  /** 非法文件行（琥珀）的快照（DOM 序） */
  invalidRows(): Promise<HooksInvalidRow[]>
  /** 点一行用户 hook 并等它成为活动行（= 这份文件的笔记本成了活动会话） */
  selectUserRow(fileName: string): Promise<void>
  /** 点一行解析不过的文件并等它成为活动行 */
  selectInvalidRow(fileName: string): Promise<void>
  /** 点一行内置 hook 并等它成为活动行（= 随包那份 md 的只读笔记本成了活动会话） */
  openBuiltin(name: string): Promise<void>
  /** 当前活动行；活动会话不是任何 hook 文件的笔记本时为 null */
  activeRow(): Promise<HooksActiveRow | null>
  /** 内置行的菜单项（开一次 ⋮、不选任何项）—— 要断 enabled，故回完整 items */
  builtinRowMenu(name: string): Promise<MenuItemShot[] | null>
  /** 开内置行的 ⋮ 并选中一项（自带「该项真的在菜单里」的核对） */
  pickBuiltinRowMenu(name: string, actionId: 'create-override'): Promise<void>
  /** 用户 hook 行菜单里的动作 id（生效的那份按名删、输掉的那份按文件名删） */
  userRowMenuIds(fileName: string): Promise<string[] | null>
  pickUserRowMenu(fileName: string, actionId: 'delete-hook' | 'delete-hook-file'): Promise<void>
  pickInvalidRowMenu(fileName: string, actionId: 'delete-hook-file'): Promise<void>
  /** 组头菜单的**原始 items**（开一次 ⋮、不选任何项；含分隔符 —— HS-C1 断的是形状） */
  groupMenuItems(): Promise<MenuItemShot[] | null>
  /** 组头菜单「新建 Hook」—— 只触发；新文件落盘与笔记打开由调用方 until */
  newHook(): Promise<void>
  /** 组头菜单「刷新」—— 磁盘外改动不广播 hook.changed，需手动重扫 */
  refresh(): Promise<void>
}

export function hooksSidebarPane(main: CdpClient): HooksSidebarPane {
  const HEADER_SEL = `div[class*="group/header"][data-group="hooks"]`
  const HEADER = `document.querySelector('${HEADER_SEL}')`
  const TOGGLE = `[...(${HEADER}?.querySelectorAll(':scope > button') ?? [])].find((b) => b.querySelector('span.truncate'))`
  const COLLAPSE = `${HEADER}?.nextElementSibling`
  const BODY = `${COLLAPSE}?.firstElementChild?.firstElementChild`
  const BUILTIN_ROWS = `[...document.querySelectorAll('[data-hook-builtin-row]')]`
  const USER_ROWS = `[...document.querySelectorAll('[data-hook-row]')]`
  const INVALID_ROWS = `[...document.querySelectorAll('[data-hook-invalid-row]')]`
  const BUILTIN_ROW = (name: string): string =>
    `document.querySelector('[data-hook-builtin-row=${JSON.stringify(name)}]')`
  const USER_ROW = (fileName: string): string =>
    `document.querySelector('[data-hook-row=${JSON.stringify(fileName)}]')`
  const INVALID_ROW = (fileName: string): string =>
    `document.querySelector('[data-hook-invalid-row=${JSON.stringify(fileName)}]')`
  const ACTIVE = (list: string): string =>
    `${list}.find((r) => r.className.includes('bg-bg-active'))`
  /** 行的标签与徽标读法（三种行同构：span.truncate 是标签，划线在它身上） */
  const rowShot = (extra: string): string => `({
    label: (r.querySelector('span.truncate')?.textContent ?? '').trim(),
    struck: !!r.querySelector('.line-through'),
    badge: [...r.querySelectorAll('span')].some((s) => /覆盖|Overridden|上書き/.test(s.textContent ?? '')),
    ${extra}
  })`

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

    bodyChildCount: () => main.eval<number>(`${BODY}?.childElementCount ?? 0`),

    // 组头高亮在 SessionGroup 的包裹层（active 分支给 data-group 那层的父级加 bg-bg-primary/30）
    headerActive: () =>
      main.eval<boolean>(
        `(${HEADER}?.parentElement?.className ?? '').includes('bg-bg-primary/30')`
      ),

    expand: async () => {
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'hooks group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (!open) await main.eval(`(${TOGGLE})?.click()`)
      // 扫描是懒的：展开才发第一次请求，正文有内容才算落定（内置 hook 恒非空）
      await until(
        () => main.eval<boolean>(`(${BODY}?.childElementCount ?? 0) > 0`),
        'hooks group scanned'
      )
    },

    collapse: async () => {
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'hooks group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (open) await main.eval(`(${TOGGLE})?.click()`)
      await until(
        () => main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '0fr'`),
        'hooks group collapsed'
      )
    },

    builtinRows: () =>
      main.eval<HooksBuiltinRow[]>(
        `${BUILTIN_ROWS}.map((r) => ${rowShot(`name: r.getAttribute('data-hook-builtin-row') ?? '',
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    userRows: () =>
      main.eval<HooksUserRow[]>(
        `${USER_ROWS}.map((r) => ${rowShot(`fileName: r.getAttribute('data-hook-row') ?? '',
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    invalidRows: () =>
      main.eval<HooksInvalidRow[]>(
        `${INVALID_ROWS}.map((r) => ${rowShot(`fileName: r.getAttribute('data-hook-invalid-row') ?? '',
    mono: !!r.querySelector('.font-mono'),
    locked: !!r.querySelector('.lucide-lock'),
    title: r.getAttribute('title') ?? ''`)})`
      ),

    selectUserRow: (fileName) => clickUntilActive(USER_ROW(fileName), `hook row "${fileName}"`),

    selectInvalidRow: (fileName) =>
      clickUntilActive(INVALID_ROW(fileName), `invalid hook row "${fileName}"`),

    // 与点用户行同一条路（openBuiltinNote → 重拉会话列表 → 选中），只是开出来的笔记是只读的。
    // **不等正文**：切换后先 note.waitCard() / waitBody(...)
    openBuiltin: (name) => clickUntilActive(BUILTIN_ROW(name), `builtin hook row "${name}"`),

    activeRow: () =>
      main.eval<HooksActiveRow | null>(`(() => {
        const row = ${ACTIVE(USER_ROWS)}
        if (row) return { row: row.getAttribute('data-hook-row') }
        const invalid = ${ACTIVE(INVALID_ROWS)}
        if (invalid) return { invalidRow: invalid.getAttribute('data-hook-invalid-row') }
        // 内置行也会成为活动行（它的 md 同样开笔记本，只是只读）—— 少了这一段，
        // 「开着内置笔记时活动行是谁」只能答 null，与「谁都没选中」分不开
        const builtin = ${ACTIVE(BUILTIN_ROWS)}
        if (builtin) return { builtinRow: builtin.getAttribute('data-hook-builtin-row') }
        return null
      })()`),

    builtinRowMenu: async (name) => {
      await until(
        () => main.eval<boolean>(`${BUILTIN_ROW(name)} !== null`),
        `builtin hook row "${name}"`
      )
      return openMenu(main, BUILTIN_ROW(name), 'menu-button')
    },

    pickBuiltinRowMenu: async (name, actionId) => {
      await until(
        () => main.eval<boolean>(`${BUILTIN_ROW(name)} !== null`),
        `builtin hook row "${name}"`
      )
      await pickFromMenu(main, BUILTIN_ROW(name), actionId, `builtin hook row "${name}"`)
    },

    userRowMenuIds: (fileName) => menuIds(USER_ROW(fileName), `hook row "${fileName}"`),

    pickUserRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${USER_ROW(fileName)} !== null`),
        `hook row "${fileName}"`
      )
      await pickFromMenu(main, USER_ROW(fileName), actionId, `hook row "${fileName}"`)
    },

    pickInvalidRowMenu: async (fileName, actionId) => {
      await until(
        () => main.eval<boolean>(`${INVALID_ROW(fileName)} !== null`),
        `invalid hook row "${fileName}"`
      )
      await pickFromMenu(main, INVALID_ROW(fileName), actionId, `invalid hook row "${fileName}"`)
    },

    groupMenuItems: () => openMenu(main, HEADER, 'menu-button'),

    newHook: () => pickFromMenu(main, HEADER, 'new-hook', 'hooks group header'),

    refresh: async () => {
      await pickFromMenu(main, HEADER, 'refresh', 'hooks group header')
      await sleep(200)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 侧栏「技能」分组（SkillGroup）+ 「添加外部技能目录」取名框（SkillDirDialog）
//
// 这一组比智能体那组**多一层**：技能是目录，所以目录成行、可折叠（`[data-skill-folder]`），
// 而默认目录（`~/.shuvix/skills/`）刻意**不画文件夹行**，它的技能平铺在最后（`pl-2.5` 而非
// `pl-6`）。于是「这一行归谁」不能靠全局选择器回答 —— 平铺行与某个目录下的行长得一样，只差
// 缩进。`rowsUnder(dirName)` 从那行文件夹的 `nextElementSibling`（AnimatedCollapse 那层）里取，
// `flatRows()` 取分组正文的**直接子元素**里带 `data-skill-row` 的那些，两者合起来才是全集。
//
// 锚点：组头 `[data-group="skills"]`、目录行 `[data-skill-folder=<dirName>]`、技能行
// `[data-skill-row=<skill.name>]`（是**技能标识**，外部技能带 `<dirName>:` 前缀，与行上显示的
// 短名不同）、两级禁用都用同一个 `data-skill-off`、取名框 `[data-skill-dir-dialog]`。
// 折叠状态没有属性，只能看文件夹图标的字形类（`.lucide-folder-open` = 展开）——
// 这是本组唯一按字形认的东西，动画本身不测。

export interface SkillFolderShot {
  /** 目录键：内置固定 `builtin`，外部是用户取的名字（默认目录不画行，不会出现在这里） */
  dirName: string
  /** 行上显示的字（内置是本地化的「内置」，外部就是目录名） */
  label: string
  /** 内置目录的锁徽标 */
  locked: boolean
  /** 整组开关关掉（`data-skill-off`） */
  off: boolean
  /** 展开态（文件夹图标为打开形） */
  open: boolean
}

export interface SkillRowShot {
  /** 技能标识（外部技能带 `<dirName>:` 前缀）—— 宿主按它认 */
  name: string
  /** 行上显示的短名 */
  label: string
  /** 变淡：技能自己关了**或**整组关了（两者共用 `data-skill-off`） */
  off: boolean
  /** 缩进（`pl-6`）= 属于某个目录行；默认目录的平铺行不缩进 */
  indented: boolean
  active: boolean
}

export interface SkillDirDialogPane {
  waitOpen(): Promise<void>
  waitClosed(): Promise<void>
  isOpen(): Promise<boolean>
  /** 框头上那行只读路径（OS 选择器选中的目录） */
  path(): Promise<string>
  /** 输入框当前值（缺省预填目录名）；框不在返回 null */
  name(): Promise<string | null>
  /** 改名（native setter + input 事件 —— React 受控输入只认这一条路） */
  setName(value: string): Promise<void>
  /** 点「添加」；成功会自己关，失败停留并显示原因 */
  submit(): Promise<void>
  /** 宿主给的失败原因（原样显示）；没有为空串 */
  error(): Promise<string>
  cancel(): Promise<void>
}

export interface SkillsSidebarPane {
  /** 组头显示的分组标签 */
  label(): Promise<string>
  /** 展开分组并等首次扫描落定 */
  expand(): Promise<void>
  /** 目录行（DOM 序 = 展示序：内置置顶 → 外部按添加顺序） */
  folders(): Promise<SkillFolderShot[]>
  /** 点一行目录并等折叠态翻面 */
  toggleFolder(dirName: string): Promise<void>
  /** 全部技能行（DOM 序） */
  rows(): Promise<SkillRowShot[]>
  /** 某个目录行下面的技能行（全局选择器分不出归属，见本节开头） */
  rowsUnder(dirName: string): Promise<SkillRowShot[]>
  /** 默认目录那一摞平铺行（分组正文的直接子元素） */
  flatRows(): Promise<SkillRowShot[]>
  /** 点一行技能并等它成为活动行（= 这份 SKILL.md 的笔记本成了活动会话） */
  openSkill(name: string): Promise<void>
  /** 当前活动行的技能标识；活动会话不是任何技能笔记时为 null */
  activeRow(): Promise<string | null>
  /** 组头菜单里的动作 id（开一次 ⋮、不选任何项） */
  groupMenuIds(): Promise<string[] | null>
  pickGroupMenu(actionId: string): Promise<void>
  /** 目录行菜单里的动作 id */
  folderMenuIds(dirName: string): Promise<string[] | null>
  pickFolderMenu(dirName: string, actionId: string): Promise<void>
  /** 技能行菜单里的动作 id */
  skillMenuIds(name: string): Promise<string[] | null>
  pickSkillMenu(name: string, actionId: string): Promise<void>
  /** 组头菜单「刷新」—— 绕过宿主直接写盘不广播 `skill.changed`，需手动重扫 */
  refresh(): Promise<void>
  /** 空态文案（一个技能都没有时）；有内容返回空串 */
  emptyText(): Promise<string>
  /** 「添加外部技能目录」取名框 */
  skillDirDialog(): SkillDirDialogPane
}

export function skillsSidebarPane(main: CdpClient): SkillsSidebarPane {
  const HEADER = `document.querySelector('div[class*="group/header"][data-group="skills"]')`
  const TOGGLE = `[...(${HEADER}?.querySelectorAll(':scope > button') ?? [])].find((b) => b.querySelector('span.truncate'))`
  const COLLAPSE = `${HEADER}?.nextElementSibling`
  // 分组正文 = 组头的下一个兄弟（AnimatedCollapse 的 grid 层）→ overflow 层 → SessionGroup 的内缩层
  const BODY = `${COLLAPSE}?.firstElementChild?.firstElementChild`
  const ALL_ROWS = `[...document.querySelectorAll('[data-skill-row]')]`
  const ALL_FOLDERS = `[...document.querySelectorAll('[data-skill-folder]')]`
  const ROW = (name: string): string =>
    `document.querySelector('[data-skill-row=${JSON.stringify(name)}]')`
  const FOLDER = (dirName: string): string =>
    `document.querySelector('[data-skill-folder=${JSON.stringify(dirName)}]')`

  const ROW_SHOT = `((r) => ({
    name: r.getAttribute('data-skill-row') ?? '',
    label: (r.querySelector('span.truncate')?.textContent ?? '').trim(),
    off: r.hasAttribute('data-skill-off'),
    indented: r.className.includes('pl-6'),
    active: r.className.includes('bg-bg-active')
  }))`
  const FOLDER_SHOT = `((f) => ({
    dirName: f.getAttribute('data-skill-folder') ?? '',
    label: (f.querySelector('span.truncate')?.textContent ?? '').trim(),
    locked: !!f.querySelector('.lucide-lock'),
    off: f.hasAttribute('data-skill-off'),
    open: !!f.querySelector('.lucide-folder-open')
  }))`

  const shotsOf = (list: string): Promise<SkillRowShot[]> =>
    main.eval<SkillRowShot[]>(`${list}.map(${ROW_SHOT})`)

  /** 开某一处的 ⋮（不选任何项 = 取消）并回菜单里的动作 id */
  const menuIds = async (scope: string, what: string): Promise<string[] | null> => {
    await until(() => main.eval<boolean>(`${scope} !== null`), what)
    const items = await openMenu(main, scope, 'menu-button')
    return items ? items.filter((it) => it.id).map((it) => it.id as string) : null
  }

  const DIALOG = `document.querySelector('[data-skill-dir-dialog]')`
  const DIALOG_INPUT = `${DIALOG}?.querySelector('input')`
  const dialogOpen = (): Promise<boolean> => main.eval<boolean>(`${DIALOG} !== null`)
  /** 页脚两颗按钮：倒数第二是取消、最后一颗是「添加」（头上那颗 X 不算） */
  const clickDialogButton = async (fromEnd: number): Promise<void> => {
    await main.eval(`(() => {
      const buttons = [...(${DIALOG}?.querySelectorAll('button') ?? [])]
      buttons[buttons.length - ${fromEnd}]?.click()
      return true
    })()`)
    await sleep(200)
  }

  return {
    label: () =>
      main.eval<string>(`(${HEADER}?.querySelector('span.truncate')?.textContent ?? '').trim()`),

    expand: async () => {
      await until(() => main.eval<boolean>(`${HEADER} !== null`), 'skills group header')
      const open = await main.eval<boolean>(`${COLLAPSE}?.style.gridTemplateRows === '1fr'`)
      if (!open) await main.eval(`(${TOGGLE})?.click()`)
      // 扫描是懒的：展开才发第一次请求。正文有内容才算落定 —— 空态也渲染一个元素，
      // 所以这一条对「一个技能都没有」的实例同样成立
      await until(
        () => main.eval<boolean>(`(${BODY}?.childElementCount ?? 0) > 0`),
        'skills group scanned'
      )
    },

    folders: () => main.eval<SkillFolderShot[]>(`${ALL_FOLDERS}.map(${FOLDER_SHOT})`),

    toggleFolder: async (dirName) => {
      await until(
        () => main.eval<boolean>(`${FOLDER(dirName)} !== null`),
        `skill folder "${dirName}"`
      )
      const before = await main.eval<boolean>(
        `!!${FOLDER(dirName)}?.querySelector('.lucide-folder-open')`
      )
      await main.eval(`${FOLDER(dirName)}.click()`)
      await until(
        async () =>
          (await main.eval<boolean>(
            `!!${FOLDER(dirName)}?.querySelector('.lucide-folder-open')`
          )) !== before,
        `skill folder "${dirName}" toggled`
      )
    },

    rows: () => shotsOf(ALL_ROWS),

    // 目录行的下一个兄弟就是它那层 AnimatedCollapse（折叠时子元素仍在 DOM 里，只是高度 0）
    rowsUnder: (dirName) =>
      shotsOf(
        `[...(${FOLDER(dirName)}?.nextElementSibling?.querySelectorAll('[data-skill-row]') ?? [])]`
      ),

    flatRows: () =>
      shotsOf(`[...(${BODY}?.children ?? [])].filter((el) => el.hasAttribute('data-skill-row'))`),

    openSkill: async (name) => {
      await until(() => main.eval<boolean>(`${ROW(name)} !== null`), `skill row "${name}"`)
      await main.eval(`${ROW(name)}.click()`)
      // 打开笔记是异步的（openNote → 重拉会话列表 → 选中）
      await until(
        () => main.eval<boolean>(`(${ROW(name)}?.className ?? '').includes('bg-bg-active')`),
        `skill row "${name}" active`
      )
    },

    activeRow: () =>
      main.eval<string | null>(
        `${ALL_ROWS}.find((r) => r.className.includes('bg-bg-active'))?.getAttribute('data-skill-row') ?? null`
      ),

    groupMenuIds: () => menuIds(HEADER, 'skills group header'),

    pickGroupMenu: (actionId) => pickFromMenu(main, HEADER, actionId, 'skills group header'),

    folderMenuIds: (dirName) => menuIds(FOLDER(dirName), `skill folder "${dirName}"`),

    pickFolderMenu: async (dirName, actionId) => {
      await until(
        () => main.eval<boolean>(`${FOLDER(dirName)} !== null`),
        `skill folder "${dirName}"`
      )
      await pickFromMenu(main, FOLDER(dirName), actionId, `skill folder "${dirName}"`)
    },

    skillMenuIds: (name) => menuIds(ROW(name), `skill row "${name}"`),

    pickSkillMenu: async (name, actionId) => {
      await until(() => main.eval<boolean>(`${ROW(name)} !== null`), `skill row "${name}"`)
      await pickFromMenu(main, ROW(name), actionId, `skill row "${name}"`)
    },

    refresh: async () => {
      await pickFromMenu(main, HEADER, 'refresh', 'skills group header')
      await sleep(200)
    },

    emptyText: () =>
      main.eval<string>(`(() => {
        const kids = [...(${BODY}?.children ?? [])]
        // 空态与有内容是同一个三元的两支：空态时正文只有那一个提示 div
        if (kids.length !== 1) return ''
        const only = kids[0]
        if (only.hasAttribute('data-skill-row') || only.querySelector('[data-skill-folder]')) return ''
        return (only.textContent ?? '').trim()
      })()`),

    skillDirDialog: () => ({
      waitOpen: async () => {
        await until(dialogOpen, 'skill dir dialog open')
      },
      waitClosed: async () => {
        // 关闭走 120ms 动画后才卸载
        await until(async () => !(await dialogOpen()), 'skill dir dialog closed')
      },
      isOpen: dialogOpen,
      path: () =>
        main.eval<string>(
          `(${DIALOG}?.querySelector('p[class*="font-mono"]')?.textContent ?? '').trim()`
        ),
      name: () => main.eval<string | null>(`${DIALOG_INPUT}?.value ?? null`),
      setName: async (value) => {
        await main.eval(`(() => {
          const el = ${DIALOG_INPUT}
          if (!el) return false
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set
          setter.call(el, ${JSON.stringify(value)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
      },
      submit: () => clickDialogButton(1),
      error: () =>
        main.eval<string>(
          `(${DIALOG}?.querySelector('p[class*="text-red"]')?.textContent ?? '').trim()`
        ),
      cancel: () => clickDialogButton(2)
    })
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

export interface KnowledgePane extends NotebookReadOnlyProbes {
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

    // 只读笔记本的两个读数与注册表笔记共用一份实现（见 notebookReadOnlyProbes）
    ...notebookReadOnlyProbes(main)
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
  /**
   * 「LLM 工具」页左侧子页列的全部标签（DOM 序）—— 等到列表非空才回。
   * 列是这一页的 `w-[220px]` 导航列；调用前先切到这一页（selectTab）。
   */
  toolSubTabLabels(): Promise<string[]>
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
    selectToolSubTab: (label) => clickButton([label], `tool sub-tab ${label}`),
    toolSubTabLabels: () =>
      until(async () => {
        const labels = await settings.eval<string[]>(
          `[...(document.querySelector('div[class*="w-[220px]"]')?.querySelectorAll('button') ?? [])]
            .map((b) => (b.querySelector('.font-medium')?.textContent ?? b.textContent ?? '').trim())`
        )
        return labels.length > 0 ? labels : null
      }, 'LLM tools sub-tab column')
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 设置窗口「MCP」页（McpClientPanel；openSettings('mcp') 后调用）
//
// 锚点：行根 `[data-mcp-server=<name>]`，展开区里宿主附加的设置 `[data-mcp-server-extra=<name>]`
// （桌面：内置 browser 那一行挂着 BrowserDataSettings）。行内按钮按**图标**认（重连
// refresh-cw / 编辑 pencil / 删除 trash-2），启用开关是行尾 `span[title]` 里的 Toggle，开的判据是
// 它的 `bg-accent` 背景（关是 bg-bg-hover）。文案是 i18n 产物，一律不钉。
//
// 列表每 3 秒轮询一次 `mcp.list()`，所以状态类断言一律 `until`。只能同时展开一行。

/** MCP 设置页里一台服务器那一行的快照 */
export interface McpRowShot {
  name: string
  /** 「内置」徽章（琥珀色那枚）在不在 */
  builtinBadge: boolean
  /** 类型徽章上的字（stdio / http / inproc） */
  typeBadge: string
  /** 名字下面那行状态文字（「未启动」/「已连接 · 22 个工具」…，随界面语言变） */
  statusText: string
  hasReconnect: boolean
  hasEdit: boolean
  deleteDisabled: boolean
  /** 删除按钮的 title（内置行是「不能删」的说明） */
  deleteTitle: string
  /** 启用开关是开着的 */
  enabledOn: boolean
  expanded: boolean
}

/** 展开区里宿主附加设置（`data-mcp-server-extra`）的快照；这一行没有附加设置时 `present: false` */
export interface McpExtraShot {
  present: boolean
  /** 附加设置里各分节的标题（h3，DOM 序） */
  sectionTitles: string[]
  /** 第一节里第一颗开关（浏览器：忽略证书错误）的开合；没有开关时为 null */
  firstToggleOn: boolean | null
  /** 三角警告（`lucide-triangle-alert`）在不在 —— 忽略证书错误打开后才出现 */
  warning: boolean
  /** 「已保存站点」一节里的站点（等宽的 host 文字，DOM 序） */
  sites: string[]
  /** 那一节的空态文字（有站点时为空串） */
  sitesEmptyText: string
}

export interface McpSettingsPane {
  /** 全部行（DOM 序 = 显示顺序：内置置顶） */
  rows(): Promise<McpRowShot[]>
  /** 某一行（不在为 null） */
  row(name: string): Promise<McpRowShot | null>
  /** 等某一行上屏 */
  waitRow(name: string): Promise<McpRowShot>
  /** 展开 / 收起某一行（幂等） */
  setExpanded(name: string, expanded: boolean): Promise<void>
  /** 展开区里列出的工具名（去掉 `mcp__<server>__` 前缀的那一截；没展开时为空） */
  expandedToolNames(name: string): Promise<string[]>
  /** 展开区里宿主附加设置的快照 */
  extra(name: string): Promise<McpExtraShot>
  /** 点附加设置第一节的第一颗开关（浏览器：忽略证书错误） */
  clickExtraFirstToggle(name: string): Promise<void>
  /** 点附加设置「已保存站点」一节的刷新（标题行里的最后一颗按钮） */
  refreshSites(name: string): Promise<void>
  /** 点某个站点行的删除，再点随之出现的确认 */
  clearSite(name: string, host: string): Promise<void>
  /** 点某一行的启用开关 */
  clickEnabled(name: string): Promise<void>
}

export function mcpSettingsPane(settings: CdpClient): McpSettingsPane {
  const ROW = (name: string): string =>
    `[...document.querySelectorAll('[data-mcp-server]')]
      .find((el) => el.getAttribute('data-mcp-server') === ${JSON.stringify(name)})`
  const EXTRA = (name: string): string =>
    `[...document.querySelectorAll('[data-mcp-server-extra]')]
      .find((el) => el.getAttribute('data-mcp-server-extra') === ${JSON.stringify(name)})`
  // 附加设置里的第二节 = 已保存站点（BrowserDataSettings 的固定顺序：行为 → 站点）
  const SITES_SECTION = (name: string): string => `(${EXTRA(name)})?.querySelectorAll('section')[1]`
  // 展开区 = 行根里头行之后那块 py-3 的容器（头行自己也是 px-4 py-3，所以跳过第一个子节点；
  // 两者之间可能夹着一条 py-2 的错误行）
  const BODY = (rowExpr: string): string =>
    `[...((${rowExpr})?.children ?? [])].slice(1).find((c) => c.classList.contains('py-3'))`
  const ROW_SHOT = `(el) => {
    const head = el.firstElementChild
    const btns = [...(head?.querySelectorAll('button') ?? [])]
    const byIcon = (cls) => btns.find((b) => b.querySelector('.' + cls))
    const del = byIcon('lucide-trash-2')
    const toggle = head?.querySelector('span[title] > button')
    const badges = [...(head?.querySelectorAll('span.rounded-md') ?? [])]
    return {
      name: el.getAttribute('data-mcp-server') ?? '',
      builtinBadge: badges.some((b) => b.className.includes('text-amber-500')),
      typeBadge: (badges.find((b) => b.className.includes('bg-bg-tertiary'))?.textContent ?? '').trim(),
      statusText: (head?.querySelector('div.min-w-0.flex-1')?.lastElementChild?.textContent ?? '').trim(),
      hasReconnect: !!byIcon('lucide-refresh-cw'),
      hasEdit: !!byIcon('lucide-pencil'),
      deleteDisabled: !!del?.disabled,
      deleteTitle: del?.getAttribute('title') ?? '',
      enabledOn: !!toggle && toggle.className.includes('bg-accent'),
      expanded: !!(${BODY('el')})
    }
  }`
  const rows = (): Promise<McpRowShot[]> =>
    settings.eval<McpRowShot[]>(
      `[...document.querySelectorAll('[data-mcp-server]')].map(${ROW_SHOT})`
    )
  const row = async (name: string): Promise<McpRowShot | null> =>
    (await rows()).find((r) => r.name === name) ?? null
  const clickInRow = async (name: string, expr: string, what: string): Promise<void> => {
    const ok = await settings.eval<boolean>(`(() => {
      const el = ${ROW(name)}
      const target = el ? (${expr}) : null
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!ok) throw new Error(`mcp settings: ${what} of "${name}" not found`)
    await sleep(200)
  }
  return {
    rows,
    row,
    waitRow: (name) => until(() => row(name), `mcp settings row "${name}"`),
    setExpanded: async (name, expanded) => {
      const now = await until(() => row(name), `mcp settings row "${name}"`)
      if (now.expanded === expanded) return
      // 行首那颗 chevron 按钮开合展开区
      await clickInRow(name, `el.firstElementChild?.querySelector('button')`, 'expand chevron')
      await until(
        async () => (await row(name))?.expanded === expanded,
        `mcp row "${name}" ${expanded ? 'expanded' : 'collapsed'}`
      )
    },
    expandedToolNames: (name) =>
      settings.eval<string[]>(
        `[...((${BODY(ROW(name))})?.querySelectorAll('span.text-purple-300') ?? [])]
          .map((s) => (s.textContent ?? '').trim())`
      ),
    extra: (name) =>
      settings.eval<McpExtraShot>(`(() => {
        const extra = ${EXTRA(name)}
        if (!extra) {
          return { present: false, sectionTitles: [], firstToggleOn: null, warning: false, sites: [], sitesEmptyText: '' }
        }
        const sections = [...extra.querySelectorAll('section')]
        const toggle = sections[0]?.querySelector('button.rounded-full')
        const sites = sections[1]
        return {
          present: true,
          sectionTitles: sections.map((s) => (s.querySelector('h3')?.textContent ?? '').trim()),
          firstToggleOn: toggle ? toggle.className.includes('bg-accent') : null,
          warning: !!extra.querySelector('.lucide-triangle-alert'),
          sites: [...(sites?.querySelectorAll('span.font-mono') ?? [])].map((s) => (s.textContent ?? '').trim()),
          sitesEmptyText: (sites?.querySelector('div.text-center')?.textContent ?? '').trim()
        }
      })()`),
    clickExtraFirstToggle: async (name) => {
      const ok = await settings.eval<boolean>(`(() => {
        const t = (${EXTRA(name)})?.querySelector('section button.rounded-full')
        if (!t) return false
        t.click()
        return true
      })()`)
      if (!ok) throw new Error(`mcp settings: extra toggle of "${name}" not found`)
      await sleep(200)
    },
    refreshSites: async (name) => {
      const ok = await settings.eval<boolean>(`(() => {
        const head = (${SITES_SECTION(name)})?.firstElementChild
        const btns = [...(head?.querySelectorAll('button') ?? [])]
        const refresh = btns[btns.length - 1]
        if (!refresh) return false
        refresh.click()
        return true
      })()`)
      if (!ok) throw new Error(`mcp settings: saved-sites refresh of "${name}" not found`)
      await sleep(300)
    },
    clearSite: async (name, host) => {
      // 站点行 = 含这个 host 的等宽文字的那一行（SettingsRow 根：px-4 py-3 的 flex 行）
      const SITE_ROW = `[...((${SITES_SECTION(name)})?.querySelectorAll('span.font-mono') ?? [])]
        .find((s) => (s.textContent ?? '').trim() === ${JSON.stringify(host)})
        ?.closest('div.px-4')`
      const clickIn = async (expr: string, what: string): Promise<void> => {
        await until(
          () =>
            settings.eval<boolean>(`(() => {
              const row = ${SITE_ROW}
              const btn = row ? (${expr}) : null
              if (!btn) return false
              btn.click()
              return true
            })()`),
          `saved site "${host}": ${what}`
        )
        await sleep(200)
      }
      await clickIn(
        `[...row.querySelectorAll('button')].find((b) => b.querySelector('.lucide-trash-2'))`,
        'delete'
      )
      // 删除点下去之后原地换成「确认 / 取消」两颗文字按钮，确认在前（等垃圾桶那颗真的换下去）
      await clickIn(
        `[...row.querySelectorAll('button')].some((b) => b.querySelector('.lucide-trash-2'))
          ? null
          : row.querySelectorAll('button')[0]`,
        'confirm'
      )
    },
    clickEnabled: (name) =>
      clickInRow(
        name,
        `el.firstElementChild?.querySelector('span[title] > button')`,
        'enable toggle'
      )
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MCP 页内置 `database` 那一行展开区里的「已保存的连接」（DatabaseConnectionsSettings）与它的
// 添加 / 编辑弹窗（DbCredentialDialog）。先 `mcpSettingsPane(...).setExpanded('database', true)`。
//
// **不要拿 `mcpSettingsPane.extra()` 读它**：那个快照按浏览器面板的两节结构写死（第二节 = 已保存
// 站点），它的 `warning` 找的是 `lucide-triangle-alert`，而这一块的安全警告是**一直在**的。
//
// 锚点：块根 = `[data-mcp-server-extra="database"]`；节 = 其中唯一的 `section`（标题 h3、问号、
// 右上角「添加」、preamble 里的三角警告、圆角卡片）；卡片里每个直接子节点是一行 SettingsRow
// （标题行 = 名字 `span.truncate` + 徽章 `span.rounded-md`，库类型徽章蓝、只读徽章绿；subtitle 里
// 等宽的 `user@host:port/db`；行尾是 pencil / trash-2 两颗图标，点了删除垃圾桶原地换成「确认 /
// 取消」两颗文字按钮，确认在前，编辑图标留着）。空态是卡片里 `div.text-center` 的两段 `p`。
//
// 弹窗 = 块里的 `.dialog-panel`（固定定位的遮罩就渲染在这一块里）：头部 h3；表单里恰好六个
// `input`，DOM 序 = 名称、主机、端口、用户名、密码、库名；库类型是 MySQL / PostgreSQL 两段的
// SegmentedControl（选中那段带 `shadow-sm`）；只读开关是弹窗里唯一的 `button.rounded-full`；
// 表单区直接子节点里的 `p` 是「测试连接」的结果行与保存失败的报错行；页脚三颗按钮 = 测试、取消、
// 保存。文案是 i18n 产物 —— 需要比对文字的地方由调用方按三语候选认。

/** 已保存的连接里的一行 */
export interface DbConnRowShot {
  name: string
  /** 库类型徽章上的字（`PostgreSQL` / `MySQL`） */
  engine: string
  /** 只读徽章上的字；没有这枚徽章时为 '' */
  readonlyBadge: string
  /** 这一行自己的内容（subtitle）：`user@host:port/db` */
  target: string
  /** 行尾此刻是「确认 / 取消」（点过删除）而不是两颗图标 */
  confirming: boolean
}

/** 「已保存的连接」这一块的快照；块不在屏时 `present: false` */
export interface DbConnectionsShot {
  present: boolean
  /** 节标题（h3） */
  title: string
  /** 节标题旁的问号个数（说明收在气泡里） */
  hints: number
  /** preamble 里的安全警告（三角图标旁那句）；不在为 '' */
  warning: string
  /** 空态的两段文字；有连接时为 [] */
  empty: string[]
  rows: DbConnRowShot[]
}

/** 添加 / 编辑连接弹窗的快照 */
export interface DbDialogShot {
  open: boolean
  /** 头部标题（添加 / 编辑，随界面语言变） */
  title: string
  fields: {
    name: string
    host: string
    port: string
    username: string
    password: string
    database: string
  }
  /** 库类型分段控件选中那段的字 */
  engine: string
  /** 只读开关开着 */
  readonlyOn: boolean
  /** 表单区里的提示行（测试结果 / 保存报错），`ok` = 绿色那一种 */
  messages: Array<{ text: string; ok: boolean }>
  /** 保存按钮禁用 */
  saveDisabled: boolean
}

export type DbDialogField = keyof DbDialogShot['fields']

export interface DbConnectionsPane {
  shot(): Promise<DbConnectionsShot>
  /** 等列表读出来（有行或有空态 —— 连接列表是挂载之后异步读的） */
  loaded(): Promise<DbConnectionsShot>
  clickAdd(): Promise<void>
  clickEdit(name: string): Promise<void>
  /** 点某一行的删除（垃圾桶），等行尾换成确认 / 取消 */
  clickDelete(name: string): Promise<void>
  /** 删除之后的确认 / 取消 */
  answerDelete(name: string, confirm: boolean): Promise<void>
  dialog(): Promise<DbDialogShot>
  /** 往弹窗的输入框里填字（native setter + input 事件，走 React 的 onChange） */
  fill(values: Partial<DbDialogShot['fields']>): Promise<void>
  pickEngine(label: 'MySQL' | 'PostgreSQL'): Promise<void>
  clickReadonly(): Promise<void>
  clickTest(): Promise<void>
  clickSave(): Promise<void>
  clickCancel(): Promise<void>
  /** 等弹窗离开 DOM（关闭有一段收起动画） */
  waitDialogClosed(): Promise<void>
}

export function dbConnectionsPane(settings: CdpClient): DbConnectionsPane {
  const ROOT = `document.querySelector('[data-mcp-server-extra="database"]')`
  const SECTION = `(${ROOT})?.querySelector('section')`
  const CARD = `(${SECTION})?.lastElementChild`
  const PANEL = `(${ROOT})?.querySelector('.dialog-panel')`
  /** 名字恰好等于 name 的那一行（SettingsRow 根） */
  const ROW = (name: string): string =>
    `[...((${CARD})?.children ?? [])].find((r) =>
      (r.querySelector('span.truncate')?.textContent ?? '').trim() === ${JSON.stringify(name)})`
  const FIELD_ORDER: DbDialogField[] = ['name', 'host', 'port', 'username', 'password', 'database']

  const shot = (): Promise<DbConnectionsShot> =>
    settings.eval<DbConnectionsShot>(`(() => {
      const section = ${SECTION}
      if (!section) return { present: false, title: '', hints: 0, warning: '', empty: [], rows: [] }
      const card = section.lastElementChild
      const emptyBox = card?.querySelector(':scope > div.text-center')
      const warnIcon = section.querySelector('.lucide-triangle-alert')
      const rows = emptyBox ? [] : [...(card?.children ?? [])].map((r) => {
        const badges = [...r.querySelectorAll('span.rounded-md')]
        const control = r.lastElementChild
        return {
          name: (r.querySelector('span.truncate')?.textContent ?? '').trim(),
          engine: (badges.find((b) => b.className.includes('bg-blue-500'))?.textContent ?? '').trim(),
          readonlyBadge: (badges.find((b) => b.className.includes('bg-green-500'))?.textContent ?? '').trim(),
          target: (r.querySelector('span.font-mono')?.textContent ?? '').trim(),
          // 编辑那颗图标一直在；点过删除之后，垃圾桶原地换成两颗文字按钮
          confirming: !!control && !control.querySelector('.lucide-trash-2')
        }
      })
      return {
        present: true,
        title: (section.querySelector('h3')?.textContent ?? '').trim(),
        hints: section.firstElementChild?.querySelectorAll('[data-info-hint]').length ?? 0,
        warning: (warnIcon?.parentElement?.querySelector('p')?.textContent ?? '').trim(),
        empty: emptyBox ? [...emptyBox.querySelectorAll('p')].map((p) => (p.textContent ?? '').trim()) : [],
        rows
      }
    })()`)

  /** 在块里找到 expr 指向的按钮并点它；找不到就抛 */
  const click = async (expr: string, what: string): Promise<void> => {
    await until(
      () =>
        settings.eval<boolean>(`(() => {
          const b = ${expr}
          if (!b) return false
          b.click()
          return true
        })()`),
      `database connections: ${what}`
    )
    await sleep(200)
  }

  return {
    shot,
    loaded: () =>
      until(async () => {
        const s = await shot()
        return s.present && (s.rows.length > 0 || s.empty.length > 0) ? s : null
      }, 'saved database connections loaded'),
    clickAdd: () =>
      click(
        `(${SECTION})?.firstElementChild?.querySelector(':scope > div.shrink-0 button')`,
        'add'
      ),
    clickEdit: (name) =>
      click(
        `[...((${ROW(name)})?.querySelectorAll('button') ?? [])].find((b) => b.querySelector('.lucide-pencil'))`,
        `edit ${name}`
      ),
    clickDelete: async (name) => {
      await click(
        `[...((${ROW(name)})?.querySelectorAll('button') ?? [])].find((b) => b.querySelector('.lucide-trash-2'))`,
        `delete ${name}`
      )
      await until(
        async () => (await shot()).rows.find((r) => r.name === name)?.confirming === true,
        `delete of ${name} awaiting confirmation`
      )
    },
    answerDelete: (name, confirm) =>
      click(
        `(() => {
          const row = ${ROW(name)}
          // 行尾：编辑图标 + 「确认 / 取消」两颗文字按钮（没有图标的那两颗）
          const btns = row ? [...row.lastElementChild.querySelectorAll('button')].filter((b) => !b.querySelector('svg')) : []
          return btns.length === 2 ? btns[${confirm ? 0 : 1}] : null
        })()`,
        `${confirm ? 'confirm' : 'cancel'} delete of ${name}`
      ),
    dialog: () =>
      settings.eval<DbDialogShot>(`(() => {
        const panel = ${PANEL}
        const empty = { name: '', host: '', port: '', username: '', password: '', database: '' }
        if (!panel) {
          return { open: false, title: '', fields: empty, engine: '', readonlyOn: false, messages: [], saveDisabled: true }
        }
        const inputs = [...panel.querySelectorAll('input')]
        const order = ${JSON.stringify(FIELD_ORDER)}
        const fields = Object.fromEntries(order.map((k, i) => [k, inputs[i] ? inputs[i].value : '']))
        const seg = [...panel.querySelectorAll('button')].find((b) =>
          ['MySQL', 'PostgreSQL'].includes((b.textContent ?? '').trim()) && b.className.includes('shadow-sm'))
        const toggle = panel.querySelector('button.rounded-full')
        const form = panel.children[1]
        const footer = panel.lastElementChild
        const footBtns = [...(footer?.querySelectorAll('button') ?? [])]
        return {
          open: true,
          title: (panel.querySelector('h3')?.textContent ?? '').trim(),
          fields,
          engine: (seg?.textContent ?? '').trim(),
          readonlyOn: !!toggle && toggle.className.includes('bg-accent'),
          messages: [...(form?.children ?? [])]
            .filter((c) => c.tagName === 'P')
            .map((p) => ({ text: (p.textContent ?? '').trim(), ok: p.className.includes('text-green-400') })),
          saveDisabled: !!footBtns[footBtns.length - 1]?.disabled
        }
      })()`),
    fill: async (values) => {
      const pairs = FIELD_ORDER.flatMap((k, i) =>
        values[k] === undefined ? [] : [[i, values[k] as string] as const]
      )
      const ok = await settings.eval<boolean>(`(() => {
        const panel = ${PANEL}
        if (!panel) return false
        const inputs = [...panel.querySelectorAll('input')]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        for (const [i, v] of ${JSON.stringify(pairs)}) {
          const input = inputs[i]
          if (!input) return false
          setter.call(input, v)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        return true
      })()`)
      if (!ok) throw new Error('database connection dialog: inputs not found')
      await sleep(100)
    },
    pickEngine: (label) =>
      click(
        `[...((${PANEL})?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(label)})`,
        `engine ${label}`
      ),
    clickReadonly: () =>
      click(`(${PANEL})?.querySelector('button.rounded-full')`, 'read-only toggle'),
    clickTest: () => click(`(${PANEL})?.lastElementChild?.querySelectorAll('button')[0]`, 'test'),
    clickCancel: () =>
      click(
        `(() => {
          const btns = [...((${PANEL})?.lastElementChild?.querySelectorAll('button') ?? [])]
          return btns.length === 3 ? btns[1] : null
        })()`,
        'cancel'
      ),
    clickSave: () =>
      click(
        `(() => {
          const btns = [...((${PANEL})?.lastElementChild?.querySelectorAll('button') ?? [])]
          const save = btns[btns.length - 1]
          return save && !save.disabled ? save : null
        })()`,
        'save'
      ),
    waitDialogClosed: async () => {
      await until(() => settings.eval<boolean>(`!(${PANEL})`), 'database connection dialog closed')
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 设置窗口「已归档」页（openSettings('archived') 后调用）
//
// 「项目」一级入口改名「已归档」（Archive 图标）后，页内由「左侧 220px 子导航列 + 唯一子项」
// 改为「顶部 PanelTabBar 横向标签条（唯一子 tab『项目』）+ 内容区」。这里钉的是那次整改的
// 结构契约：左栏只剩「已归档」一个入口（不再有第二个「项目」）、页内只有一条横向标签条、
// 归档列表 / 空态 / 行按钮挂在内容区里。
// 作用域坑：旧一级入口与页内子 tab 同叫「项目」，一切断言必须限定作用域 —— 一级导航的
// 断言走 nav*（限 180px 左栏），页内断言限内容区（左栏的下一个兄弟），裸查 document
// 必然误命中另一头。

/** 左栏一级导航按钮的快照 */
export interface ArchivedNavButtonShot {
  text: string
  /** 活动态（TabButton 的 active 分支：bg-accent/10 text-accent） */
  active: boolean
  /** Archive 图标（svg.lucide-archive） */
  archiveIcon: boolean
}

/** 内容区顶部 PanelTabBar 的快照 */
export interface ArchivedTabBarShot {
  /** 标签条容器类名（横向 flex / h-8 / border-b 的结构断言用） */
  className: string
  tabs: Array<{
    text: string
    /** FolderClosed 图标（svg.lucide-folder-closed） */
    folderIcon: boolean
    /** 选中 tab 内的下划线 span（absolute bottom-0 bg-accent） */
    underline: boolean
  }>
}

/** 归档项目列表里的一行 */
export interface ArchivedRowShot {
  name: string
  /** 行尾按钮的 title（DOM 序：恢复 / 删除） */
  buttonTitles: string[]
  /** 行尾按钮容器的类名（opacity-0 group-hover:opacity-100 的结构断言用） */
  actionsClass: string
}

export interface ArchivedSettingsPane {
  /** 左栏一级导航内文本 ∈ labels 的按钮；没有返回 null */
  navButton(labels: string[]): Promise<ArchivedNavButtonShot | null>
  /** 左栏一级导航内是否存在文本 ∈ labels 的按钮 */
  navHasButton(labels: string[]): Promise<boolean>
  /** 内容区顶部的 PanelTabBar；没有返回 null */
  tabBar(): Promise<ArchivedTabBarShot | null>
  /** 内容区里竖向子导航列的条数（w-[220px] / border-r 列；整改后应为 0） */
  verticalSubNavs(): Promise<number>
  /** 归档项目行（DOM 序） */
  rows(): Promise<ArchivedRowShot[]>
  /** 等到指定名字的行全部出现 */
  waitRows(names: string[]): Promise<void>
  /** 等到指定名字的行消失（调用前该行须已在屏，否则秒过） */
  waitRowGone(name: string): Promise<void>
  /** 点指定行上 title ∈ titles 的按钮；行或按钮找不到即抛 */
  clickRowButton(name: string, titles: string[]): Promise<void>
  /** 空态文案；列表非空（空态未渲染）时为 null */
  emptyText(): Promise<string | null>
  /** 等到空态文案出现并返回它 */
  waitEmpty(): Promise<string>
}

/** 「已归档」设置页（ArchivedSettings；openSettings('archived') 后调用） */
export function archivedSettingsPane(settings: CdpClient): ArchivedSettingsPane {
  // 一级导航列 = SettingsContainer 的 180px 列；内容区 = 它的下一个兄弟
  const NAV = `document.querySelector('div[class*="w-[180px]"]')`
  const CONTENT = `((${NAV})?.nextElementSibling ?? null)`
  const NAV_BTN = (labels: string[]): string =>
    `[...((${NAV})?.querySelectorAll('button') ?? [])].find((b) =>
      ${JSON.stringify(labels)}.includes((b.textContent ?? '').trim()))`
  // 内容区顶部的 PanelTabBar：h-8 + border-b 的横向条。设置窗头部是 pb-4 不是 h-8，
  // PanelTabBar 自己的隐形测量节点是 absolute 定位的 span 列表 —— 两者都不会误命中
  const TAB_BAR = `((${CONTENT})?.querySelector('div.h-8.border-b') ?? null)`
  // 归档项目行 = 内容区里的 div.group.relative（行尾按钮靠 group-hover 浮现）
  const ROWS = `[...((${CONTENT})?.querySelectorAll('div.group.relative') ?? [])]`
  const ROW = (name: string): string =>
    `${ROWS}.find((r) =>
      (r.querySelector('span.truncate')?.textContent ?? '').trim() === ${JSON.stringify(name)})`

  const rows = (): Promise<ArchivedRowShot[]> =>
    settings.eval<ArchivedRowShot[]>(`${ROWS}.map((r) => ({
      name: (r.querySelector('span.truncate')?.textContent ?? '').trim(),
      buttonTitles: [...r.querySelectorAll('button')].map((b) => b.getAttribute('title') ?? ''),
      actionsClass: r.querySelector('button')?.parentElement?.className ?? ''
    }))`)

  const emptyText = (): Promise<string | null> =>
    settings.eval<string | null>(`(() => {
      const el = (${CONTENT})?.querySelector('div.text-center')
      return el ? (el.textContent ?? '').trim() : null
    })()`)

  return {
    navButton: (labels) =>
      settings.eval<ArchivedNavButtonShot | null>(`(() => {
        const b = ${NAV_BTN(labels)}
        if (!b) return null
        return {
          text: (b.textContent ?? '').trim(),
          active: b.className.includes('bg-accent/10') && b.className.includes('text-accent'),
          archiveIcon: !!b.querySelector('svg.lucide-archive')
        }
      })()`),
    navHasButton: (labels) => settings.eval<boolean>(`!!(${NAV_BTN(labels)})`),
    tabBar: () =>
      settings.eval<ArchivedTabBarShot | null>(`(() => {
        const bar = ${TAB_BAR}
        if (!bar) return null
        return {
          className: bar.className,
          tabs: [...bar.querySelectorAll('button')].map((b) => ({
            text: (b.textContent ?? '').trim(),
            folderIcon: !!b.querySelector('svg.lucide-folder-closed'),
            underline: !!b.querySelector('span.absolute.bottom-0.bg-accent')
          }))
        }
      })()`),
    verticalSubNavs: () =>
      settings.eval<number>(`[...((${CONTENT})?.querySelectorAll('*') ?? [])].filter((el) => {
        const cls = typeof el.className === 'string' ? el.className : ''
        return cls.split(/\\s+/).includes('border-r') || cls.includes('w-[220px]')
      }).length`),
    rows,
    waitRows: async (names) => {
      await until(
        async () => {
          const have = (await rows()).map((r) => r.name)
          return names.every((n) => have.includes(n)) || null
        },
        `archived rows ${names.join(', ')}`
      )
    },
    waitRowGone: async (name) => {
      await until(
        async () => !(await rows()).some((r) => r.name === name) || null,
        `archived row "${name}" gone`
      )
    },
    clickRowButton: async (name, titles) => {
      const clicked = await settings.eval<boolean>(`(() => {
        const row = ${ROW(name)}
        const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) =>
          ${JSON.stringify(titles)}.includes(b.getAttribute('title') ?? ''))
        if (!btn) return false
        btn.click()
        return true
      })()`)
      if (!clicked) {
        throw new Error(`archived row "${name}" button (${titles.join(' / ')}) not found`)
      }
      await sleep(200)
    },
    emptyText,
    waitEmpty: () => until(async () => (await emptyText()) || null, 'archived empty state')
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗右侧面板（RightPanel）与它的「智能体」监视 tab（AgentMonitorPanel）。
//
// 锚点（全部按结构 / 图标认，空态与徽章文案是 i18n 产物，一律不钉）：
//   - 面板开关 = 顶栏 `button[data-side="right"]`（PanelToggleButton）；面板关上时
//     RightPanel 整体不在 DOM 里，agents tab 按钮的存在性即「面板开着」的判据；
//   - agents tab = 标签栏里含 `.lucide-activity` 的按钮（主窗里 PanelTabBar 只有 RightPanel
//     这一处）；标签栏 = 它的父 div（PanelTabBar 的按钮是直接子节点；屏外测量节点是 span，
//     不会混进来）；
//   - agents 面板 = RightPanel 根（标签栏的父级）里内容区（`:scope > div.relative`）的
//     **最后一个**子节点（RightPanel 按 preview/widget/calendar/agents 固定序铺开，
//     全部常驻挂载、visibility 切换）—— 行 / 空态 / 详情都 scope 在它之内；
//   - 行 = 列表区 `.divide-y > div > button.w-full`（详情里的工具行也有 w-full，但不在
//     这一层父子关系上）；相位灯 = 行内 `span.rounded-full`；孤儿徽章 =
//     `span[class*="bg-error/10"]`；血缘箭头 = `.lucide-corner-down-right`；
//     详情容器 = 行按钮父 div 的第二子节点（childElementCount > 1 即展开）。
//
// DOM 序恒等于 `monitorList()` 的数组序（面板就是 agents.map 出来的）—— spec 按 IPC
// 快照里的下标定位行，不靠文案认行。

/** 监视列表一行的快照 */
export interface AgentMonitorRowShot {
  /** 整行文本（标题 + 模型 id + 相对时间…），只用于「标题在不在」这类包含断言 */
  text: string
  /** 相位灯的 className（相位色与 animate-pulse 都在这串里） */
  phaseClass: string
  /** 相位灯在闪（animate-pulse）= 非 idle 相位 */
  pulsing: boolean
  /** 孤儿徽章在屏（根会话已删） */
  orphan: boolean
  /** 孤儿徽章文案（非空即可，不钉具体词） */
  orphanText: string
  /** 血缘箭头在屏（spawned 行） */
  arrow: boolean
}

export interface RightPanelPane {
  /** 打开右侧面板并等 agents tab 上屏（幂等：已开则不动） */
  open(): Promise<void>
  /** 关闭右侧面板（幂等：已关则不动） */
  close(): Promise<void>
  /** 面板是否开着（agents tab 按钮在 DOM 里 = RightPanel 已挂载） */
  isOpen(): Promise<boolean>
  /** 点 agents tab 并等面板内容区变为可见（轮询随之开闸，首 tick 异步） */
  activateAgentsTab(): Promise<void>
  /** agents tab 是否激活（activateAgentsTab 的 visibility 判据暴露成读数） */
  agentsActive(): Promise<boolean>
  /** 切到 widget tab 并等 agents 内容区不可见 —— 「面板开着但在别的 tab」的构造 */
  activateWidgetTab(): Promise<void>
  /** 标签栏可见 tab 的 lucide 图标类（DOM 序）—— tab 集合与顺序的判据，不认文案 */
  tabIcons(): Promise<string[]>
  /**
   * 当前激活 tab 的 lucide 图标类（PanelTabBar 的选中下划线所在那颗按钮）；面板关着时为空串。
   * widget tab 是 `lucide-wrench`（浏览器已搬进独立窗口，面板里没有它）。
   */
  activeTabIcon(): Promise<string>
  /** 监视列表的行快照（DOM 序 = monitorList 序） */
  rows(): Promise<AgentMonitorRowShot[]>
  /** 空态文案块文本；空态未上屏（含 loading 期）回空串 */
  emptyText(): Promise<string>
  /**
   * 工具栏里的会话筛选 chip；无筛选回 null。`label` 是**去掉 i18n 前缀后**的筛选标签
   * （会话标题，或条目消失后的 id 截断回落）—— 前缀与标签是两个相邻文本节点。
   */
  filterChip(): Promise<{ label: string } | null>
  /** 点筛选 chip 的 X 清除筛选并等 chip 消失（幂等：无筛选则不动） */
  clearFilter(): Promise<void>
  /** 点第 i 行（手风琴：展开 / 收起 / 换一条都由它驱动） */
  clickRow(index: number): Promise<void>
  /** 第 i 行是否展开（行按钮的父 div 长出了第二子节点 = 详情容器） */
  detailOpen(index: number): Promise<boolean>
  /** 第 a 行与第 b 行在 DOM 上相邻（a 的行容器紧贴 b 的之前） */
  rowsAdjacent(a: number, b: number): Promise<boolean>
}

/** 主窗右侧面板（侧栏开关在顶栏；agents tab 与监视列表都在这里） */
export function rightPanelPane(main: CdpClient): RightPanelPane {
  const TOGGLE = `document.querySelector('button[data-side="right"]')`
  const AGENTS_TAB = `[...document.querySelectorAll('button')].find((b) => b.querySelector('.lucide-activity'))`
  // RightPanel 根 = 标签栏（agents tab 的父 div）的父级
  const PANEL = `${AGENTS_TAB}?.parentElement?.parentElement`
  // agents 面板 = 内容区固定序的最后一个（见本节开头的锚点说明）
  const AGENTS = `${PANEL}?.querySelector(':scope > div.relative')?.lastElementChild`
  const ROWS = `[...(${AGENTS}?.querySelectorAll('.divide-y > div > button.w-full') ?? [])]`

  const tabPresent = (): Promise<boolean> => main.eval<boolean>(`${AGENTS_TAB} !== undefined`)
  const agentsActive = (): Promise<boolean> =>
    main.eval<boolean>(
      `(() => { const p = ${AGENTS}; return !!p && getComputedStyle(p).visibility === 'visible' })()`
    )

  return {
    open: async () => {
      if (await tabPresent()) return
      await main.eval(`${TOGGLE}?.click()`)
      await until(tabPresent, 'right panel open (agents tab mounted)')
    },
    close: async () => {
      if (!(await tabPresent())) return
      await main.eval(`${TOGGLE}?.click()`)
      await until(async () => !(await tabPresent()) || null, 'right panel closed')
    },
    isOpen: tabPresent,
    activateAgentsTab: async () => {
      await until(tabPresent, 'agents tab mounted')
      await main.eval(`${AGENTS_TAB}.click()`)
      await until(agentsActive, 'agents tab visible')
    },
    agentsActive,
    activateWidgetTab: async () => {
      // 与 tabIcons 同一根标签栏，按图标点名 widget tab（它常驻可见，不像 preview 要有目标才出现）
      const WIDGET_TAB = `[...(${AGENTS_TAB}?.parentElement?.children ?? [])]
        .find((b) => b.querySelector('.lucide-wrench'))`
      await until(() => main.eval<boolean>(`!!${WIDGET_TAB}`), 'widget tab mounted')
      await main.eval(`${WIDGET_TAB}.click()`)
      await until(async () => !(await agentsActive()) || null, 'widget tab active')
    },
    tabIcons: () =>
      main.eval<string[]>(`[...(${AGENTS_TAB}?.parentElement?.children ?? [])]
        .filter((el) => el.tagName === 'BUTTON')
        .map((b) => [...(b.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-')) ?? '')`),
    // 选中态 = 按钮里那条 absolute bottom-0 的下划线（PanelTabBar 的 active 分支）
    activeTabIcon: () =>
      main.eval<string>(`(() => {
        const active = [...(${AGENTS_TAB}?.parentElement?.children ?? [])]
          .find((b) => b.tagName === 'BUTTON' && b.querySelector('span.absolute.bottom-0'))
        return [...(active?.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-')) ?? ''
      })()`),
    rows: () =>
      main.eval<AgentMonitorRowShot[]>(`${ROWS}.map((row) => {
        const dot = row.querySelector('span.rounded-full')
        const badge = row.querySelector('span[class*="bg-error/10"]')
        return {
          text: (row.textContent ?? '').trim(),
          phaseClass: dot?.className ?? '',
          pulsing: (dot?.className ?? '').includes('animate-pulse'),
          orphan: !!badge,
          orphanText: (badge?.textContent ?? '').trim(),
          arrow: !!row.querySelector('.lucide-corner-down-right')
        }
      })`),
    emptyText: () =>
      main.eval<string>(
        `(${AGENTS}?.querySelector('.text-center.py-10')?.textContent ?? '').trim()`
      ),
    filterChip: () =>
      main.eval<{ label: string } | null>(`(() => {
        // 筛选 chip = agents 面板内唯一「内含带 lucide-x 按钮」的 span.rounded-full
        // （相位灯也是 span.rounded-full，但它是纯圆点、不含按钮）
        const chip = [...(${AGENTS}?.querySelectorAll('span.rounded-full') ?? [])]
          .find((s) => s.querySelector('button .lucide-x'))
        if (!chip) return null
        // 内层截断 span 里 i18n 前缀与筛选标签是两个相邻文本节点（React 19 不再插
        // 注释节点）—— label 取最后一个文本节点，恰好不含前缀
        const inner = chip.querySelector('span.truncate')
        const texts = [...(inner?.childNodes ?? [])].filter((n) => n.nodeType === 3)
        return { label: (texts[texts.length - 1]?.textContent ?? '').trim() }
      })()`),
    clearFilter: async () => {
      const CHIP = `[...(${AGENTS}?.querySelectorAll('span.rounded-full') ?? [])]
        .find((s) => s.querySelector('button .lucide-x'))`
      const present = (): Promise<boolean> => main.eval<boolean>(`!!${CHIP}`)
      if (!(await present())) return
      await main.eval(`${CHIP}.querySelector('button')?.click()`)
      await until(async () => !(await present()) || null, 'session filter cleared')
    },
    clickRow: async (index) => {
      await main.eval(`${ROWS}[${index}]?.click()`)
      await sleep(300)
    },
    detailOpen: (index) =>
      main.eval<boolean>(`(${ROWS}[${index}]?.parentElement?.childElementCount ?? 0) > 1`),
    rowsAdjacent: (a, b) =>
      main.eval<boolean>(`(() => {
        const rows = ${ROWS}
        return !!rows[${a}] && !!rows[${b}] &&
          rows[${a}].parentElement?.nextElementSibling === rows[${b}].parentElement
      })()`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 主窗对话区顶部的运行时状态横幅（StatusBanner）与最前面的 agent profile 标记
// （AgentProfileChip）。
//
// 锚点（按结构认，与右侧面板同一套纪律）：
//   - 横幅 = `div[class*="bg-bg-secondary/60"][class*="border-b"]`（属性子串写法避开类名
//     里的 `/`）；无标记且无运行时连接时整条返回 null —— 「banner 元素缺席」本身就是
//     判据，不接受「banner 在但空」；
//   - 标记 = 横幅里唯一的 button 胶囊：`button.rounded-full` 且内含 `span.font-mono`
//     （profileName 的等宽标签是排他特征；SSH/DB 连接胶囊是 span，不会混进来）；
//   - 相位灯 = 标记内的 `span.rounded-full`（与 AgentMonitorPanel 的 PHASE_DOT 同一套
//     语义：idle 灰、其余绿脉冲）。

/** agent profile 标记的快照 */
export interface StatusBannerChipShot {
  present: boolean
  /** profileName 标签文本（如 chat / work） */
  text: string
  /** 相位灯的 className（相位色与 animate-pulse 都在这串里） */
  phaseClass: string
  /** 相位灯在闪（animate-pulse）= 非 idle 相位 */
  pulsing: boolean
}

export interface StatusBannerPane {
  /** 横幅整条在屏（无内容时组件返回 null，这里即 false） */
  bannerPresent(): Promise<boolean>
  /** profile 标记快照；不在屏回 null */
  chip(): Promise<StatusBannerChipShot | null>
  /** 点标记（= 打开右栏 agents tab 并按本会话筛选） */
  clickChip(): Promise<void>
}

/** 主窗状态横幅（对话区顶部、顶栏之下） */
export function statusBannerPane(main: CdpClient): StatusBannerPane {
  const BANNER = `document.querySelector('div[class*="bg-bg-secondary/60"][class*="border-b"]')`
  const CHIP = `[...document.querySelectorAll('button.rounded-full')]
    .find((b) => b.querySelector('span.font-mono'))`
  return {
    bannerPresent: () => main.eval<boolean>(`${BANNER} !== null`),
    chip: () =>
      main.eval<StatusBannerChipShot | null>(`(() => {
        const chip = ${CHIP}
        if (!chip) return null
        const dot = chip.querySelector('span.rounded-full')
        return {
          present: true,
          text: (chip.querySelector('span.font-mono')?.textContent ?? '').trim(),
          phaseClass: dot?.className ?? '',
          pulsing: (dot?.className ?? '').includes('animate-pulse')
        }
      })()`),
    clickChip: async () => {
      await main.eval(`${CHIP}?.click()`)
      await sleep(300)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 设置窗口「监视器」页（MonitorSettings）—— 运行时观测迁去 RightPanel 之后，这里只剩
// 「LLM 请求」一个子页；旧的 `monitor/agents` hash 自然回落到它。
//
// 锚点：子标签条 = `[data-monitor-toolbar]` 最近的 HttpLogSettings 根（.flex.flex-col.h-full
// .min-h-0）的祖父（MonitorSettings 根）的第一个子节点（PanelTabBar，按钮是直接子节点）；
// 激活态认按钮里的选中下划线 `span.bg-accent`。顶层 tab 导航沿用 `.w-[180px]` 那列
// （settingsTabsPane 同一锚点），「智能体」tab 已拆除的判据是导航里不再出现它的图标
// （lucide-bot）—— 文案是 i18n 产物，不认。

export interface MonitorSettingsPane {
  /** 监视器子标签条的 tab 按钮数（应恒为 1：只剩 LLM 请求） */
  subTabCount(): Promise<number>
  /** 子标签条的唯一 tab 呈激活态（选中下划线在） */
  subTabActive(): Promise<boolean>
  /** 顶层 tab 导航的图标类（DOM 序）—— 「没有智能体 tab」按没有 lucide-bot 断 */
  navIcons(): Promise<string[]>
  /** 设置窗口当前 hash（`#settings/<tab>[/<sub>]`） */
  hash(): Promise<string>
}

/** 设置窗口监视器页（`openSettings('monitor/...')` 之后调用；自带 [data-monitor-toolbar] 就绪等待） */
export async function monitorSettingsPane(settings: CdpClient): Promise<MonitorSettingsPane> {
  const TOOLBAR = `document.querySelector('[data-monitor-toolbar]')`
  const SUB_BAR = `${TOOLBAR}?.closest('.flex.flex-col.h-full.min-h-0')?.parentElement?.parentElement?.firstElementChild`
  // 与 settingsTabsPane 同一根导航列；attribute 子串写法免得给 `[` 转义
  const NAV = `document.querySelector('div[class*="w-[180px]"]')`
  await until(() => settings.eval<boolean>(`${TOOLBAR} !== null`), 'monitor settings ready')
  return {
    subTabCount: () =>
      settings.eval<number>(`${SUB_BAR}?.querySelectorAll(':scope > button').length ?? 0`),
    subTabActive: () =>
      settings.eval<boolean>(`!!${SUB_BAR}?.querySelector(':scope > button > span.bg-accent')`),
    navIcons: () =>
      settings.eval<string[]>(`[...(${NAV}?.querySelectorAll(':scope > button') ?? [])]
        .map((b) => [...(b.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-')) ?? '')`),
    hash: () => settings.eval<string>('location.hash')
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 浏览器独立窗口（#browser-window）：BrowserWindowShell → BrowserWall 卡片墙；以及主窗侧栏
// 底部打开它的那颗按钮。
//
// 锚点（全是产品代码专门留的 data 属性，不认文案 / 类名）：
//   - 窗口根 = `[data-browser-window]`；
//   - 墙格 = `[data-wall-cell="<tabId>"]`，滚动容器 = 墙格的父节点（BrowserWall 的 grid，
//     墙空时它不在 DOM 里）；
//   - 卡片 = `[data-browser-card="<tabId>"]`，激活的那张带 `data-active="true"`；
//   - 页面区 = 卡片里的 `[data-page-area]`（主进程把 WebContentsView 叠在它的矩形上）；
//   - 主窗开窗按钮 = `[data-open-browser-window]`。
// tab id 是 UUID（十六进制与连字符），直接进属性选择器无需转义。
//
// 窗口「开没开」不从这里读：e2e 带着 `--disable-renderer-backgrounding` /
// `--disable-backgrounding-occluded-windows` 启动，`document.visibilityState` 不反映窗口是否隐藏
// —— 用 IPC `window.api.browserView.isWindowOpen()`。

/** 一个元素的视口矩形（CSS px） */
export interface WallRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface BrowserWallPane {
  /** 窗口根 `[data-browser-window]` 已挂载 */
  mounted(): Promise<boolean>
  /** 墙上卡片的 tab id（DOM 序 = tab 顺序） */
  cardIds(): Promise<string[]>
  /** 带 `data-active="true"` 的卡片的 tab id（正常恰好一个；墙空时为空） */
  activeCardIds(): Promise<string[]>
  /** 某张卡片的矩形；不在 DOM 里回 null */
  cardRect(tabId: string): Promise<WallRect | null>
  /** 某张卡片所在墙格的矩形；不在 DOM 里回 null */
  cellRect(tabId: string): Promise<WallRect | null>
  /** 某张卡片页面区（WebContentsView 叠上去的那块）的矩形；卡片不挂页面时回 null */
  pageAreaRect(tabId: string): Promise<WallRect | null>
  /** 墙的滚动容器的矩形；墙空时回 null */
  wallRect(): Promise<WallRect | null>
  /** 滚动容器的 scrollTop（墙空时 0） */
  scrollTop(): Promise<number>
  /** 把墙滚回顶上并等它停在 0 */
  scrollToTop(): Promise<void>
}

/** 浏览器窗口的卡片墙（`app.browserWindow()` 连上的那个页面） */
export function browserWallPane(bw: CdpClient): BrowserWallPane {
  const SCROLLER = `document.querySelector('[data-wall-cell]')?.parentElement`
  const rectOf = (expr: string): Promise<WallRect | null> =>
    bw.eval<WallRect | null>(`(() => {
      const el = ${expr}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    })()`)
  const scrollTop = (): Promise<number> => bw.eval<number>(`${SCROLLER}?.scrollTop ?? 0`)
  return {
    mounted: () => bw.eval<boolean>(`!!document.querySelector('[data-browser-window]')`),
    cardIds: () =>
      bw.eval<string[]>(
        `[...document.querySelectorAll('[data-browser-card]')].map((el) => el.dataset.browserCard)`
      ),
    activeCardIds: () =>
      bw.eval<string[]>(
        `[...document.querySelectorAll('[data-browser-card][data-active="true"]')].map((el) => el.dataset.browserCard)`
      ),
    cardRect: (tabId) => rectOf(`document.querySelector('[data-browser-card="${tabId}"]')`),
    cellRect: (tabId) => rectOf(`document.querySelector('[data-wall-cell="${tabId}"]')`),
    pageAreaRect: (tabId) =>
      rectOf(`document.querySelector('[data-browser-card="${tabId}"] [data-page-area]')`),
    wallRect: () => rectOf(SCROLLER),
    scrollTop,
    scrollToTop: async () => {
      await bw.eval(`(() => { const s = ${SCROLLER}; if (s) s.scrollTop = 0 })()`)
      await until(async () => (await scrollTop()) === 0, 'browser wall scrolled to top')
    }
  }
}

export interface OpenBrowserWindowButton {
  /** 按钮在主窗侧栏里 */
  present(): Promise<boolean>
  /** 点它（等它挂载后再点） */
  click(): Promise<void>
  /**
   * 按钮上的 tab 计数徽标（`[data-browser-tab-count]` 的值）；没有徽标（0 个 tab）时回 null。
   * 这是用户知道「agent 开了页面」的唯一地方 —— agent 开 tab 不会把浏览器窗口弄出来。
   */
  count(): Promise<number | null>
  /** 按钮的 title（带计数时写着 tab 数）；按钮不在时回空串 */
  title(): Promise<string>
}

/** 主窗侧栏底部「打开浏览器窗口」按钮 */
export function openBrowserWindowButton(main: CdpClient): OpenBrowserWindowButton {
  const BTN = `document.querySelector('[data-open-browser-window]')`
  const present = (): Promise<boolean> => main.eval<boolean>(`!!${BTN}`)
  return {
    present,
    click: async () => {
      await until(present, 'open-browser-window button mounted')
      await main.eval(`${BTN}.click()`)
    },
    count: () =>
      main.eval<number | null>(`(() => {
        const badge = ${BTN}?.querySelector('[data-browser-tab-count]')
        return badge ? Number(badge.getAttribute('data-browser-tab-count')) : null
      })()`),
    title: () => main.eval<string>(`${BTN}?.getAttribute('title') ?? ''`)
  }
}
