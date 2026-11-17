/**
 * 手机布局的项目设置 —— 从项目那一组的菜单整屏推入（2026-11-16，取代桌面那个居中的「项目配置」对话框：在手机上
 * 它又窄又长）。
 *
 * 首页是分组卡片：名称（就地改，失焦或回车存）与文件夹（只显示路径 —— 手机浏览器选不了那台电脑上的目录）；项目
 * 提示词（推入一页，行尾写着填没填）；「新会话的默认值」下面是扩展能力与知识库（各推入一页，行尾是勾了几项）；
 * 归档项目。没有「保存 / 取消」：改了就存（提示词停笔 600ms 或离开那一页时存）。环境变量不在这里，仍在桌面改。
 *
 * 哪一页由 MobileShell 管（它连着浏览器历史）；这里只画、只存。知识库没动过就不写（让项目继续跟着缺省走，
 * 与桌面对话框同一条）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { isImeComposing } from '@shuvix/chat-ui'
import { ConfirmDialog, ExtensionsSection } from '@shuvix/app-shell'
import type { ToolItem } from '../components/common/ToolSelectList'
import { MobilePage, pageCard, pageRow, pageRowBase, pageSectionLabel } from './MobilePage'
import type { MobileProjectPage } from './panelPure'

/** 提示词停笔这么久就存一次 */
const PROMPT_SAVE_MS = 600

export interface MobileProjectSettingsProps {
  projectId: string
  page: MobileProjectPage
  /** 首页的返回键上写的字（那一组的名字，或「会话」） */
  backLabel: string
  onOpenPage: (page: Exclude<MobileProjectPage, 'index'>) => void
  /** 返回上一层（子页 → 首页 → 来的地方） */
  onBack: () => void
  /** 项目归档了 / 已经不在了：整个收起，回到会话页顶层 */
  onClosed: () => void
}

interface Loaded {
  name: string
  path: string
  systemPrompt: string
  enabledTools: string[]
  knowledgeBases: string[]
}

export function MobileProjectSettings({
  projectId,
  page,
  backLabel,
  onOpenPage,
  onBack,
  onClosed
}: MobileProjectSettingsProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [data, setData] = useState<Loaded | null>(null)
  const [mcpTools, setMcpTools] = useState<ToolItem[]>([])
  const [kbOptions, setKbOptions] = useState<{ name: string; label: string }[]>([])
  const [nameDraft, setNameDraft] = useState('')
  const [archiving, setArchiving] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([
      window.api.project.getById(projectId),
      // 这两样取不到只是少两行，项目本身照样能改名、改提示词、归档
      window.api.tools.list().catch(() => []),
      window.api.knowledge.baseOptions().catch(() => ({
        options: [] as { name: string; label: string }[],
        selected: [] as string[]
      }))
    ])
      .then(([project, tools, kb]) => {
        if (!alive) return
        if (!project) {
          onClosed()
          return
        }
        const settings = project.settings || {}
        setMcpTools((tools as ToolItem[]).filter((tool) => tool.group?.startsWith('mcp:')))
        setKbOptions(kb.options)
        setData({
          name: project.name,
          path: project.path,
          systemPrompt: project.systemPrompt ?? '',
          // 没保存过扩展能力 = 一个都不勾（与桌面对话框同一条）
          enabledTools: Array.isArray(settings.enabledTools) ? settings.enabledTools : [],
          knowledgeBases: Array.isArray(settings.knowledgeBases)
            ? settings.knowledgeBases
            : kb.selected
        })
        setNameDraft(project.name)
      })
      .catch(() => {
        // 连接断了：这一页留着空白，返回键照常能退
      })
    return () => {
      alive = false
    }
  }, [projectId, onClosed])

  const save = useCallback(
    (patch: Parameters<typeof window.api.project.update>[0]): Promise<boolean> =>
      window.api.project.update(patch).then(
        () => true,
        // 没存上（连接断了）：不抛，交回 false
        () => false
      ),
    []
  )

  const saveName = (): void => {
    if (!data) return
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === data.name) {
      setNameDraft(data.name)
      return
    }
    setData({ ...data, name: trimmed })
    setNameDraft(trimmed)
    void save({ id: projectId, name: trimmed })
  }

  // 名称那一格还聚焦着就走了（返回手势）：没有失焦事件，卸载时把改过的名字存掉
  const nameState = useRef({ draft: '', saved: '' })
  useEffect(() => {
    nameState.current = { draft: nameDraft.trim(), saved: data?.name ?? '' }
  }, [nameDraft, data?.name])
  useEffect(
    () => () => {
      const { draft, saved } = nameState.current
      if (saved && draft && draft !== saved) void save({ id: projectId, name: draft })
    },
    [projectId, save]
  )

  // 提示词：停笔就存；离开那一页（卸载）时把还没存的那一份存掉
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPrompt = useRef<string | null>(null)
  const flushPrompt = useCallback((): void => {
    if (promptTimer.current) clearTimeout(promptTimer.current)
    promptTimer.current = null
    if (pendingPrompt.current === null) return
    const text = pendingPrompt.current
    pendingPrompt.current = null
    void save({ id: projectId, systemPrompt: text })
  }, [projectId, save])
  const changePrompt = (text: string): void => {
    if (!data) return
    setData({ ...data, systemPrompt: text })
    pendingPrompt.current = text
    if (promptTimer.current) clearTimeout(promptTimer.current)
    promptTimer.current = setTimeout(flushPrompt, PROMPT_SAVE_MS)
  }
  useEffect(() => flushPrompt, [flushPrompt])
  // 从提示词那一页退出来：当场存
  const lastPage = useRef(page)
  useEffect(() => {
    if (lastPage.current === 'prompt' && page !== 'prompt') flushPrompt()
    lastPage.current = page
  }, [page, flushPrompt])

  const archive = (): void => {
    setArchiving(false)
    // 归档成了才收起；没成（连接断了）留在这一页
    void save({ id: projectId, archived: true }).then((ok) => {
      if (ok) onClosed()
    })
  }

  const pageLabel: Record<Exclude<MobileProjectPage, 'index'>, string> = {
    prompt: t('projectForm.systemPrompt'),
    extensions: t('sessionConfig.extensionsGroup'),
    knowledge: t('sessionConfig.knowledgeGroup')
  }

  if (page !== 'index') {
    return (
      <MobilePage
        kind={`project-${page}`}
        backLabel={t('projectForm.editTitle')}
        onBack={onBack}
        title={pageLabel[page]}
      >
        {data &&
          (page === 'prompt' ? (
            <>
              <textarea
                data-mobile-project-prompt=""
                value={data.systemPrompt}
                onChange={(e) => changePrompt(e.target.value)}
                onBlur={flushPrompt}
                placeholder={t('projectForm.systemPromptPlaceholder')}
                rows={12}
                className="block w-full resize-none rounded-xl bg-bg-secondary px-4 py-3 text-[16px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary"
              />
              <p className="px-4 pt-2 text-[13px] text-text-tertiary">
                {t('mobile.projectPromptHint')}
              </p>
            </>
          ) : (
            <div data-mobile-project-section={page} data-mobile-scale="">
              <ExtensionsSection
                title={pageLabel[page]}
                footer={page === 'extensions' ? t('projectForm.extensionsDesc') : undefined}
                only={page === 'extensions' ? 'mcp' : 'knowledge'}
                mcpTools={mcpTools}
                enabledTools={data.enabledTools}
                onChange={(next) => {
                  setData({ ...data, enabledTools: next })
                  void save({ id: projectId, enabledTools: next })
                }}
                knowledge={{
                  options: kbOptions,
                  selected: data.knowledgeBases,
                  onToggle: (name) => {
                    const next = data.knowledgeBases.includes(name)
                      ? data.knowledgeBases.filter((n) => n !== name)
                      : [...data.knowledgeBases, name]
                    setData({ ...data, knowledgeBases: next })
                    void save({ id: projectId, knowledgeBases: next })
                  },
                  hint: t('projectForm.knowledgeBasesDesc')
                }}
              />
            </div>
          ))}
      </MobilePage>
    )
  }

  const navRow = (
    target: Exclude<MobileProjectPage, 'index'>,
    value: string
  ): React.JSX.Element => (
    <button
      type="button"
      data-mobile-project-row={target}
      onClick={() => onOpenPage(target)}
      className={`${pageRow} active:bg-bg-hover`}
    >
      <span className="min-w-0 flex-1 truncate">{pageLabel[target]}</span>
      {value && (
        <span data-mobile-project-value="" className="text-[15px] tabular-nums text-text-tertiary">
          {value}
        </span>
      )}
      <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
    </button>
  )

  // 行尾的数：只数还在的（被删掉的服务器 / 库留在选择里，但那一页上没有它；`-mcp:` 是「不要」的记号，不算）
  const mcpCount = data
    ? mcpTools.filter((tool) => data.enabledTools.includes(tool.name)).length
    : 0
  const kbCount = data
    ? data.knowledgeBases.filter((name) => kbOptions.some((o) => o.name === name)).length
    : 0

  return (
    <MobilePage
      kind="project-index"
      backLabel={backLabel}
      onBack={onBack}
      title={t('projectForm.editTitle')}
      bodyClassName="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1"
    >
      {data && (
        <>
          <div className={pageCard}>
            <label className={pageRow}>
              <span className="shrink-0 text-text-secondary">{t('mobile.detailName')}</span>
              <input
                data-mobile-project-name=""
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                enterKeyHint="done"
                className="min-w-0 flex-1 bg-transparent text-right text-text-primary outline-none"
              />
            </label>
            <div className={`${pageRow} py-2`}>
              <span className="shrink-0 text-text-secondary">{t('mobile.projectFolder')}</span>
              <span
                data-mobile-project-path=""
                className="min-w-0 flex-1 break-all text-right text-[14px] text-text-tertiary"
              >
                {data.path}
              </span>
            </div>
          </div>

          <div className={pageCard}>
            {navRow(
              'prompt',
              data.systemPrompt.trim()
                ? t('mobile.projectPromptSet')
                : t('mobile.projectPromptUnset')
            )}
          </div>

          {(mcpTools.length > 0 || kbOptions.length > 0) && (
            <section>
              <div className={pageSectionLabel}>{t('mobile.projectDefaults')}</div>
              <div className={pageCard}>
                {mcpTools.length > 0 && navRow('extensions', mcpCount > 0 ? String(mcpCount) : '')}
                {kbOptions.length > 0 && navRow('knowledge', kbCount > 0 ? String(kbCount) : '')}
              </div>
            </section>
          )}

          <div className={pageCard}>
            <button
              type="button"
              data-mobile-project-archive=""
              onClick={() => setArchiving(true)}
              className={`${pageRowBase} text-error active:bg-bg-hover`}
            >
              {t('projectForm.archiveProject')}
            </button>
          </div>
        </>
      )}
      {archiving && (
        <ConfirmDialog
          title={t('projectForm.archiveConfirmTitle')}
          description={t('projectForm.archiveConfirmDesc')}
          confirmText={t('projectForm.archiveConfirmAction')}
          onConfirm={archive}
          onCancel={() => setArchiving(false)}
        />
      )}
    </MobilePage>
  )
}
