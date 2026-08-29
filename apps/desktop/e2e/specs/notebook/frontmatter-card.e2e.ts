/**
 * shuvix 契约 md 的 frontmatter 属性卡（app-shell notebook/frontmatterCard.ts）：
 * 笔记本会话打开带 `shuvix: agent v1` 标记的 md → frontmatter 渲染为属性卡
 * （类型徽章 / 描述符字段行 / 工具 chips / 布尔开关 / 未知键通用行）；
 * 卡上开关做行级写回（经笔记本自动保存落盘）；无标记的普通 frontmatter 不受影响。
 *
 * 断言走 DOM（卡片是纯渲染层产物，IPC 看不见）——选择器只用本扩展自有的
 * `.cm-shuvix-fmcard*` 类名，不依赖布局结构。
 *
 * 校验态（解析器级校验经 ChatApi `shuvixMd.validate` 回传）：状态徽章只认
 * is-ok / is-warn / is-err 类名（chip 文案是 i18n 产物，不断言）；横幅行是解析器
 * 英文原文，可断言稳定片段（"unknown rule key" / "rejected" / "object.type"）；
 * 无校验器的类型（wiki-*）卡片照常渲染但不显示任何校验态。agent 与 policy 的解析器
 * 都带 warn 通道，非法时横幅逐条给出拒绝原因。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { listTargets, isMainPage, sleep, until } from '../../harness/cdp'
import { createProject } from '../../harness/seed'
import { fmCardPane, type FmCardPane } from '../../harness/pages'

let app: E2EApp
let card: FmCardPane
let projDir: string
let cardMdPath: string

const CARD_MD = [
  '---',
  'shuvix: agent v1',
  'name: card-demo-agent',
  'description: e2e frontmatter card',
  'shuvix-tools: bash, read, write',
  'shuvix-instruction-files: AGENTS.md, CLAUDE.md',
  'shuvix-builtin: true',
  '---',
  '',
  '# Demo body',
  ''
].join('\n')

const PLAIN_MD = ['---', 'title: 普通笔记', '---', '', '# Plain body', ''].join('\n')

// 非法 policy：规则带未知键 note → 规则级细因 + 文件级 reject 两条横幅行
const BAD_POLICY_MD = [
  '---',
  'shuvix: policy v1',
  'name: bad-pol',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    subject.kind: [agent]',
  '    note: x',
  '---',
  '',
  'Bad policy body.',
  ''
].join('\n')

// 合法但带软告警：match 读客体属性却无 object.type 条件
const WARN_POLICY_MD = [
  '---',
  'shuvix: policy v1',
  'name: warn-pol',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    subject.kind: [agent]',
  `    match: "object.path != ''"`,
  '---',
  '',
  'Warn policy body.',
  ''
].join('\n')

// 无校验器的契约类型（unknown）：卡片渲染但不显示校验态
const WIKI_MD = [
  '---',
  'shuvix: wiki-entry v1',
  'name: wiki-demo',
  '---',
  '',
  'Wiki entry body.',
  ''
].join('\n')

// 非法 agent：shuvix-tools 为列表（仅接受逗号分隔字符串）；YAML 本身合法，字段行照常渲染
const BAD_AGENT_MD = [
  '---',
  'shuvix: agent v1',
  'name: bad-card-agent',
  'shuvix-tools: [read]',
  '---',
  '',
  'Bad agent body.',
  ''
].join('\n')

/** 经侧栏会话列表点击含指定文本的条目（深层文本节点上点击，冒泡触发行 onClick） */
async function clickSessionByText(text: string): Promise<void> {
  const FIND =
    `[...document.querySelectorAll('*')].reverse().find(` +
    `(n) => n.childElementCount === 0 && (n.textContent ?? '').includes(${JSON.stringify(text)}))`
  await until(() => app.main.eval<boolean>(`${FIND} !== undefined`), `session row "${text}"`)
  await app.main.eval(`${FIND}.click()`)
}

/** 切到指定笔记本会话并等其正文上屏 —— 防止断言到上一个会话残留的卡片 DOM */
async function openNotebook(rowText: string, bodyMarker: string): Promise<void> {
  await clickSessionByText(rowText)
  await until(
    () =>
      app.main.eval<boolean>(
        `(document.querySelector('.cm-content')?.textContent ?? '').includes(${JSON.stringify(bodyMarker)})`
      ),
    `notebook "${rowText}" loaded`
  )
}

/** 校验横幅当前态（hidden / 语义类名 / 合并行文本）—— 横幅断言共用 */
function bannerState(): Promise<{ hidden: boolean; cls: string; text: string }> {
  return app.main.eval(
    `(() => {
      const b = document.querySelector('.cm-shuvix-fmcard-banner')
      return {
        hidden: b ? b.hidden : true,
        cls: b ? b.className : '',
        text: [...document.querySelectorAll('.cm-shuvix-fmcard-banner-line')]
          .map((n) => n.textContent)
          .join('\\n')
      }
    })()`
  )
}

/** 环境变量 SHUVIX_E2E_SHOT 指定路径时，对主窗口截图落盘（第二条 ws 连接失败则静默跳过） */
async function maybeScreenshot(): Promise<void> {
  const out = process.env.SHUVIX_E2E_SHOT
  if (!out) return
  try {
    const target = (await listTargets(app.port)).find((t) => isMainPage(t))
    if (!target) return
    const data = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      ws.onopen = () =>
        ws.send(
          JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })
        )
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as {
          id?: number
          error?: unknown
          result?: { data: string }
        }
        if (m.id !== 1) return
        ws.close()
        if (m.error || !m.result) reject(new Error(JSON.stringify(m.error)))
        else resolve(m.result.data)
      }
      ws.onerror = () => reject(new Error('screenshot ws failed'))
    })
    writeFileSync(out, Buffer.from(data, 'base64'))
  } catch {
    /* 截图是旁路证据，失败不影响断言 */
  }
}

beforeAll(async () => {
  app = await launchApp()
  card = fmCardPane(app.main)
  projDir = join(app.home, 'proj-fmcard')
  mkdirSync(projDir, { recursive: true })
  cardMdPath = join(projDir, 'card-demo.md')
  writeFileSync(cardMdPath, CARD_MD)
  writeFileSync(join(projDir, 'plain-note.md'), PLAIN_MD)
  writeFileSync(join(projDir, 'bad-policy.md'), BAD_POLICY_MD)
  writeFileSync(join(projDir, 'warn-policy.md'), WARN_POLICY_MD)
  writeFileSync(join(projDir, 'wiki-note.md'), WIKI_MD)
  writeFileSync(join(projDir, 'bad-agent.md'), BAD_AGENT_MD)
  const project = await createProject(app.main, { name: 'FmCardProj', path: projDir })
  // 每个文件一个笔记本会话（标题默认取 basename，供侧栏点击定位）。
  // 无卡片的 plain-note 保持最后创建：若宿主自动打开最近会话，初始视图无卡片，
  // 首个用例点开 card-demo 后的卡片 until 不会误认上一视图的卡。
  for (const file of [
    'card-demo.md',
    'bad-policy.md',
    'warn-policy.md',
    'wiki-note.md',
    'bad-agent.md',
    'plain-note.md'
  ]) {
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({ projectId: project.id, notebookPath: join(projDir, file) })})`
    )
  }
})
afterAll(async () => {
  await app.stop()
})

describe('frontmatter 属性卡', () => {
  it('契约 md：frontmatter 渲染为属性卡（徽章 / 字段行 / chips / 开关 / 未知键通用行）', async () => {
    await clickSessionByText('card-demo')
    // 槽位内容是宿主异步挂的 React 子树 —— 只等 `.cm-shuvix-fmcard` 存在会读到空串
    await card.waitReady({ slots: 3 })

    const badge = await app.main.eval<string>(
      `document.querySelector('.cm-shuvix-fmcard-badge')?.textContent ?? ''`
    )
    expect(badge).toBe('ShuviX agent · v1')

    // 可编辑宿主（笔记本注入了 mountField）：model / tools / instruction-files 三行是
    // **选择器槽位**，由宿主挂载 ModelSelect / ToolSelectList / 清单输入框，卡片自身不再渲染 chips。
    // 只读宿主（FilePreview）走另一分支，仍是 .cm-shuvix-fmcard-chip 只读展示。
    const slots = await app.main.eval<number>(
      `document.querySelectorAll('.cm-shuvix-fmcard-slot').length`
    )
    expect(slots).toBe(3)
    const slotText = (key: string): Promise<string> =>
      app.main.eval<string>(
        `(document.querySelector('.cm-shuvix-fmcard-row[data-key=${JSON.stringify(key)}] .cm-shuvix-fmcard-slot')?.textContent ?? '').trim()`
      )
    // 工具触发器显示当前白名单（原样逗号串）
    expect(await slotText('shuvix-tools')).toContain('bash, read, write')
    // 指令文件清单是普通输入框（值在 input.value 上，不是触发器文案）
    expect(
      await app.main.eval<string>(
        `document.querySelector('.cm-shuvix-fmcard-row[data-key="shuvix-instruction-files"] input')?.value ?? ''`
      )
    ).toBe('AGENTS.md, CLAUDE.md')

    // 两个布尔字段按描述符顺序（项目感知 → dispatch-only），均缺省 unset
    // —— instruction-files 是清单不是开关，项目提示词与项目记忆已合成项目感知一个开关
    const toggles = await app.main.eval<string[]>(
      `[...document.querySelectorAll('.cm-shuvix-fmcard-toggle')].map((n) => n.dataset.state)`
    )
    expect(toggles).toEqual(['unset', 'unset'])

    // 未知键（shuvix-builtin）落通用 key/value 行；类型标记键本身不成行
    const labels = await app.main.eval<string[]>(
      `[...document.querySelectorAll('.cm-shuvix-fmcard-label')].map((n) => n.textContent)`
    )
    expect(labels).toContain('shuvix-builtin')
    expect(labels).not.toContain('shuvix')

    // 正文照常渲染（卡片只接管 frontmatter 区间）
    const bodyText = await app.main.eval<string>(
      `document.querySelector('.cm-content')?.textContent ?? ''`
    )
    expect(bodyText).toContain('Demo body')
    expect(bodyText).not.toContain('shuvix: agent v1')

    // 校验态：合法 agent md → is-ok 徽章异步上屏，横幅保持隐藏
    await until(
      () =>
        app.main.eval<boolean>(`document.querySelector('.cm-shuvix-fmcard-status.is-ok') !== null`),
      'valid status chip (is-ok)'
    )
    expect((await bannerState()).hidden).toBe(true)

    await maybeScreenshot()
  })

  it('卡上开关 → 行级写回：project-awareness 缺省态点开 → 文件闭合线前插入 true 行', async () => {
    // 布尔行只剩两个（instruction-files 是清单、项目提示词与记忆已合成项目感知）：
    // project-awareness 排第一
    await app.main.eval(
      `document.querySelectorAll('.cm-shuvix-fmcard-toggle')[0]` +
        `.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`
    )
    // 卡片按新 YAML 重建，开关翻到 on
    await until(
      () =>
        app.main.eval<boolean>(
          `document.querySelectorAll('.cm-shuvix-fmcard-toggle')[0]?.dataset.state === 'on'`
        ),
      'toggle flipped to on'
    )
    // 笔记本防抖自动保存落盘：插入行位于闭合定界线之前，其余行原样保留
    await until(() => {
      const text = readFileSync(cardMdPath, 'utf8')
      return /shuvix-project-awareness: true\r?\n---/.test(text)
    }, 'scoped line write persisted')
    const text = readFileSync(cardMdPath, 'utf8')
    expect(text).toContain('shuvix-builtin: true')
    expect(text).toContain('shuvix-tools: bash, read, write')

    // 校验态：YAML 变化 → 新缓存 key → 重校验仍 valid（is-ok 在重建后的卡上再次上屏）
    await until(
      () =>
        app.main.eval<boolean>(`document.querySelector('.cm-shuvix-fmcard-status.is-ok') !== null`),
      'revalidated status chip (is-ok) after toggle'
    )
  })

  it('普通 frontmatter（无 shuvix 标记）不渲染卡片，原文照常显示', async () => {
    await clickSessionByText('plain-note')
    await until(
      () =>
        app.main.eval<boolean>(
          `(document.querySelector('.cm-content')?.textContent ?? '').includes('Plain body')`
        ),
      'plain notebook loaded'
    )
    const hasCard = await app.main.eval<boolean>(
      `document.querySelector('.cm-shuvix-fmcard') !== null`
    )
    expect(hasCard).toBe(false)
    const content = await app.main.eval<string>(
      `document.querySelector('.cm-content')?.textContent ?? ''`
    )
    expect(content).toContain('title: 普通笔记')
  })

  it('IPC 冒烟：shuvixMd.validate 直调 —— invalid 透传 name 进诊断、合法 agent 无消息', async () => {
    const invalid = await app.main.eval<{ status: string; messages: string[] }>(
      `window.api.shuvixMd.validate({ type: 'policy', text: 'not md', name: 'x.md' })`
    )
    expect(invalid.status).toBe('invalid')
    expect(invalid.messages[0]).toContain("'x.md'")

    const valid = await app.main.eval<{ status: string; messages: string[] }>(
      `window.api.shuvixMd.validate({ type: 'agent', text: ${JSON.stringify(CARD_MD)} })`
    )
    expect(valid).toEqual({ status: 'valid', messages: [] })
  })

  it('非法 policy md：is-err 徽章 + 横幅显示解析器拒绝原因', async () => {
    await openNotebook('bad-policy', 'Bad policy body')
    await until(
      () =>
        app.main.eval<boolean>(
          `document.querySelector('.cm-shuvix-fmcard-status.is-err') !== null`
        ),
      'invalid status chip (is-err)'
    )
    const banner = await bannerState()
    expect(banner.hidden).toBe(false)
    expect(banner.cls).toContain('is-err')
    // 横幅行序即解析器 warn 顺序（规则级细因在前、文件级 reject 在后）；只断言稳定片段
    expect(banner.text).toContain('unknown rule key')
    expect(banner.text).toContain('rejected')
  })

  it('合法带软告警的 policy md：is-warn 徽章 + 横幅提示 object.type', async () => {
    await openNotebook('warn-policy', 'Warn policy body')
    await until(
      () =>
        app.main.eval<boolean>(
          `document.querySelector('.cm-shuvix-fmcard-status.is-warn') !== null`
        ),
      'warned status chip (is-warn)'
    )
    const banner = await bannerState()
    expect(banner.hidden).toBe(false)
    expect(banner.cls).toContain('is-warn')
    expect(banner.text).toContain('object.type')
  })

  it('无校验器类型（wiki-entry）：卡片照常渲染但不显示任何校验态', async () => {
    await openNotebook('wiki-note', 'Wiki entry body')
    await until(
      () => app.main.eval<boolean>(`document.querySelector('.cm-shuvix-fmcard') !== null`),
      'wiki frontmatter card rendered'
    )
    const badge = await app.main.eval<string>(
      `document.querySelector('.cm-shuvix-fmcard-badge')?.textContent ?? ''`
    )
    // 徽章文案取 shuvixMdDescriptors 的 badge（f18e6d2 起 wiki-entry 有描述符），非裸类型名回退
    expect(badge).toBe('ShuviX wiki entry · v1')

    // unknown 状态不 paint：等异步校验落定后，状态徽章仍隐藏且无任何 is-* 语义类
    await sleep(800)
    const chip = await app.main.eval<{ hidden: boolean; cls: string } | null>(
      `(() => {
        const n = document.querySelector('.cm-shuvix-fmcard-status')
        return n ? { hidden: n.hidden, cls: n.className } : null
      })()`
    )
    expect(chip).not.toBeNull()
    expect(chip!.hidden).toBe(true)
    expect(chip!.cls).not.toMatch(/is-(ok|warn|err)/)
    expect((await bannerState()).hidden).toBe(true)
  })

  it('非法 agent md：is-err 徽章 + 横幅给出解析器拒绝原因', async () => {
    await openNotebook('bad-agent', 'Bad agent body')
    await until(
      () =>
        app.main.eval<boolean>(
          `document.querySelector('.cm-shuvix-fmcard-status.is-err') !== null`
        ),
      'invalid status chip (is-err)'
    )
    // agent 解析器带 warn 通道后，非法 agent 与非法 policy 一样能说清「哪里错了」
    const banner = await bannerState()
    expect(banner.hidden).toBe(false)
    expect(banner.cls).toContain('is-err')
    expect(banner.text).toContain("'shuvix-tools'")
    expect(banner.text).toContain('rejected')
  })
})
