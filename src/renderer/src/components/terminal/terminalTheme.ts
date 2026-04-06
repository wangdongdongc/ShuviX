import type { ITheme } from '@xterm/xterm'

/** 从 CSS 变量生成 xterm ITheme */
export function resolveTerminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string): string => s.getPropertyValue(name).trim()

  const bgSecondary = v('--theme-bg-secondary') || '#161b22'
  const textPrimary = v('--theme-text-primary') || '#e6edf3'
  const textSecondary = v('--theme-text-secondary') || '#8b949e'
  const textTertiary = v('--theme-text-tertiary') || '#6e7681'
  const borderPrimary = v('--theme-border-primary') || '#30363d'
  const accent = v('--theme-accent') || '#58a6ff'

  const shared = {
    background: bgSecondary,
    foreground: textPrimary,
    cursor: textSecondary,
    cursorAccent: bgSecondary,
    scrollbarSliderBackground: borderPrimary + '80',
    scrollbarSliderHoverBackground: textTertiary + 'aa',
    scrollbarSliderActiveBackground: textTertiary
  }

  if (isLightColor(bgSecondary)) {
    return {
      ...shared,
      selectionBackground: accent + '30',
      selectionForeground: textPrimary,
      black: '#24292e',
      red: '#d73a49',
      green: '#22863a',
      yellow: '#b08800',
      blue: '#0366d6',
      magenta: '#6f42c1',
      cyan: '#1b7c83',
      white: '#6a737d',
      brightBlack: '#959da5',
      brightRed: '#cb2431',
      brightGreen: '#28a745',
      brightYellow: '#dbab09',
      brightBlue: '#2188ff',
      brightMagenta: '#8a63d2',
      brightCyan: '#3192aa',
      brightWhite: '#24292e'
    }
  }

  return {
    ...shared,
    selectionBackground: accent + '40',
    selectionForeground: textPrimary,
    black: bgSecondary,
    red: '#f97583',
    green: '#85e89d',
    yellow: '#ffea7f',
    blue: '#79b8ff',
    magenta: '#b392f0',
    cyan: '#73e3ff',
    white: textPrimary,
    brightBlack: textSecondary,
    brightRed: '#fdaeb7',
    brightGreen: '#bef5cb',
    brightYellow: '#fff5b1',
    brightBlue: '#c8e1ff',
    brightMagenta: '#d2b3ff',
    brightCyan: '#a9f1ff',
    brightWhite: '#fafbfc'
  }
}

function isLightColor(hex: string): boolean {
  const c = hex.replace('#', '')
  if (c.length < 6) return false
  const r = parseInt(c.substring(0, 2), 16)
  const g = parseInt(c.substring(2, 4), 16)
  const b = parseInt(c.substring(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128
}
