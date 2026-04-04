/**
 * 内置供应商图标
 * 每个图标 14x14，与列表行高匹配
 */

const S = 14

function OpenAIIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  )
}

function AnthropicIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.478-3.906H5.744L4.27 20.48H.598l5.97-16.96zm1.04 4.36L5.2 13.907h4.852L7.609 7.88z" />
    </svg>
  )
}

function GoogleIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

function XAIIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="m1.002 5.891 7.99 11.503L1 22.109h1.604l6.682-7.244L14.49 22.109H23L14.573 10.09 21.97 3.89h-1.604l-6.088 6.6L9.512 3.891H1.002zm2.752 1.604h2.636l13.86 13.01h-2.636L3.754 7.495z" />
    </svg>
  )
}

function GroqIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 2.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zm0 2.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
    </svg>
  )
}

function CerebrasIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function MistralIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <rect x="1" y="3" width="5" height="5" />
      <rect x="18" y="3" width="5" height="5" />
      <rect x="1" y="10" width="5" height="5" />
      <rect x="7" y="10" width="5" height="5" />
      <rect x="18" y="10" width="5" height="5" />
      <rect x="1" y="17" width="5" height="5" />
      <rect x="7" y="17" width="5" height="5" />
      <rect x="12" y="17" width="5" height="5" />
      <rect x="18" y="17" width="5" height="5" />
      <rect x="12" y="3" width="5" height="5" opacity="0.55" />
      <rect x="7" y="3" width="5" height="5" opacity="0.55" />
      <rect x="12" y="10" width="5" height="5" opacity="0.55" />
    </svg>
  )
}

function OpenRouterIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18L19.82 8 12 11.82 4.18 8 12 4.18zM4 9.18l7 3.5V19.5l-7-3.5V9.18zm16 0v6.82l-7 3.5v-6.82l7-3.5z" />
    </svg>
  )
}

function MiniMaxIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M2 6h3v12H2V6zm5.5 0H11v12H7.5V6zm5.5 0h3.5v12H13V6zm5.5 0H22v12h-3.5V6z" />
    </svg>
  )
}

function HuggingFaceIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zM8.5 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM7.5 15.5c0-1 1.5-3 4.5-3s4.5 2 4.5 3-.5 1-1.5 1h-6c-1 0-1.5-.2-1.5-1z" />
    </svg>
  )
}

function KimiIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-1-4-4-1 4-1 1-4 1 4 4 1-4 1-1 4z" />
    </svg>
  )
}

function ZAIIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5h16v2.5H9.5L20 17.5V19H4v-2.5h10.5L4 6.5V5z" />
    </svg>
  )
}

function OpenCodeIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

/** 自定义供应商 — AI 星芒图标 */
function DefaultProviderIcon(): React.JSX.Element {
  return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="currentColor">
      <path d="M9 2l1.5 5.5L16 9l-5.5 1.5L9 16l-1.5-5.5L2 9l5.5-1.5L9 2z" />
      <path d="M18 12l1 3.5L22.5 17l-3.5 1L18 21.5 17 18l-3.5-1L17 16l1-4z" opacity={0.6} />
    </svg>
  )
}

const PROVIDER_ICONS: Record<string, () => React.JSX.Element> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  google: GoogleIcon,
  xai: XAIIcon,
  groq: GroqIcon,
  cerebras: CerebrasIcon,
  mistral: MistralIcon,
  openrouter: OpenRouterIcon,
  minimax: MiniMaxIcon,
  'minimax-cn': MiniMaxIcon,
  huggingface: HuggingFaceIcon,
  'kimi-coding': KimiIcon,
  zai: ZAIIcon,
  opencode: OpenCodeIcon
}

export function ProviderIcon({ name }: { name: string }): React.JSX.Element {
  const Icon = PROVIDER_ICONS[name] || DefaultProviderIcon
  return (
    <span className="shrink-0 text-text-tertiary">
      <Icon />
    </span>
  )
}
