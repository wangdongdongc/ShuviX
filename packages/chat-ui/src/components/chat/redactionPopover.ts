/**
 * 自动脱敏占位符的揭示浮层（docs/auto-redaction-design.md §2.3）：界面默认显示模型收到的样子（占位符），指到、聚焦或
 * 点一下占位符才在旁边浮出真值 —— 工具执行、文件里用的那个。纯 DOM：聊天里的 RedactedMark（React）与 CodeMirror 字段
 * 里的小部件共用这一份，样子一致。
 *
 * 同一时间只有一个浮层。离开占位符后稍等一下再收起，指针移进浮层就不收（可以选中真值、点复制）；点一下占位符把它
 * 钉住，点别处收起（触屏上没有悬停，靠点）。颜色全取主题变量，挂在 body 上用 fixed 定位，不被滚动容器裁掉。
 */

export interface RedactionReveal {
  /** 类别的人读名（「API key」） */
  label: string
  /** 真值；还没查到 / 这台电脑解不开时没有 */
  value?: string
  /** 浮层里的说明一句（随界面语言） */
  note: string
  /** 复制按钮的字（「复制」/「已复制」） */
  copyLabel: string
  copiedLabel: string
}

let current: { anchor: HTMLElement; el: HTMLDivElement; pinned: boolean } | null = null
let hideTimer: ReturnType<typeof setTimeout> | undefined
let outsideListener: ((event: PointerEvent) => void) | undefined

function clearHideTimer(): void {
  if (hideTimer !== undefined) clearTimeout(hideTimer)
  hideTimer = undefined
}

function build(reveal: RedactionReveal): HTMLDivElement {
  const el = document.createElement('div')
  el.dataset.redactionPopover = ''
  el.setAttribute('role', 'tooltip')
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '1000',
    maxWidth: 'min(420px, calc(100vw - 24px))',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid var(--color-border-primary, rgba(127,127,127,0.3))',
    background: 'var(--color-bg-primary, #fff)',
    color: 'var(--color-text-primary, #222)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
    fontSize: '12px',
    lineHeight: '1.5',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
  } satisfies Partial<CSSStyleDeclaration>)

  const head = document.createElement('div')
  head.textContent = reveal.label
  Object.assign(head.style, { fontWeight: '600', color: 'var(--color-warning, #b7791f)' })
  el.appendChild(head)

  const note = document.createElement('div')
  note.textContent = reveal.note
  note.style.color = 'var(--color-text-secondary, #555)'
  el.appendChild(note)

  if (reveal.value !== undefined) {
    const row = document.createElement('div')
    Object.assign(row.style, { display: 'flex', alignItems: 'flex-start', gap: '8px' })
    const value = document.createElement('code')
    value.dataset.redactionValue = ''
    value.textContent = reveal.value
    Object.assign(value.style, {
      flex: '1',
      minWidth: '0',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      userSelect: 'text',
      padding: '2px 6px',
      borderRadius: '4px',
      background: 'var(--color-bg-tertiary, rgba(127,127,127,0.12))'
    } satisfies Partial<CSSStyleDeclaration>)
    row.appendChild(value)
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = reveal.copyLabel
    Object.assign(copy.style, {
      flexShrink: '0',
      fontSize: '11px',
      padding: '2px 6px',
      borderRadius: '4px',
      border: '1px solid var(--color-border-primary, rgba(127,127,127,0.3))',
      background: 'transparent',
      color: 'var(--color-text-secondary, #555)',
      cursor: 'pointer'
    } satisfies Partial<CSSStyleDeclaration>)
    copy.addEventListener('click', (event) => {
      event.stopPropagation()
      void navigator.clipboard
        ?.writeText(reveal.value!)
        .then(() => {
          copy.textContent = reveal.copiedLabel
        })
        .catch(() => {
          // 剪贴板不让写：选中真值，用户自己复制
          const range = document.createRange()
          range.selectNodeContents(value)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        })
    })
    row.appendChild(copy)
    el.appendChild(row)
  }

  el.addEventListener('pointerenter', clearHideTimer)
  el.addEventListener('pointerleave', () => {
    if (!current?.pinned) scheduleHideRedaction()
  })
  return el
}

function place(anchor: HTMLElement, el: HTMLDivElement): void {
  const rect = anchor.getBoundingClientRect()
  const margin = 6
  const width = el.offsetWidth
  const height = el.offsetHeight
  let left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
  if (!Number.isFinite(left)) left = 8
  const below = rect.bottom + margin
  const top =
    below + height > window.innerHeight - 8 ? Math.max(8, rect.top - margin - height) : below
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

/** 在占位符旁浮出真值；pinned = 点出来的，离开也不收 */
export function showRedaction(anchor: HTMLElement, reveal: RedactionReveal, pinned = false): void {
  clearHideTimer()
  if (current && current.anchor === anchor) {
    current.pinned = current.pinned || pinned
    return
  }
  hideRedaction()
  const el = build(reveal)
  document.body.appendChild(el)
  place(anchor, el)
  current = { anchor, el, pinned }
  outsideListener = (event) => {
    const target = event.target as Node | null
    if (current && target && !current.el.contains(target) && !current.anchor.contains(target)) {
      hideRedaction()
    }
  }
  document.addEventListener('pointerdown', outsideListener, true)
}

/** 浮出期间内容变了（真值查到了）：就地换掉，钉住与否不变 */
export function updateRedaction(anchor: HTMLElement, reveal: RedactionReveal): void {
  if (!current || current.anchor !== anchor) return
  const el = build(reveal)
  current.el.replaceWith(el)
  current.el = el
  place(anchor, el)
}

/** 点一下：没浮出就钉住浮出，钉住的再点就收起 */
export function toggleRedaction(anchor: HTMLElement, reveal: RedactionReveal): void {
  if (current && current.anchor === anchor && current.pinned) hideRedaction()
  else showRedaction(anchor, reveal, true)
}

/** 离开占位符：稍等再收（指针可能正移向浮层）；钉住的不收 */
export function scheduleHideRedaction(anchor?: HTMLElement): void {
  if (!current || current.pinned) return
  if (anchor && current.anchor !== anchor) return
  clearHideTimer()
  hideTimer = setTimeout(hideRedaction, 180)
}

export function hideRedaction(): void {
  clearHideTimer()
  if (outsideListener) document.removeEventListener('pointerdown', outsideListener, true)
  outsideListener = undefined
  current?.el.remove()
  current = null
}

/** 占位符被卸载（滚走、重渲染）时，它的浮层一起收掉 */
export function releaseRedactionAnchor(anchor: HTMLElement): void {
  if (current?.anchor === anchor) hideRedaction()
}
