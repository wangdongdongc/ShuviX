/**
 * 薄 page-object 层 —— DOM 断言集中在此，选择器坏了只修一处。
 * 约定：断言优先走 IPC（window.api.*）；只有「确实在验证 UI 呈现」时才用这里。
 */
import type { CdpClient } from './cdp'
import { until } from './cdp'

export interface AgentsPaneRow {
  displayName: string
  struck: boolean
  overriddenBadge: boolean
}

export interface AgentsPane {
  rows(): Promise<AgentsPaneRow[]>
  selectRow(displayName: string): Promise<void>
  /** 详情面板：字段标签 / 注入开关数 / 是否有删除按钮 */
  detail(): Promise<{ labels: string[]; injectionToggles: number; hasDeleteButton: boolean }>
}

export interface HttpLogPane {
  /** 记录开关当前是否打开（读 Toggle 的 on 态背景类） */
  recordOn(): Promise<boolean>
  /** 点击记录开关 */
  toggleRecord(): Promise<void>
  /** 列表区的空态文案（用于区分「暂无日志」与「记录已关闭」） */
  emptyText(): Promise<string>
}

/** 设置窗口「LLM 日志」tab（openSettings('httpLogs') 后调用） */
export async function httpLogPane(settings: CdpClient): Promise<HttpLogPane> {
  // 左栏首个区块即记录开关行（其后是筛选器 / 列表 / 底栏）
  const SWITCH = `document.querySelector('.w-\\\\[260px\\\\] button.rounded-full')`
  await until(() => settings.eval<boolean>(`${SWITCH} !== null`), 'http log tab ready')

  return {
    recordOn: () => settings.eval<boolean>(`${SWITCH}.className.includes('bg-accent')`),
    toggleRecord: async () => {
      await settings.eval(`${SWITCH}.click()`)
      await new Promise((r) => setTimeout(r, 300))
    },
    // 列表首帧是 loadingLog 文案，轮询到列表落定为止（until 把空串视为未就绪）
    emptyText: () =>
      until(async () => {
        const text = await settings.eval<string>(
          `(document.querySelector('.w-\\\\[260px\\\\] .overflow-y-auto')?.textContent ?? '').trim()`
        )
        return /加载|Loading|読み込み/i.test(text) ? '' : text
      }, 'http log list settled')
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
        const pane = [...document.querySelectorAll('.flex-1.min-w-0')].find((p) => p.querySelector('.cm-content'))
        // 编辑器与提供商详情同构:SettingsSection 卡片(section h3 = 分组标题,
        // 行/块标题带 text-text-primary);注入开关 = 基本信息卡里的 Toggle(rounded-full 按钮)
        return {
          labels: [...pane.querySelectorAll('section h3, section [class*=text-text-primary]')].map(
            (e) => e.textContent.trim()
          ),
          injectionToggles: pane.querySelector('section')?.querySelectorAll('button.rounded-full').length ?? 0,
          hasDeleteButton: [...pane.querySelectorAll('button')].some((b) => b.querySelector('.lucide-trash-2'))
        }
      })()`)
  }
}
