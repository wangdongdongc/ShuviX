/**
 * web 客户端的手机布局（MobileShell）—— 浏览器里的 web 客户端开在窄屏（< 640px）或触屏的矮屏（< 500px 高）上时，
 * 换成底部四个标签 + 整屏对话页 + 底部抽屉 + 长按 = 右键；桌面应用的窗口永远是桌面布局。
 *
 * 判定（web 客户端 / 桌面窗口）：
 *   W-1 1280×800、没有触屏：没有 [data-mobile-shell]；侧栏设置栏与六个注册表分组都在
 *   W-2 拉到 390 宽：不重载就换成手机布局；拉回 1280 就换回来
 *   W-3 844×390 + 触屏 → 手机布局；同样大小关掉触屏 → 桌面布局
 *   W-4 `/` 的 HTML 带 viewport meta（width=device-width、viewport-fit=cover、interactive-widget=resizes-content）
 *   D-1 桌面主窗口在 390 宽的模拟下：没有手机布局，侧栏设置栏在，没有 viewport meta
 *   D-2 桌面设置窗口在 390 宽的模拟下：不是叠放布局，设置行 flex-wrap: nowrap
 *
 * 手机布局（390×844、dsf 2、mobile、触屏模拟，重载之后）：
 *   M-1 四个标签 Chats / Widgets / Library / Settings，只有会话标签 aria-current；只挂了会话页
 *   M-2 点标签：aria-current 跟着走、第一次点才挂载；去过的留着（display none）；展开的项目组转一圈回来还展开着
 *   M-3 会话页的分组只有 section / project / temp；没有设置栏、没有拖拽带
 *   M-4 资料库页的分组恰是 bots, agents, policies, hooks, skills, knowledge
 *   M-5 真点一行 → 对话页：标题对、预置的回复在、标签层 aria-hidden、历史压了一条带标记的（长度 +1）；
 *       对话横幅里没有 agent 胶囊（桌面布局里同一会话有）
 *   M-6 返回键收起对话页并退掉那条历史；history.back() 也收起（窗口上的标记证明没有重载）
 *   M-7 再点一次正活跃的那一行 → 重新推入
 *   M-8 日历开关：aria-label 换；点当天的会话 → 对话页；返回；再点那条（已是活跃的）→ 又推入；
 *       列表 ⇄ 日历来回切，日历选中的日子与列表的展开状态都还在
 *   M-9 新建会话抽屉：临时会话 + 各项目；点遮罩什么都不建；选一个项目 → 恰建一条该项目的会话并推入
 *   M-10 资料库里的 bot 行 → 对话页里是笔记本（.cm-editor）；返回落在资料库；再点那一行（此刻是活跃会话）又推入
 *   M-11 对话页没有桌面顶栏的按钮（内置浏览器窗口、侧栏 / 面板开关）；点标题 → 会话设置
 *   M-12 文件抽屉列出 hello.txt，点遮罩收起；任务抽屉是空态（mobile.noTasks）
 *   M-13 在会话设置里删掉这条会话 → 对话页收起、列表里没了这一行、那条历史标记退掉
 *   M-14 真点小组件卡片 → 新标签页 #widget-window?widgetId=…，页面里不开面板；真长按卡片 → DOM 菜单恰是
 *        「在独立窗口打开 / 导出 / 归档 / 删除」（运行中多一个「停止」），没有「在面板中打开」
 *   M-14b 真点卡片右上角（桌面上悬浮按钮所在的地方）→ 与点中间一样开新标签页：没有归档、没有删除确认框、没有停掉
 *   M-15 设置：分区列表 general … about + agents（voice / triggers / telegramBots 带 Beta）；进「通用」→ 返回键、头部名、
 *        设置行 flex-wrap: wrap 且标题栏 min-width 9em；回列表；「智能体」分区头部是 Agents
 *   M-16 #settings/general 在手机宽度直接进分区、返回是列表；#settings 是列表；1280 宽不是叠放
 *   M-17 真触摸：按住 800ms → DOM 菜单、不推入对话页、页面里的 contextmenu 恰一次（window 捕获阶段数：菜单处理
 *        函数会 stopPropagation，冒泡到 window 的那一程走不到）；轻点 100ms → 推入；
 *        挪 30px 没有菜单、挪 5px 照样有；关掉菜单之后的下一次轻点照常推入；资料库里内置智能体行按住 →
 *        菜单里有「创建覆盖副本」
 *   M-18 专注模式缺省开着：手机布局里打开再返回，壳里没有 .opacity-30；1280 宽的桌面布局里至少一处
 *   M-19 手机布局里对话输入框 16px；1280 宽时不是 16px。会话行与项目组头、「项目知识库」文件夹行同高（±2px：
 *        侧栏的行是一套 .sb-row），手机上是触屏那一档（≥ 40px），桌面侧栏里同一条会话行是 Finder 那一档（24px ±1）
 *   M-20 popstate 只在落到不带标记的那一条时收起对话页；重载时留下的那条带标记的历史在挂载时被摘掉
 *   M-21 360 宽的卡片（英文、模型名很长）：空闲时发送键在卡片里、模型名截断；用发送键发出（触屏的回车是换行）、
 *        运行中没打字时只有停止；打了字是一颗「立即」（没有字那格，aria-label / title 是字）+ 停止，都 ≥ 36px、
 *        都在卡片里，用量环在卡片里、不缩，扩展选择器不压到环上、模型触发器不压到扩展选择器上、模型名 < 120px 且
 *        截断、页面与壳没有横向溢出；长按「立即」→ 菜单里两档带字；清掉字 → 菜单与「立即」都收起。跑完发送键又在
 *        卡片里。1280 宽：模型名恰 120px（封顶、不缩），运行中两个队列出口带字
 *   M-22 很长的多段思考折叠成一行：块高与一句话的思考相同（±1）、到终答正文的间距也相同（±1，回归点：之前外层
 *        按里面整段换行的高度留位，折叠的思考块下面空出一大块）、内容盒 nowrap + ellipsis 且确实溢出；点开 →
 *        高 > 3 倍、文字从第一段开头到最后一段结尾（首尾空行去掉）、段落空行留着；再点 → 回到一行高
 *   M-23 设置里往下钻的分区：「提供商」先是一整屏列表、什么都不选（每行 ≥ 48px；返回键回设置列表、level section；
 *        头部是分区名）→ 真点假提供商那一行 → 只剩详情，返回键是分区名（level item）、头部是它的名字 → 返回 = 列表
 *        → 再返回 = 设置列表；「LLM 工具」里点 read 一样（头部 = read 的标签）。列表滚到底再点最后一行 → 真正在滚的
 *        那一层回到顶上；返回 → 列表回到离开前的位置（±2px）。行上的开关只切启用（listAll 跟着变）、不进详情
 *   M-24 超宽的内容不让对话左右滑（360 宽）：一段六种工具的合并行（标签「每种工具各几次」比一屏还长）、终答里的
 *        长裸链接 / 长文字链接 / www 链接 / 长行内代码 / GFM 不认的链接与没加反引号的长 token（普通文字）/ 引用与
 *        列表里的长链接 / 无语言与带语言的长行代码块，加上用户气泡里的长链接 —— 对话滚动区与整页都没有横向溢出；合并行的标签截断、计数徽章在行里；展开合并行之后也一样
 *   M-25 输入卡片的触屏密度（MOB-composer，模型能看图）：390 与 360 宽时空闲的「+」、模型胶囊、扩展胶囊、发送键都
 *        ≥ 36px 高（「+」与发送键也 ≥ 36px 宽）、都在卡片里、从左到右「+」< 模型 < 扩展且不重叠；扩展胶囊的字那格
 *        display none、计数在；file input display none；页面与壳没有横向溢出。真点用量环 → 数字浮层 display block 且
 *        在视口里，再点 → none。1280 宽：「+」24×24（±1），没有扩展计数，点模型触发器 → fixed 定位的下拉面板、没有抽屉
 *   M-26 模型抽屉：真点模型胶囊 → 抽屉在视口里（贴底、左右贴边）、高 ≤ 屏高 80%；搜索框 16px、不抢焦点；模型行
 *        ≥ 44px。真点遮罩离顶 40px 那一点（压在对话标题上）→ 抽屉关、对话页还在、会话设置没开。换成第二个模型 →
 *        胶囊显示它，再换回来
 *   M-27 扩展抽屉：真点扩展胶囊 → 抽屉在视口里、标题 Extensions、每个扩展行 ≥ 48px、勾选框 20×20（±1）；真点 mcp:ssh
 *        那行的勾选框 → 会话的 enabledTools（IPC 读）多了它、抽屉不关、计数 +1；真点遮罩 → 抽屉关、会话设置没开
 *   M-28 真回车（CDP 可信按键）是换行：「line one」回车「line two」→ 输入框里两行，500ms 内不忙、假提供商没收到请求；
 *        真点发送 → 用户消息就是那两行。运行中（hold 住）打「hold me」，真按住「立即」800ms → 菜单两档、输入框原样、
 *        什么都没排上（按住之后那一下 click 被吞）；真点菜单里的「追加」→ 输入框清空、队列面板一条 followUp；
 *        放行之后它作为下一条用户消息落进会话
 *   M-29 消息的操作（MOB-actions，390 宽，真触摸）：手机发出「Hi」（来源 remote）、脚本回复落定。来源标签在气泡
 *        右上方 —— meta 行右缘 = 气泡右缘（±1）、在气泡上面、里面是 remote 标签且贴着右缘；没点过时这条消息没有
 *        复制 / 回退；真点一下气泡 → 两颗都出、opacity 1、在气泡下面、互不重叠、在视口里、都 ≥ 32×32（±1）；
 *        再点 → 收。回复卡的操作不用碰就在：复制与重新生成都有，每颗 opacity 1、≥ 32×32（±1），第一颗的图标与
 *        正文左缘对齐（±1.5）；翻出操作之后对话不左右滑
 *   M-30 桌面主窗口（compact）里同一条会话：remote 的「Hi」那行标签右缘 = 气泡右缘（±1）、在气泡上面（原来的
 *        bug：短消息的标签歪到气泡左边去）；不悬停时用户消息的复制 / 回退与回复卡的操作都在、opacity 0；
 *        真悬停气泡 → 那两颗到 1，气泡与 meta 行一动不动（±0.5）；悬停回复正文 → 它的操作到 1
 *   M-31 审批卡片（MOB-ask，390 宽，真触摸）：项目会话读家目录里、工作区外的文件（ask-on-external-path #0 问人），
 *        手机打开它。卡片恰四行 allow / remember-path / remember-folder / deny（en 文案）：每行 ≥ 44px 高（−0.5）、
 *        左右缘 = 面板的（±1）且在 0…390 之内、自上而下不重叠，第一行顶与最后一行底都在视口里；正文 16px；文件夹
 *        那一行的路径不伸出行的右缘；页面与壳没有横向溢出；输入框占位是 otherPlaceholderAsk。焦点在 body 上按可信的
 *        1 → 500ms 后卡片还在、假提供商没收到新请求（触屏没有数字键）。真点「允许这一次」→ 卡片收起、回复
 *        MOB-ASK-DONE 落定、read 那一块的结果里有 MOB-ASK-FILE 且不是错误
 *
 * 约定同 web-fallbacks.e2e.ts：界面语言先设成 en；从不在缺省端口 7766 上打开；会话只经主进程 IPC 带明确标题创建
 * （不跑 titler）；预置回复经主进程的 agent.prompt 跑完一轮。设备模拟走 CDP（`Emulation.setDeviceMetricsOverride`
 * + `setTouchEmulationEnabled`），切到手机布局后重载一次（M-1 要一个刚挂上的壳）；点击 / 长按都是
 * `Input.dispatchTouchEvent` 的真触摸（webMobilePane）。M-17 的长按 / 挪动靠真实时长（800ms、按下 100ms 后挪动），
 * 在很慢的机器上偶发失败的话先看这一条。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { connectTabPage } from '../../harness/browserFixtures'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  browserTabs,
  closeBrowserTab,
  httpProbe,
  openWebClient,
  waitBrowserTab,
  type NetworkStatus,
  type WebClientHandle
} from '../../harness/networkFixtures'
import {
  agentsSidebarPane,
  botsPane,
  chatOriginBadges,
  chatPane,
  sessionConfigPane,
  sidebarPane,
  webClientPane,
  webMobilePane,
  confirmPane,
  widgetPanelPane,
  type BoxShot,
  type ComposerLayoutShot,
  type ConversationOverflowShot,
  type ThinkingBlockShot,
  type TouchSheetShot,
  type UserMessageShot,
  type WebMobileTab
} from '../../harness/pages'
import {
  createProject,
  newSessionsAfter,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 10 }
const WIDGET_ID = 'mob-widget'
const BOT = 'mobbot'
const REGISTRY_GROUPS = ['bots', 'tracking', 'agents', 'policies', 'hooks', 'skills', 'knowledge']
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
/** M-21：最窄的常见手机 */
const NARROW = { width: 360, height: 780, deviceScaleFactor: 2, mobile: true }
/** M-21 的会话用的模型：名字长到在 360 宽的卡片里一定放不下 */
const LONG = 'e2e-model-with-an-unusually-long-identifier-for-phones'
/** M-22：一句话的思考（参照）与五段、首尾带空行的长思考 */
const THINK_SHORT = 'Short thought.'
const THINK_PARAS = [1, 2, 3, 4, 5].map(
  (n) =>
    `Paragraph ${n} opens here and keeps going ` +
    'with a long run of ordinary words that wraps several times on a phone '.repeat(2) +
    `until paragraph ${n} closes.`
)
const THINK_LONG = '\n\n' + THINK_PARAS.join('\n\n') + '\n\n\n'
/** M-24：一个没有断点的长链接 / 长 token，与带着它们的终答 */
const WIDE_URL = 'https://example.com/' + 'a'.repeat(160)
const WIDE_TOKEN = 'k'.repeat(220)
const WIDE_REPLY = [
  'MOB-WIDE-REPLY',
  '',
  `Bare link: ${WIDE_URL}`,
  '',
  `Named link: [${'n'.repeat(120)}](https://example.com/named)`,
  '',
  `Autolink: www.example.com/${'w'.repeat(120)}`,
  '',
  `Inline code: \`${'c'.repeat(120)}\``,
  '',
  // GFM 不认的链接（没有 scheme、没有 www.）与没加反引号的长标识符：都是正文里的普通文字
  `Plain link: example.com/${'e'.repeat(120)}`,
  '',
  `Plain token: ${'p'.repeat(150)}`,
  '',
  `> A quote ${WIDE_URL}`,
  '',
  '```',
  WIDE_TOKEN,
  'a short line',
  '```',
  '',
  '```ts',
  `const wide = '${WIDE_TOKEN}'`,
  '```',
  '',
  `- a list item ${WIDE_URL}`
].join('\n')

let app: E2EApp
let provider: FakeProvider
let web: WebClientHandle | undefined
let P = 0
/** 假提供商的 id（M-23 认它那一行） */
let fakeProviderId = ''
const projects = { main: { id: '', name: 'MobProj' }, other: { id: '', name: 'MobProj2' } }
const sids = {
  chat: '',
  temp: '',
  doomed: '',
  narrow: '',
  think: '',
  wide: '',
  composer: '',
  actions: ''
}
/** M-29 / M-30：手机发出的那句与脚本回复 */
const ACTIONS_ASK = 'Hi'
const ACTIONS_REPLY = 'MOB-ACTIONS-REPLY'
/** 用例里开的浏览器 tab（失败时 afterAll 兜底关） */
const openedTabs = new Set<string>()

const page = (): CdpClient => web!.page
const mobile = (): ReturnType<typeof webMobilePane> => webMobilePane(page())

const setPort = (port: unknown): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setPort(${JSON.stringify(port)})`)
const setEnabled = (on: boolean): Promise<NetworkStatus> =>
  app.main.eval<NetworkStatus>(`window.api.network.setEnabled(${JSON.stringify(on)})`)

const sessionsInMain = (): Promise<
  Array<{ id: string; title: string; projectId: string | null }>
> =>
  app.main.eval(
    `window.api.session.list().then((ss) => ss.map((s) => ({ id: s.id, title: s.title, projectId: s.projectId ?? null })))`
  )

/**
 * 主进程里跑完一轮（脚本化的回复，可带思考；给了 `toolCalls` 就先调一轮工具再回复）—— 会话有了消息、有了今天的
 * 日历记录、也有了运行时
 */
async function seedReply(
  sid: string,
  prompt: string,
  reply: string,
  thinking?: string,
  toolCalls?: Array<{ id: string; name: string; args: string }>
): Promise<void> {
  if (toolCalls) provider.script({ toolCalls, usage: USAGE }, { text: reply, usage: USAGE })
  else provider.script({ text: reply, thinking, usage: USAGE })
  await app.main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: prompt })}).then(() => true)`
  )
  await until(
    async () =>
      (
        await app.main.eval<Array<{ role: string; content: string }>>(
          `window.api.message.list(${JSON.stringify(sid)})`
        )
      ).some((m) => m.role === 'assistant' && m.content === reply),
    `the seeded reply in ${sid}`
  )
}

async function emulate(
  client: CdpClient,
  metrics: typeof PHONE | typeof DESKTOP | null,
  touch: boolean
): Promise<void> {
  if (metrics) await client.send('Emulation.setDeviceMetricsOverride', metrics)
  else await client.send('Emulation.clearDeviceMetricsOverride')
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 })
}

/** 重载页面并等 web 客户端重新连上、React 重新挂上（重载前打的标记消失 = 真的换了一个文档） */
async function reload(client: CdpClient): Promise<void> {
  await client.eval(`(window.__mobBeforeReload = true)`)
  await client.send('Page.reload', {})
  await until(
    () =>
      client.eval<boolean>(
        `!window.__mobBeforeReload && window.api?.app?.platform === 'web' && document.readyState === 'complete'`
      ),
    'the web client reloaded'
  )
  await client.eval('window.api.app.getVersion()')
  await waitRendererReady(client)
}

/** 手机：390×844 + 触屏，重载，等壳与会话列表上屏 */
async function phone(): Promise<void> {
  await emulate(page(), PHONE, true)
  await reload(page())
  expect(
    await page().eval<boolean>(`matchMedia('(pointer: coarse)').matches`),
    'precondition: touch emulation makes the pointer coarse'
  ).toBe(true)
  await until(() => mobile().shellPresent(), 'the phone shell mounted')
  await listSettled()
}

/**
 * 会话列表落定：行都在、项目到货后的那一次「项目组缺省收起」也已经发生（之前点下去的行会在按下与松开之间挪位）
 */
async function listSettled(): Promise<void> {
  await until(async () => {
    const rows = await mobile().listRows()
    if (!rows.includes('MOB-temp')) return false
    return (
      (await mobile().listGroupExpanded(projects.main.name)) === false &&
      (await mobile().listGroupExpanded(projects.other.name)) === false
    )
  }, 'the phone session list settled')
}

/** 回到桌面大小（不重载：布局跟着媒体查询切） */
async function desktopView(): Promise<void> {
  await emulate(page(), null, false)
  await until(async () => !(await mobile().shellPresent()), 'back to the desktop layout')
}

/** 切到某个标签（已经是它就不点） */
async function toTab(key: WebMobileTab): Promise<void> {
  if ((await mobile().activeTab()) === key) return
  await mobile().tap({ tab: key })
  await until(async () => (await mobile().activeTab()) === key, `the ${key} tab`)
}

/** 推入对话页（真点会话列表里的一行）并等它上屏 */
async function openFromList(title: string): Promise<void> {
  await toTab('sessions')
  await mobile().tap({ sessionRow: title })
  await until(
    async () => (await mobile().chatOpen()) && (await mobile().chatTitle()) === title,
    `the chat page for ${title}`
  )
}

async function backToList(): Promise<void> {
  await mobile().tap({ chat: 'back' })
  await until(async () => !(await mobile().chatOpen()), 'the chat page closed')
}

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  provider = await startFakeProvider()
  const { providerId } = await seedFakeProvider(app.main, {
    baseUrl: provider.baseUrl,
    modelId: MODEL
  })
  fakeProviderId = providerId
  await waitRendererReady(app.main)
  // M-21 的长名字模型（带上下文上限，用量环才画）—— 在打开 web 客户端之前加，它载入的模型目录里就有
  await app.main.eval(
    `(async () => {
      const args = ${JSON.stringify({ providerId, modelId: LONG })}
      await window.api.provider.addModel(args)
      const row = (await window.api.provider.listModels(args.providerId)).find((m) => m.modelId === args.modelId)
      if (!row) throw new Error('the long model row was not added')
      await window.api.provider.updateModelCapabilities({
        id: row.id,
        capabilities: { maxInputTokens: 200000, maxOutputTokens: 4096 }
      })
      return true
    })()`
  )

  const mainDir = join(app.home, 'mob-proj')
  mkdirSync(mainDir, { recursive: true })
  writeFileSync(join(mainDir, 'hello.txt'), 'hello from the phone\n')
  projects.main.id = (await createProject(app.main, { name: projects.main.name, path: mainDir })).id
  const otherDir = join(app.home, 'mob-proj2')
  mkdirSync(otherDir, { recursive: true })
  projects.other.id = (
    await createProject(app.main, { name: projects.other.name, path: otherDir })
  ).id

  const create = (title: string, projectId: string | null): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
    )
  sids.chat = await create('MOB-chat', projects.main.id)
  sids.temp = await create('MOB-temp', null)
  sids.doomed = await create('MOB-doomed', null)
  sids.narrow = await create('MOB-narrow', null)
  sids.think = await create('MOB-think', null)
  // M-25..M-28：能看图的模型（seedFakeProvider 给 MODEL 带了 vision），还没有运行时
  sids.composer = await create('MOB-composer', null)
  // M-29 / M-30：同一个模型，手机在里面发第一句
  sids.actions = await create('MOB-actions', null)
  await seedReply(sids.chat, 'hello phone', 'MOB-REPLY')
  await seedReply(sids.temp, 'hello temp', 'MOB-TEMP-REPLY')
  // M-21：还没有运行时，选模型照常写得进去
  expect(
    await app.main.eval<{ success: boolean }>(
      `window.api.agent.setModel(${JSON.stringify({ sessionId: sids.narrow, provider: providerId, model: LONG })})`
    )
  ).toMatchObject({ success: true })
  expect(
    await app.main.eval<{ success: boolean }>(
      `window.api.agent.setModel(${JSON.stringify({ sessionId: sids.composer, provider: providerId, model: MODEL })})`
    )
  ).toMatchObject({ success: true })
  expect(
    await app.main.eval<{ success: boolean }>(
      `window.api.agent.setModel(${JSON.stringify({ sessionId: sids.actions, provider: providerId, model: MODEL })})`
    )
  ).toMatchObject({ success: true })
  // M-22：一轮一句话的思考、一轮五段的长思考
  await seedReply(sids.think, 'think briefly', 'MOB-THINK-1', THINK_SHORT)
  await seedReply(sids.think, 'think at length', 'MOB-THINK-2', THINK_LONG)
  // M-24：六种工具（都在项目目录里，不问人）合并成一行，终答带长链接、长代码；问句里也有一条长链接
  sids.wide = await create('MOB-wide', projects.main.id)
  const call = (
    name: string,
    args: Record<string, unknown>
  ): { id: string; name: string; args: string } => ({
    id: `call_wide_${name}`,
    name,
    args: JSON.stringify(args)
  })
  await seedReply(sids.wide, `look at ${WIDE_URL}`, WIDE_REPLY, undefined, [
    call('ls', { path: mainDir }),
    call('glob', { pattern: '*.txt', path: mainDir }),
    call('grep', { pattern: 'hello', path: mainDir }),
    call('read', { path: join(mainDir, 'hello.txt') }),
    call('knowledge', { action: 'bases' }),
    call('session', { action: 'list-sessions' })
  ])

  writeBotMd(app, BOT, { displayName: 'Mob Bot' })

  // 一个最小的 widget（不引任何包）
  const widgetDir = join(app.home, '.shuvix', 'widgets', WIDGET_ID)
  mkdirSync(widgetDir, { recursive: true })
  writeFileSync(
    join(widgetDir, 'widget.json'),
    JSON.stringify(
      {
        id: WIDGET_ID,
        name: 'Mob Widget',
        description: 'phone layout e2e widget',
        entryFile: 'index.tsx',
        createdAt: Date.now()
      },
      null,
      2
    ) + '\n'
  )
  writeFileSync(
    join(widgetDir, 'index.tsx'),
    "const root = document.getElementById('root')\nif (root) root.textContent = 'MOB-WIDGET'\n"
  )

  do {
    P = await freePort()
  } while (P === 7766)
  expect(await setPort(P)).toMatchObject({ enabled: false, port: P, listening: false })
  expect(await setEnabled(true)).toMatchObject({ enabled: true, port: P, listening: true })

  web = await openWebClient(app, P)
  await until(async () => {
    const titles = await sidebarPane(page()).titles()
    return titles.includes('MOB-temp') && titles.includes('MOB-doomed')
  }, 'web sidebar lists the seeded sessions')
}, 180_000)

afterAll(async () => {
  if (app) for (const id of [...openedTabs]) await closeBrowserTab(app, id)
  if (web) await web.close().catch(() => undefined)
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('phone layout: which windows get it', () => {
  it('W-1 at 1280×800 without touch the web client is the desktop layout', async () => {
    expect(await mobile().shellPresent()).toBe(false)
    expect(await mobile().sidebarSettingsRow()).toBe(true)
    expect(await mobile().documentGroups()).toEqual(expect.arrayContaining(REGISTRY_GROUPS))
    // 后面 M-5 断「手机的对话横幅里没有 agent 胶囊」：同一条会话在桌面布局里是有的
    expect(await sidebarPane(page()).openSession('MOB-chat')).toBe(true)
    await until(() => mobile().agentChipAnywhere(), 'the agent chip in the desktop banner')
  })

  it('W-2 narrowing to 390 brings the shell without a reload; widening to 1280 takes it away', async () => {
    try {
      await page().eval(`(window.__mobNoReload = 'w2')`)
      await emulate(page(), { ...PHONE, mobile: false, deviceScaleFactor: 1 }, false)
      await until(() => mobile().shellPresent(), 'the shell at 390')
      await emulate(page(), DESKTOP, false)
      await until(async () => !(await mobile().shellPresent()), 'the desktop layout at 1280')
      expect(await mobile().sidebarSettingsRow()).toBe(true)
      expect(await page().eval<string>(`window.__mobNoReload ?? ''`)).toBe('w2')
    } finally {
      await emulate(page(), null, false)
    }
  })

  it('W-3 a short landscape screen is a phone only with touch', async () => {
    try {
      const landscape = { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }
      await emulate(page(), landscape, true)
      await until(() => mobile().shellPresent(), 'the shell at 844×390 with touch')
      await emulate(page(), landscape, false)
      await until(async () => !(await mobile().shellPresent()), 'the desktop layout without touch')
      expect(await mobile().sidebarSettingsRow()).toBe(true)
    } finally {
      await emulate(page(), null, false)
    }
  })

  it('W-4 the web page carries the viewport meta', async () => {
    const res = await httpProbe({ port: P, path: '/', host: `127.0.0.1:${P}` })
    expect(res.status).toBe(200)
    const html = res.body?.toString('utf8') ?? ''
    const meta = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)
    expect(meta, 'a viewport meta in the HTML').not.toBeNull()
    const tokens = meta![1].split(',').map((t) => t.trim())
    expect(tokens).toEqual(
      expect.arrayContaining([
        'width=device-width',
        'viewport-fit=cover',
        'interactive-widget=resizes-content'
      ])
    )
    expect(await mobile().viewportMeta()).toBe(meta![1])
  })

  it('D-1 the desktop main window stays desktop under a 390-wide emulation', async () => {
    const desk = webMobilePane(app.main)
    try {
      // mobile: false —— 主窗口没有 viewport meta，移动模式会按 980px 的缺省布局视口排，就不窄了
      await emulate(app.main, { ...PHONE, mobile: false }, true)
      expect(await app.main.eval<number>('innerWidth')).toBe(390)
      // 媒体查询有一拍才变：留一小段让「本不该发生的切换」有机会发生
      await sleep(500)
      expect(await desk.shellPresent()).toBe(false)
      expect(await desk.sidebarSettingsRow()).toBe(true)
      expect(await desk.viewportMeta()).toBeNull()
    } finally {
      await emulate(app.main, null, false)
    }
  })

  it('D-2 the desktop settings window stays the side-nav layout under a 390-wide emulation', async () => {
    const settings = await app.openSettings('general')
    try {
      await waitRendererReady(settings)
      await emulate(settings, { ...PHONE, mobile: false }, true)
      expect(await settings.eval<number>('innerWidth')).toBe(390)
      const pane = webMobilePane(settings)
      const style = await until(() => pane.settingsRowStyle(), 'a settings row in the window')
      await sleep(500)
      expect(await pane.settingsStacked()).toBe(false)
      expect((await pane.settingsRowStyle())?.flexWrap ?? style.flexWrap).toBe('nowrap')
    } finally {
      await emulate(settings, null, false).catch(() => undefined)
      settings.close()
    }
  })
})

/**
 * 一条用例失败在半路时把壳收拾回「会话页、什么都没开」—— 不然它留下的抽屉 / 菜单 / 对话页会把后面每一条都盖住，
 * 失败点离真因很远。每一步都是「开着才收」，用例正常走完时什么都不做
 */
/** 会话的 settings.enabledTools（主窗口 IPC 读） */
const enabledToolsOf = (sid: string): Promise<string[] | undefined> =>
  app.main.eval<string[] | undefined>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )

/** 等触屏选择抽屉上屏、滑入动画走完（连着两次量到同样的数） */
async function settledTouchSheet(name: 'model' | 'extensions'): Promise<TouchSheetShot> {
  let prev = ''
  return until(async () => {
    const shot = await mobile().touchSheet(name)
    // 升起动画没播完时量到的是中间一帧：动画头几帧位置不变，连着两次相同也不算落定
    if (!shot || shot.animating) return null
    const key = JSON.stringify(shot)
    if (key !== prev) {
      prev = key
      return null
    }
    return shot
  }, `the ${name} sheet settled`)
}

/** 收起开着的触屏选择抽屉（真点它的遮罩）—— resetShell 只认手机外壳自己的抽屉 */
async function closeTouchSheets(): Promise<void> {
  for (const name of await mobile().touchSheetNames()) {
    if (name !== 'model' && name !== 'extensions') continue
    await mobile().tap({ touchSheetBackdrop: name })
    await until(async () => (await mobile().touchSheet(name)) === null, `the ${name} sheet closed`)
  }
}

async function resetShell(): Promise<void> {
  if (!(await mobile().shellPresent())) return
  if (await webClientPane(page()).domMenu()) await mobile().pressEscape()
  await closeTouchSheets()
  const config = sessionConfigPane(page())
  if (await config.isOpen()) await config.close()
  if (await mobile().sheet()) {
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'reset: the sheet closed')
  }
  if (await mobile().chatOpen()) await backToList()
  await toTab('sessions')
}

/**
 * M-29 / M-30：MOB-actions 里从手机发出「Hi」、等脚本回复落定（已经有那条回复就什么都不做 —— 单跑 M-30 时由它补上）
 */
async function sendActionsTurn(): Promise<void> {
  const replied = (): Promise<boolean> =>
    app.main
      .eval<
        Array<{ role: string; content: string }>
      >(`window.api.message.list(${JSON.stringify(sids.actions)})`)
      .then((ms) => ms.some((m) => m.role === 'assistant' && m.content === ACTIONS_REPLY))
  if (await replied()) return
  const chat = chatPane(page())
  if (!(await mobile().chatOpen()) || (await mobile().chatTitle()) !== 'MOB-actions') {
    await openFromList('MOB-actions')
    await chat.ready()
  }
  await until(async () => !!(await mobile().composerLayout(MODEL))?.send, 'the idle composer')
  provider.script({ text: ACTIONS_REPLY, usage: USAGE })
  await mobile().typeTrusted(ACTIONS_ASK)
  await until(async () => (await mobile().composerValue()) === ACTIONS_ASK, 'Hi in the composer')
  await mobile().tap({ composer: 'send' })
  await until(replied, 'the reply to Hi')
  await chat.waitIdle()
}

/** 这个窗口里 MOB-actions 那条 remote 的「Hi」与回复卡的 data-msg-id（等它们都上屏） */
async function actionsIds(client: CdpClient): Promise<{ user: string; reply: string }> {
  const chat = chatPane(client)
  const ids = await until(async () => {
    const items = await chat.settledItems()
    const hi = items.find((i) => i.role === 'user' && i.text === ACTIONS_ASK)
    const reply = items.find((i) => i.role === 'assistant' && i.text.startsWith(ACTIONS_REPLY))
    const badge = (await chatOriginBadges(client)).find(
      (b) => b.role === 'user' && b.origin === 'remote'
    )
    return hi && reply && badge ? { user: hi.id, reply: reply.id, badge: badge.msgId } : null
  }, 'the Hi bubble (remote) and its reply on screen')
  expect(ids.badge, 'the remote label belongs to the Hi bubble').toBe(ids.user)
  return { user: ids.user, reply: ids.reply }
}

/** 来源标签在气泡右上方：meta 行右缘 = 气泡右缘、在气泡上面，里面最后一枚是 remote 且贴着右缘 */
function expectLabelAboveRight(shot: UserMessageShot, where: string): void {
  const what = `${where}: ${JSON.stringify(shot)}`
  expect(shot.meta, what).not.toBeNull()
  expect(shot.chip, what).not.toBeNull()
  expect(Math.abs(shot.meta!.right - shot.bubble.right), what).toBeLessThanOrEqual(1)
  expect(shot.meta!.bottom, what).toBeLessThanOrEqual(shot.bubble.top + 1)
  expect(shot.chip!.origin, what).toBe('remote')
  expect(Math.abs(shot.chip!.box.right - shot.meta!.right), what).toBeLessThanOrEqual(1)
}

/** 手指的尺寸：≥ 32×32（±1） */
function expectTouchSized(box: BoxShot, what: string): void {
  expect(box.width, `${what} width`).toBeGreaterThanOrEqual(31)
  expect(box.height, `${what} height`).toBeGreaterThanOrEqual(31)
}

function expectInViewport(box: BoxShot, viewport: { w: number; h: number }, what: string): void {
  const msg = `${what} inside ${JSON.stringify(viewport)}: ${JSON.stringify(box)}`
  expect(box.left, msg).toBeGreaterThanOrEqual(-0.5)
  expect(box.top, msg).toBeGreaterThanOrEqual(-0.5)
  expect(box.right, msg).toBeLessThanOrEqual(viewport.w + 0.5)
  expect(box.bottom, msg).toBeLessThanOrEqual(viewport.h + 0.5)
}

function expectSameBox(a: BoxShot, b: BoxShot, what: string): void {
  const msg = `${what}: ${JSON.stringify({ hovered: a, rest: b })}`
  for (const k of ['left', 'top', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - b[k]), `${msg} (${k})`).toBeLessThanOrEqual(0.5)
  }
}

describe('phone layout: the shell', () => {
  beforeAll(async () => {
    await phone()
  }, 120_000)

  afterEach(async () => {
    await resetShell().catch(() => undefined)
  }, 60_000)

  it('M-1 four tabs, the sessions tab current, only the sessions page mounted', async () => {
    expect(await mobile().tabs()).toEqual([
      { key: 'sessions', label: en.mobile.tabSessions, current: true },
      { key: 'widgets', label: en.mobile.tabWidgets, current: false },
      { key: 'library', label: en.mobile.tabLibrary, current: false },
      { key: 'settings', label: en.mobile.tabSettings, current: false }
    ])
    expect(en.mobile.tabSessions).toBe('Chats')
    expect(await mobile().mountedPages()).toEqual(['sessions'])
    expect(await mobile().chatOpen()).toBe(false)
  })

  it('M-2 tabs mount lazily, visited ones stay mounted, an expanded project group survives a round trip', async () => {
    expect(await mobile().listGroupExpanded(projects.main.name)).toBe(false)
    await mobile().tap({ listGroupToggle: projects.main.name })
    await until(
      async () => (await mobile().listGroupExpanded(projects.main.name)) === true,
      'MobProj expanded'
    )
    const order = ['widgets', 'library', 'settings', 'sessions'] as const
    const seen = new Set<string>(['sessions'])
    for (const key of order) {
      await mobile().tap({ tab: key })
      await until(async () => (await mobile().activeTab()) === key, `tab ${key} current`)
      seen.add(key)
      const tabs = await mobile().tabs()
      expect(
        tabs.filter((t) => t.current).map((t) => t.key),
        key
      ).toEqual([key])
      const mounted = await mobile().mountedPages()
      expect([...mounted].sort(), key).toEqual([...seen].sort())
      const displays = await mobile().pageDisplays()
      for (const [k, display] of Object.entries(displays)) {
        expect(display === 'none', `${k} while ${key} is current`).toBe(k !== key)
      }
    }
    expect(await mobile().mountedPages()).toEqual(['sessions', 'widgets', 'library', 'settings'])
    expect(await mobile().listGroupExpanded(projects.main.name)).toBe(true)
  })

  it('M-3 the sessions page has only the session groups and no desktop chrome', async () => {
    const groups = await mobile().groupsIn('sessions')
    expect(new Set(groups)).toEqual(new Set(['section', 'project', 'temp']))
    expect(await mobile().desktopChromeIn('sessions')).toEqual({
      settingsRow: false,
      dragStrip: false
    })
  })

  it('M-4 the library page has exactly the seven registry groups', async () => {
    expect(await mobile().groupsIn('library')).toEqual(REGISTRY_GROUPS)
  })

  it('M-5 a real tap on a row pushes the chat page and a marked history entry; no agent chip in its banner', async () => {
    const before = await mobile().history()
    expect(before.mark).toBe(false)
    await openFromList('MOB-chat')
    const chat = chatPane(page())
    await chat.ready()
    await until(async () => {
      const items = await chat.settledItems()
      return items.some((i) => i.role === 'assistant' && i.text === 'MOB-REPLY')
    }, 'the seeded reply on the chat page')
    expect(await mobile().tabsLayer()).toEqual({ ariaHidden: 'true', visibility: 'hidden' })
    expect(await mobile().history()).toEqual({ mark: true, length: before.length + 1 })
    expect(await mobile().chatAgentChip()).toBe(false)
    expect(await mobile().agentChipAnywhere()).toBe(false)
  })

  it('M-6 the back button pops the entry; history.back() closes the chat too, without a reload', async () => {
    await page().eval(`(window.__mobNoReload = 'm6')`)
    await openFromList('MOB-chat')
    expect((await mobile().history()).mark).toBe(true)
    await backToList()
    expect((await mobile().history()).mark).toBe(false)
    expect(await mobile().tabsLayer()).toEqual({ ariaHidden: 'false', visibility: 'visible' })

    await openFromList('MOB-chat')
    expect((await mobile().history()).mark).toBe(true)
    await page().eval(`(history.back(), true)`)
    await until(async () => !(await mobile().chatOpen()), 'history.back() closed the chat page')
    expect((await mobile().history()).mark).toBe(false)
    expect(await page().eval<string>(`window.__mobNoReload ?? ''`)).toBe('m6')
  })

  it('M-7 tapping the row of the already active session opens it again', async () => {
    await openFromList('MOB-chat')
    expect((await mobile().history()).mark).toBe(true)
    await backToList()
  })

  it('M-8 the calendar opens sessions (the active one too) and keeps its day and the list state across toggles', async () => {
    expect(await mobile().calendarToggleLabel()).toBe(en.mobile.calendar)
    expect(await mobile().calendarState()).toEqual({ mounted: false, visible: false })
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => (await mobile().calendarState()).visible, 'the calendar shown')
    expect(await mobile().calendarToggleLabel()).toBe(en.mobile.list)
    await until(async () => {
      const rows = await mobile().calendarRows()
      return rows.includes('MOB-temp') && rows.includes('MOB-chat')
    }, "today's sessions in the calendar")

    // 当天的另一条会话（不是活跃的）：点开
    await mobile().tap({ calendarRow: 'MOB-temp' })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatTitle()) === 'MOB-temp',
      'the chat page for MOB-temp from the calendar'
    )
    await backToList()
    expect((await mobile().calendarState()).visible).toBe(true)
    // 再点同一条（此刻它就是活跃会话）：照样推入
    await mobile().tap({ calendarRow: 'MOB-temp' })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatTitle()) === 'MOB-temp',
      'the active session reopened from the calendar'
    )
    await backToList()

    // 选另一天 → 切回列表 → 再切回日历：选中的日子还在；列表的展开状态也还在
    const today = await mobile().calendarSelectedDay()
    expect(today).not.toBeNull()
    const other = (await mobile().calendarDays()).find((d) => d !== today)
    expect(other, 'another day in this month').toBeDefined()
    await mobile().tap({ calendarDay: other! })
    await until(async () => (await mobile().calendarSelectedDay()) === other, `${other} selected`)
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => !(await mobile().calendarState()).visible, 'back to the list')
    expect(await mobile().calendarToggleLabel()).toBe(en.mobile.calendar)
    expect((await mobile().calendarState()).mounted).toBe(true)
    expect(await mobile().listGroupExpanded(projects.main.name)).toBe(true)
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => (await mobile().calendarState()).visible, 'the calendar again')
    expect(await mobile().calendarSelectedDay()).toBe(other)
    await mobile().tap({ sessions: 'calendarToggle' })
    await until(async () => !(await mobile().calendarState()).visible, 'the list again')
  })

  it('M-9 the new-chat sheet: temporary + every project; the backdrop creates nothing; a project creates one session there', async () => {
    await mobile().tap({ sessions: 'newChat' })
    const sheet = await until(() => mobile().sheet(), 'the new-chat sheet')
    expect(sheet.title).toBe(en.mobile.newChatIn)
    const targets = await mobile().newChatTargets()
    expect(targets[0]).toEqual({ id: '', label: en.mobile.tempChat })
    expect(new Set(targets.slice(1).map((t) => `${t.id}=${t.label}`))).toEqual(
      new Set([
        `${projects.main.id}=${projects.main.name}`,
        `${projects.other.id}=${projects.other.name}`
      ])
    )

    const countBefore = (await sessionsInMain()).length
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'the sheet closed by its backdrop')
    // 关掉之后不该再有任何动作：留一小段让「本不该发生的创建」有机会发生
    await sleep(800)
    expect((await sessionsInMain()).length).toBe(countBefore)
    expect(await mobile().chatOpen()).toBe(false)

    await mobile().tap({ sessions: 'newChat' })
    await until(() => mobile().sheet(), 'the new-chat sheet again')
    const added = await newSessionsAfter(app.main, () =>
      mobile().tap({ newChatTarget: projects.other.id })
    )
    await until(() => mobile().chatOpen(), 'the new session pushed')
    await sleep(800)
    const after = await sessionsInMain()
    expect(after.length).toBe(countBefore + 1)
    expect(added).toHaveLength(1)
    expect(after.find((s) => s.id === added[0])?.projectId).toBe(projects.other.id)
    expect(await mobile().sheet()).toBeNull()
    await backToList()
  })

  it('M-10 a bot row in the library opens its notebook on the chat page; back lands on the library; re-tapping it reopens', async () => {
    await mobile().tap({ tab: 'library' })
    await until(async () => (await mobile().activeTab()) === 'library', 'the library tab')
    await botsPane(page()).expand()
    await until(async () => (await botsPane(page()).rows()).includes(BOT), 'the bot row')
    await mobile().tap({ botRow: BOT })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatNotebook()),
      'the bot notebook on the chat page'
    )
    await backToList()
    expect(await mobile().activeTab()).toBe('library')
    expect((await mobile().pageDisplays()).library).not.toBe('none')
    // 此刻它正是活跃会话：再点一次照样推回对话页
    await mobile().tap({ botRow: BOT })
    await until(
      async () => (await mobile().chatOpen()) && (await mobile().chatNotebook()),
      'the bot notebook again after re-tapping the active row'
    )
    await backToList()
    await mobile().tap({ tab: 'sessions' })
    await until(async () => (await mobile().activeTab()) === 'sessions', 'the sessions tab')
  })

  it('M-11 the chat page has none of the desktop header buttons; the title opens the session config', async () => {
    await openFromList('MOB-chat')
    expect(await mobile().desktopHeaderControls()).toEqual({
      openBrowserWindow: false,
      sideToggles: 0
    })
    const config = sessionConfigPane(page())
    expect(await config.isOpen()).toBe(false)
    await mobile().tap({ chat: 'title' })
    await config.waitOpen()
    expect(await config.titleValue()).toBe('MOB-chat')
    await config.close()
  })

  it('M-12 the files sheet lists hello.txt and closes on its backdrop; the tasks sheet is the empty state', async () => {
    await openFromList('MOB-chat')
    await mobile().tap({ chat: 'files' })
    const listed = await until(async () => {
      const paths = await mobile().sheetFiles()
      return paths.some((p) => p === 'hello.txt' || p.endsWith('/hello.txt')) ? paths : null
    }, 'hello.txt in the files sheet')
    expect(listed.filter((p) => p.endsWith('hello.txt'))).toHaveLength(1)
    expect((await mobile().sheet())?.title).toBe(en.mobile.files)
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'the files sheet closed')

    await mobile().tap({ chat: 'tasks' })
    const tasks = await until(() => mobile().sheet(), 'the tasks sheet')
    expect(tasks.title).toBe(en.mobile.tasks)
    expect(await until(() => mobile().tasksEmpty(), 'the empty tasks state')).toBe(
      en.mobile.noTasks
    )
    await mobile().tap({ sheetBackdrop: true })
    await until(async () => (await mobile().sheet()) === null, 'the tasks sheet closed')
    expect(await mobile().chatOpen()).toBe(true)
    await backToList()
  })

  it('M-13 deleting the session from its config closes the chat, drops the row and pops the history mark', async () => {
    await openFromList('MOB-doomed')
    expect((await mobile().history()).mark).toBe(true)
    await mobile().tap({ chat: 'title' })
    const config = sessionConfigPane(page())
    await config.waitOpen()
    expect(await config.titleValue()).toBe('MOB-doomed')
    await config.clickDelete()
    await until(async () => !(await mobile().chatOpen()), 'the chat page closed after the delete')
    await until(
      async () => !(await mobile().listRows()).includes('MOB-doomed'),
      'the row gone from the list'
    )
    expect((await sessionsInMain()).some((s) => s.id === sids.doomed)).toBe(false)
    expect((await mobile().history()).mark).toBe(false)
    expect(await config.isOpen()).toBe(false)
  })

  it('M-14 a widget card opens in a new tab on a tap; a long press shows the card menu', async () => {
    const cards = widgetPanelPane(page())
    await mobile().tap({ tab: 'widgets' })
    await until(async () => (await cards.cardIds()).includes(WIDGET_ID), 'the widget card')
    const tabUrl = `http://127.0.0.1:${P}/#widget-window?widgetId=${WIDGET_ID}`
    await mobile().tap({ widgetCard: WIDGET_ID })
    const tab = await waitBrowserTab(app, (u) => u === tabUrl, 'the #widget-window tab')
    openedTabs.add(tab.id)
    expect(await cards.panelApps()).toEqual([])
    expect(await cards.foregroundApp()).toBeNull()
    await closeBrowserTab(app, tab.id)
    openedTabs.delete(tab.id)

    const tabsBefore = (await browserTabs(app)).map((t) => t.id).sort()
    await mobile().longPress({ widgetCard: WIDGET_ID }, 800)
    const menu = await until(() => webClientPane(page()).domMenu(), 'the card menu')
    const labels = menu.map((m) => m.label)
    expect(labels).not.toContain(en.widgets.openInPanel)
    // 「停止」在不在取决于那个标签页把它注册上了没有；除此之外恰是这四项（也就没有整理图标）
    expect(labels.filter((l) => l !== en.widgets.stop)).toEqual([
      en.widgets.openInWindow,
      en.widgets.exportAsVite,
      en.widgets.archive,
      en.widgets.delete
    ])
    await sleep(500)
    expect((await browserTabs(app)).map((t) => t.id).sort()).toEqual(tabsBefore)
    expect(await cards.panelApps()).toEqual([])
    await mobile().pressEscape()
    await until(async () => (await webClientPane(page()).domMenu()) === null, 'the menu closed')
  })

  it('M-14b a tap on the top-right corner of a card opens it like a tap in the middle (no hidden hover buttons)', async () => {
    const cards = widgetPanelPane(page())
    const registered = async (): Promise<string[]> =>
      (await app.main.eval<{ registeredIds?: string[] }>('window.api.widget.getServerStatus()'))
        .registeredIds ?? []
    // afterEach 的 resetShell 把壳放回了会话页
    await toTab('widgets')
    await until(async () => (await cards.cardIds()).includes(WIDGET_ID), 'the widget card')
    const tabUrl = `http://127.0.0.1:${P}/#widget-window?widgetId=${WIDGET_ID}`
    // 那一点正是悬浮按钮（删除）所在的地方：按钮在触屏上不接点击，点下去的是卡片
    expect(await cards.cornerButton(WIDGET_ID)).not.toBeNull()
    const tabsBefore = (await browserTabs(app)).map((t) => t.id)
    await mobile().tap({ widgetCardCorner: WIDGET_ID })
    const tab = await waitBrowserTab(
      app,
      (u) => u === tabUrl,
      'the #widget-window tab from the corner'
    )
    openedTabs.add(tab.id)
    expect(tabsBefore).not.toContain(tab.id)
    // 那个标签页把它注册上了，之后没有被停掉
    await until(async () => (await registered()).includes(WIDGET_ID), 'the widget registered')
    await sleep(300)
    expect((await confirmPane(page()).snapshot()).open).toBe(false)
    expect(
      await app.main.eval<string[]>(
        'window.api.widget.listArchived().then((l) => l.map((w) => w.id))'
      )
    ).not.toContain(WIDGET_ID)
    expect(
      await app.main.eval<string[]>('window.api.widget.list().then((l) => l.map((w) => w.id))')
    ).toContain(WIDGET_ID)
    expect(await registered()).toContain(WIDGET_ID)
    expect(await cards.panelApps()).toEqual([])
    await closeBrowserTab(app, tab.id)
    openedTabs.delete(tab.id)
  })

  it('M-15 settings: the section list, a section with a back button and wrapping rows, the agents monitor section', async () => {
    await mobile().tap({ tab: 'settings' })
    const list = await until(async () => {
      const tabs = await mobile().settingsTabs()
      return tabs.length > 0 ? tabs : null
    }, 'the settings section list')
    expect(list.map((t) => t.id)).toEqual([
      'general',
      'providers',
      'tools',
      'mcp',
      'voice',
      'triggers',
      'telegramBots',
      'monitor',
      'archived',
      'about',
      'agents'
    ])
    expect(en.experimental.tag).toBe('Beta')
    expect(Object.fromEntries(list.map((t) => [t.id, t.experimental]))).toMatchObject({
      general: null,
      voice: en.experimental.tag,
      triggers: en.experimental.tag,
      telegramBots: en.experimental.tag,
      agents: null
    })
    expect(list.filter((t) => t.experimental).map((t) => t.id)).toEqual([
      'voice',
      'triggers',
      'telegramBots'
    ])
    expect(list.find((t) => t.id === 'general')?.label).toBe(en.settings.tabGeneral)
    expect(await mobile().settingsBackButton()).toBeNull()

    await mobile().tap({ settingsTab: 'general' })
    await until(
      async () => (await mobile().settingsHeader()) === en.settings.tabGeneral,
      'the General section'
    )
    expect(await mobile().settingsBackButton()).toEqual({
      text: en.settings.title,
      ariaLabel: en.settings.title,
      level: 'section'
    })
    expect(await mobile().settingsTabs()).toEqual([])
    const row = await until(() => mobile().settingsRowStyle(), 'a settings row in General')
    expect(row.flexWrap).toBe('wrap')
    expect(parseFloat(row.titleMinWidth)).toBeCloseTo(9 * parseFloat(row.titleFontSize), 1)

    await mobile().tap({ settingsBack: true })
    await until(async () => (await mobile().settingsTabs()).length === 11, 'the list again')
    expect(await mobile().settingsHeader()).toBeNull()

    await mobile().tap({ settingsTab: 'agents' })
    await until(async () => (await mobile().settingsHeader()) === en.panel.agents, 'Agents')
    expect(en.panel.agents).toBe('Agents')
    await mobile().tap({ settingsBack: true })
    await until(async () => (await mobile().settingsTabs()).length === 11, 'the list again')
    await mobile().tap({ tab: 'sessions' })
    await until(async () => (await mobile().activeTab()) === 'sessions', 'the sessions tab')
  })

  it('M-16 #settings/general on a phone opens the section directly; #settings is the list; 1280 is not stacked', async () => {
    const url = `http://127.0.0.1:${P}/#settings/general`
    const tabId = await app.main.eval<string>(
      `window.api.browserView.createTab(${JSON.stringify(url)})`
    )
    openedTabs.add(tabId)
    const settings = await until(
      () => connectTabPage(app.port, (u) => u === url),
      'the #settings/general tab'
    )
    try {
      await until(
        () => settings.eval<boolean>(`window.api?.app?.platform === 'web'`),
        'the settings tab is the web client'
      )
      await waitRendererReady(settings)
      const pane = webMobilePane(settings)
      await emulate(settings, PHONE, true)
      await reload(settings)
      await until(
        async () => (await pane.settingsHeader()) === en.settings.tabGeneral,
        'straight into General'
      )
      expect(await pane.settingsBackButton()).not.toBeNull()
      expect(await pane.shellPresent()).toBe(false)
      await pane.tap({ settingsBack: true })
      const list = await until(async () => {
        const tabs = await pane.settingsTabs()
        return tabs.length > 0 ? tabs : null
      }, 'the section list after Back')
      expect(list[0].id).toBe('general')
      expect(list.some((t) => t.id === 'agents')).toBe(false)

      await settings.eval(`(location.hash = '#settings', true)`)
      await reload(settings)
      await until(async () => (await pane.settingsTabs()).length > 0, '#settings opens the list')
      expect(await pane.settingsBackButton()).toBeNull()

      await emulate(settings, null, false)
      await until(async () => !(await pane.settingsStacked()), 'not stacked at 1280')
    } finally {
      settings.close()
      await closeBrowserTab(app, tabId)
      openedTabs.delete(tabId)
    }
  })

  it('M-17 real touches: a hold is a menu (once), a tap opens, a 30px move cancels, a 5px move does not; library agents too', async () => {
    const pane = mobile()
    const dom = webClientPane(page())
    expect(await pane.activeTab()).toBe('sessions')
    await pane.installContextMenuCounter()

    await pane.longPress({ sessionRow: 'MOB-temp' }, 800)
    await until(() => dom.domMenu(), 'the row menu after a hold')
    await sleep(300)
    expect(await pane.chatOpen()).toBe(false)
    expect(await pane.contextMenuCount()).toBe(1)
    await pane.pressEscape()
    await until(async () => (await dom.domMenu()) === null, 'the menu closed')

    // 关掉菜单之后的下一次轻点照常推入
    await pane.tap({ sessionRow: 'MOB-temp' }, { holdMs: 100 })
    await until(() => pane.chatOpen(), 'a 100ms tap opens the chat')
    await backToList()

    await pane.installContextMenuCounter()
    await pane.longPress({ sessionRow: 'MOB-temp' }, 800, { dx: 30, dy: 0 })
    await sleep(500)
    expect(await dom.domMenu()).toBeNull()
    expect(await pane.contextMenuCount()).toBe(0)

    await pane.longPress({ sessionRow: 'MOB-temp' }, 800, { dx: 5, dy: 0 })
    await until(() => dom.domMenu(), 'the row menu after a 5px wobble')
    expect(await pane.contextMenuCount()).toBe(1)
    expect(await pane.chatOpen()).toBe(false)
    await pane.pressEscape()
    await until(async () => (await dom.domMenu()) === null, 'the menu closed again')
    await pane.tap({ sessionRow: 'MOB-temp' })
    await until(() => pane.chatOpen(), 'the next tap opens the chat')
    await backToList()

    // 资料库里内置智能体的行：按住 → 它的菜单（创建覆盖副本）
    await pane.tap({ tab: 'library' })
    await until(async () => (await pane.activeTab()) === 'library', 'the library tab')
    const agents = agentsSidebarPane(page())
    await agents.expand()
    const builtin = await until(async () => {
      const rows = await agents.builtinRows()
      return rows.length > 0 ? rows[0] : null
    }, 'a builtin agent row')
    await pane.longPress({ agentBuiltinRow: builtin.name }, 800)
    const menu = await until(() => dom.domMenu(), 'the builtin agent row menu')
    expect(menu.map((m) => m.label)).toContain(en.tool.subAgentCreateOverride)
    expect(await pane.chatOpen()).toBe(false)
    await pane.pressEscape()
    await until(async () => (await dom.domMenu()) === null, 'the agent menu closed')
    await pane.tap({ tab: 'sessions' })
    await until(async () => (await pane.activeTab()) === 'sessions', 'the sessions tab')
  })

  it('M-18 focus mode (on by default) dims nothing in the shell; the desktop layout dims', async () => {
    await openFromList('MOB-chat')
    await backToList()
    expect(await mobile().dimmedCount('shell')).toBe(0)
    try {
      await desktopView()
      await until(
        async () => (await mobile().dimmedCount('document')) > 0,
        'focus mode dims the desktop sidebar'
      )
    } finally {
      await phone()
    }
  })

  it('M-19 16px composer in the shell (not at 1280); one row rhythm, touch-sized on the phone, 24px on the desktop', async () => {
    // M-18 重载过：项目组又是收起的，输入框这一半用临时组里的那一条
    await openFromList('MOB-temp')
    await chatPane(page()).ready()
    expect(await mobile().composerFontSize()).toBe('16px')
    await backToList()

    // 会话行、项目组头、「项目知识库」文件夹行同一个高度（手机上不再单独加高会话行）
    await mobile().tap({ listGroupToggle: projects.main.name })
    await until(
      async () => (await mobile().listGroupExpanded(projects.main.name)) === true,
      'MobProj expanded'
    )
    // 展开动画走完、三行都上屏且连着两次量到同样的数
    let prev = ''
    const rhythm = await until(async () => {
      const r = await mobile().listGroupRhythm(projects.main, 'MOB-chat')
      if (r.header === null || r.knowledge === null || r.row === null) return null
      const key = JSON.stringify(r)
      if (key !== prev) {
        prev = key
        return null
      }
      return { header: r.header, knowledge: r.knowledge, row: r.row }
    }, 'the MobProj header, its knowledge folder and the MOB-chat row measured')
    expect(Math.abs(rhythm.row - rhythm.header), JSON.stringify(rhythm)).toBeLessThanOrEqual(2)
    expect(Math.abs(rhythm.row - rhythm.knowledge), JSON.stringify(rhythm)).toBeLessThanOrEqual(2)
    expect(Math.abs(rhythm.header - rhythm.knowledge), JSON.stringify(rhythm)).toBeLessThanOrEqual(
      2
    )
    expect(rhythm.row).toBeGreaterThanOrEqual(40)
    const phoneTemp = await mobile().sessionRowHeight('MOB-temp', 'list')
    expect(phoneTemp).not.toBeNull()

    await desktopView()
    await chatPane(page()).ready()
    const desktopFont = await mobile().composerFontSize()
    expect(desktopFont).not.toBeNull()
    expect(desktopFont).not.toBe('16px')
    // 桌面侧栏里同一条会话行：同一副排版的桌面那一档（Finder 侧栏的 24px）
    const desktopTemp = await until(
      () => mobile().sessionRowHeight('MOB-temp', 'document'),
      'the MOB-temp row in the desktop sidebar'
    )
    expect(phoneTemp!).toBeGreaterThanOrEqual(40)
    expect(Math.abs(desktopTemp - 24)).toBeLessThanOrEqual(1)
  })

  it('M-20 popstate closes the chat only onto an unmarked entry; a mark left behind by a reload is cleared', async () => {
    await phone()
    await openFromList('MOB-temp')
    // 退回到的那一条还带着标记（页面里的前进 / 后退）：对话页还该开着
    await page().eval(`(history.pushState({ shuvixMobileChat: true }, ''), true)`)
    await page().eval(`(history.back(), true)`)
    await until(async () => (await mobile().history()).mark, 'back on the marked entry')
    await sleep(500)
    expect(await mobile().chatOpen()).toBe(true)
    await backToList()
    expect((await mobile().history()).mark).toBe(false)

    // 对话页开着时重载：那条带标记的历史还在、对话页已经不在 —— 标记摘掉，之后不用多退一次
    await openFromList('MOB-temp')
    expect((await mobile().history()).mark).toBe(true)
    await reload(page())
    await until(() => mobile().shellPresent(), 'the shell after the reload')
    expect(await mobile().chatOpen()).toBe(false)
    expect((await mobile().history()).mark).toBe(false)
    await listSettled()
    await openFromList('MOB-temp')
    await backToList()
    expect((await mobile().history()).mark).toBe(false)
  })

  it('M-21 a 360-wide card keeps send / queue / stop inside; the model name gives way', async () => {
    const chat = chatPane(page())
    const layout = (): Promise<ComposerLayoutShot | null> => mobile().composerLayout(LONG)
    try {
      await emulate(page(), NARROW, true)
      await until(
        async () => (await page().eval<number>('innerWidth')) === NARROW.width,
        'the page at 360 wide'
      )
      expect(await mobile().shellPresent()).toBe(true)
      await openFromList('MOB-narrow')
      await chat.ready()

      // 空闲（还没有运行时）
      const idle = await until(async () => {
        const s = await layout()
        return s?.modelName && s.send && s.ring ? s : null
      }, 'the idle composer showing the long model')
      expectInside(idle.send, idle.card, 'send (idle)')
      expectTruncated(idle.modelName, 'the model name (idle)')

      // 运行中（2026-10-26 起两个选择器不再上锁）。触屏的回车是换行：用发送键发
      provider.script({ text: 'MOB-NARROW-REPLY', holdMs: 20_000, usage: USAGE })
      await chat.type('narrow ask')
      await chat.clickSend()
      // 没打字时只有停止（触屏只出一颗「立即」，没字可发就不出）
      const empty = await until(async () => {
        if (!(await chat.isBusy())) return null
        const s = await layout()
        return s?.stop ? s : null
      }, 'the running composer: stop only')
      expect(empty.queue, JSON.stringify(widthsOf(empty))).toEqual([])
      expectInside(empty.stop, empty.card, 'stop (nothing typed)')
      // 打了字：「立即」+ 停止（最挤的样子）
      await chat.type('narrow steer')
      const running = await until(async () => {
        const s = await layout()
        return s && s.queue.length === 1 && s.stop ? s : null
      }, 'the running composer: steer, stop')
      const what = JSON.stringify(widthsOf(running))
      const [steer] = running.queue
      expect(steer.tier).toBe('steer')
      expect(steer.labelDisplay, 'the touch steer button has no label').toBeNull()
      expect(steer.ariaLabel).toBe(en.queue.steer)
      expect(steer.title).toBe(en.queue.touchSendHint)
      expectInside(steer.box, running.card, 'queue steer')
      expect(steer.box.width, 'touch-sized steer').toBeGreaterThanOrEqual(36)
      expectInside(running.stop, running.card, 'stop')
      expect(running.stop!.width, 'touch-sized stop').toBeGreaterThanOrEqual(36)
      expectInside(running.ring, running.card, 'the context ring')
      expect(running.ring!.width).toBeCloseTo(15, 0)
      // 谁都不压到谁身上：扩展选择器在用量环那一格左边，模型触发器在扩展选择器左边
      expect(running.toolPicker, what).not.toBeNull()
      expect(running.modelTrigger, what).not.toBeNull()
      const ringLeft = (running.ringItem ?? running.ring)!.left
      expect(running.toolPicker!.right, what).toBeLessThanOrEqual(ringLeft + 0.5)
      expect(running.modelTrigger!.right, what).toBeLessThanOrEqual(running.toolPicker!.left + 0.5)
      expectInside(running.modelTrigger, running.card, 'the model trigger')
      expect(running.modelName!.box.width, what).toBeLessThan(120)
      expectTruncated(running.modelName, 'the model name (running)')
      expect(running.page.docScrollWidth).toBeLessThanOrEqual(running.page.innerWidth)
      expect(running.page.shellScrollWidth).not.toBeNull()
      expect(running.page.shellScrollWidth!).toBeLessThanOrEqual(running.page.shellClientWidth!)
      // 真长按（手机外壳把按住半秒变成 contextmenu）：两档都在菜单里，带字
      await mobile().longPress({ composer: 'steer' }, 800)
      const menu = await until(async () => {
        const s = await layout()
        return s && s.queue.length === 3 ? s : null
      }, 'the long-press queue menu')
      expect(menu.queue.slice(1).map((q) => [q.tier, q.labelText])).toEqual([
        ['steer', en.queue.steer + en.queue.steerHint],
        ['followUp', en.queue.followUp + en.queue.followUpHint]
      ])
      // 清掉字：菜单与「立即」一起收起，只剩停止
      await chat.type('')
      await until(
        async () => (await layout())?.queue.length === 0,
        'the queue menu gone with the text'
      )

      // 跑完：发送键回来，仍在卡片里（这时用量环已有数字，比开头的空闲态更挤）
      provider.release()
      await chat.waitIdle()
      const after = await until(async () => {
        const s = await layout()
        return s?.send ? s : null
      }, 'the idle composer after the run')
      expectInside(after.send, after.card, 'send (after the run)')
      expectInside(after.ring, after.card, 'the context ring (after the run)')
      expect(after.toolPicker!.right).toBeLessThanOrEqual(
        (after.ringItem ?? after.ring)!.left + 0.5
      )
      expect(after.modelTrigger!.right).toBeLessThanOrEqual(after.toolPicker!.left + 0.5)
      expectTruncated(after.modelName, 'the model name (after the run)')

      // 1280 宽：模型名封顶 120px、不缩；运行中队列出口带字
      await desktopView()
      await chat.ready()
      const wide = await until(async () => {
        const s = await layout()
        return s?.modelName && s.send ? s : null
      }, 'the desktop composer showing the long model')
      expect(wide.modelName!.box.width).toBeCloseTo(120, 0)
      provider.script({ text: 'MOB-WIDE-REPLY', holdMs: 20_000, usage: USAGE })
      await chat.typeAndSend('wide ask')
      const wideRunning = await until(async () => {
        if (!(await chat.isBusy())) return null
        const s = await layout()
        return s && s.queue.length === 2 ? s : null
      }, 'the desktop composer running')
      expect(wideRunning.toolbarWidth).toBeGreaterThanOrEqual(26 * 16)
      for (const q of wideRunning.queue) {
        const tier = q.tier as 'steer' | 'followUp'
        expect(q.labelDisplay, `${tier} label at 1280`).not.toBe('none')
        expect(q.labelText).toBe(en.queue[tier])
        expectInside(q.box, wideRunning.card, `queue ${tier} at 1280`)
      }
      provider.release()
      await chat.waitIdle()
    } finally {
      provider.release()
      await phone()
    }
  })

  it('M-22 a long multi-paragraph thought collapses to one line and reserves nothing below it', async () => {
    const chat = chatPane(page())
    await openFromList('MOB-think')
    await chat.ready()
    await until(async () => {
      const replies = (await chat.settledItems())
        .filter((i) => i.role === 'assistant')
        .map((i) => i.text)
      return (
        replies.includes('MOB-THINK-1') &&
        replies.includes('MOB-THINK-2') &&
        (await chat.thinkingBlocks()) === 2
      )
    }, 'both thinking cards on the chat page')
    const shotOf = async (reply: string): Promise<ThinkingBlockShot | null> =>
      (await mobile().thinkingShots()).find((t) => t.reply === reply) ?? null

    // 连着两次量到同样的数（列表落位、字体载入之后）
    let prev = ''
    const [short, long] = await until(async () => {
      const a = await shotOf('MOB-THINK-1')
      const b = await shotOf('MOB-THINK-2')
      // Virtuoso 把列表藏着（visibility: hidden）直到落到初始位置：落位之前量的不是用户看到的
      if (!a?.visible || !b?.visible) return null
      const key = JSON.stringify([a, b])
      if (key !== prev) {
        prev = key
        return null
      }
      return [a, b] as const
    }, 'both thinking blocks on screen and measured')
    const what = JSON.stringify({
      short,
      long: { ...long, innerText: long.innerText.slice(0, 40) }
    })
    expect(short.expanded).toBe(false)
    expect(long.expanded).toBe(false)
    expect(Math.abs(long.height - short.height), what).toBeLessThanOrEqual(1)
    expect(long.height, what).toBeLessThanOrEqual(30)
    expect(short.gap, what).not.toBeNull()
    expect(long.gap, what).not.toBeNull()
    // 回归点：折叠的长思考下面不留位
    expect(Math.abs(long.gap! - short.gap!), what).toBeLessThanOrEqual(1)
    expect(long.whiteSpace).toBe('nowrap')
    expect(long.textOverflow).toBe('ellipsis')
    expect(long.scrollWidth, what).toBeGreaterThan(long.clientWidth)

    await mobile().clickThinking('MOB-THINK-2')
    const open = await until(async () => {
      const t = await shotOf('MOB-THINK-2')
      return t?.expanded && t.visible ? t : null
    }, 'the long thought expanded')
    expect(open.height).toBeGreaterThan(3 * short.height)
    expect(open.innerText.startsWith('Paragraph 1 opens here'), open.innerText.slice(0, 60)).toBe(
      true
    )
    expect(open.innerText.endsWith('until paragraph 5 closes.'), open.innerText.slice(-60)).toBe(
      true
    )
    expect(open.innerText).toContain('\n\n')

    await mobile().clickThinking('MOB-THINK-2')
    const closed = await until(async () => {
      const t = await shotOf('MOB-THINK-2')
      return t && !t.expanded && t.visible ? t : null
    }, 'the long thought collapsed again')
    expect(Math.abs(closed.height - short.height)).toBeLessThanOrEqual(1)
  })

  it('M-24 wide content (a long mixed step group, long links, long code) does not make the chat scroll sideways', async () => {
    const chat = chatPane(page())
    try {
      await emulate(page(), NARROW, true)
      await until(
        async () => (await page().eval<number>('innerWidth')) === NARROW.width,
        'the page at 360 wide'
      )
      // 会话在项目组里：单跑这一条时组还收着（M-2 起整份文件跑的时候已经展开）
      await toTab('sessions')
      if ((await mobile().listGroupExpanded(projects.main.name)) === false) {
        await mobile().tap({ listGroupToggle: projects.main.name })
        await until(
          async () => (await mobile().listGroupExpanded(projects.main.name)) === true,
          'the project group expanded'
        )
      }
      await openFromList('MOB-wide')
      await chat.ready()
      await until(async () => {
        const replies = (await chat.settledItems()).filter((i) => i.role === 'assistant')
        return replies.some((r) => r.text.startsWith('MOB-WIDE-REPLY'))
      }, 'the wide reply on the chat page')
      // 前提：六次调用都成功、并成了一行（失败的调用不并，标签就没这么长）
      expect(await chat.stepGroups()).toEqual([
        expect.objectContaining({ state: 'collapsed', size: 6 })
      ])

      // 连着两次量到同样的数（列表落位、字体载入、代码高亮之后）
      const settled = async (what: string): Promise<ConversationOverflowShot> => {
        let prev = ''
        return until(async () => {
          const shot = await mobile().conversationOverflow()
          if (!shot) return null
          const key = JSON.stringify(shot)
          if (key !== prev) {
            prev = key
            return null
          }
          return shot
        }, what)
      }
      const expectNoSideways = (shot: ConversationOverflowShot, what: string): void => {
        const msg = `${what}: ${JSON.stringify(shot)}`
        expect(shot.offenders, msg).toEqual([])
        expect(shot.scrollWidth, msg).toBeLessThanOrEqual(shot.clientWidth)
        expect(shot.docScrollWidth, msg).toBeLessThanOrEqual(shot.innerWidth)
      }

      expectNoSideways(await settled('the collapsed card measured'), 'collapsed')
      const row = await mobile().stepGroupRow()
      expect(row, 'the step group row').not.toBeNull()
      expect(row!.labelScrollWidth, JSON.stringify(row)).toBeGreaterThan(row!.labelClientWidth)
      expect(row!.count.right, JSON.stringify(row)).toBeLessThanOrEqual(row!.row.right + 0.5)

      await chat.expandGroups()
      await until(
        async () => (await chat.stepGroups())[0]?.state === 'expanded',
        'the step group expanded'
      )
      expectNoSideways(await settled('the expanded card measured'), 'expanded')
    } finally {
      await phone()
    }
  })

  it('M-25 touch-sized composer controls at 390 and 360; a tap on the ring shows its numbers; 1280 keeps the compact row', async () => {
    const chat = chatPane(page())
    const layout = (): Promise<ComposerLayoutShot | null> => mobile().composerLayout(MODEL)
    try {
      await openFromList('MOB-composer')
      await chat.ready()
      for (const metrics of [PHONE, NARROW]) {
        if (metrics !== PHONE) {
          await emulate(page(), metrics, true)
          await until(
            async () => (await page().eval<number>('innerWidth')) === metrics.width,
            `the page at ${metrics.width} wide`
          )
          expect(await mobile().shellPresent()).toBe(true)
        }
        const idle = await until(async () => {
          const s = await layout()
          return s?.attach && s.modelPill && s.extensions?.count && s.send && s.ring ? s : null
        }, `the idle touch composer at ${metrics.width}`)
        const what = `${metrics.width}: ${JSON.stringify(idle)}`
        const controls: Array<[string, BoxShot]> = [
          ['attach', idle.attach!],
          ['model pill', idle.modelPill!.box],
          ['extensions pill', idle.extensions!.box],
          ['send', idle.send!]
        ]
        for (const [name, b] of controls) {
          expect(b.height, `${name} height ${what}`).toBeGreaterThanOrEqual(36)
          expectInside(b, idle.card, `${name} at ${metrics.width}`)
        }
        expect(idle.attach!.width, `attach width ${what}`).toBeGreaterThanOrEqual(36)
        expect(idle.send!.width, `send width ${what}`).toBeGreaterThanOrEqual(36)
        // 从左到右「+」< 模型 < 扩展，互不压
        expect(idle.attach!.right, what).toBeLessThanOrEqual(idle.modelPill!.box.left + 0.5)
        expect(idle.modelPill!.box.right, what).toBeLessThanOrEqual(idle.extensions!.box.left + 0.5)
        // 工具行窄于 28rem：胶囊里只剩拼图 + 计数
        expect(idle.extensions!.labelDisplay, what).toBe('none')
        expect(idle.extensions!.count, what).toMatch(/^\d+$/)
        expect(idle.extensions!.countBox!.width, what).toBeGreaterThan(0)
        expectInside(
          idle.extensions!.countBox,
          idle.card,
          `the extension count at ${metrics.width}`
        )
        expect(idle.attachInputDisplay, what).toBe('none')
        expect(idle.page.docScrollWidth, what).toBeLessThanOrEqual(idle.page.innerWidth)
        expect(idle.page.shellScrollWidth, what).not.toBeNull()
        expect(idle.page.shellScrollWidth!, what).toBeLessThanOrEqual(idle.page.shellClientWidth!)

        // 用量环：手机没有悬停，点一下出数字、再点收起
        expect(idle.ringTooltip?.display, what).toBe('none')
        await mobile().tap({ composer: 'ring' })
        const open = await until(async () => {
          const s = await layout()
          return s?.ringTooltip?.display === 'block' ? s : null
        }, `the ring numbers shown at ${metrics.width}`)
        const tip = open.ringTooltip!.box
        const tipWhat = `${metrics.width}: ${JSON.stringify(open.ringTooltip)}`
        expect(tip.width, tipWhat).toBeGreaterThan(0)
        expect(tip.left, tipWhat).toBeGreaterThanOrEqual(-0.5)
        expect(tip.top, tipWhat).toBeGreaterThanOrEqual(-0.5)
        expect(tip.right, tipWhat).toBeLessThanOrEqual(open.page.innerWidth + 0.5)
        expect(tip.bottom, tipWhat).toBeLessThanOrEqual(
          (await page().eval<number>('innerHeight')) + 0.5
        )
        await mobile().tap({ composer: 'ring' })
        await until(
          async () => (await layout())?.ringTooltip?.display === 'none',
          `the ring numbers hidden again at ${metrics.width}`
        )
      }

      // 1280 宽（桌面布局）：「+」是 24px 的小钮，扩展入口没有计数，模型面板是下拉而不是抽屉
      await desktopView()
      await chat.ready()
      const wide = await until(async () => {
        const s = await layout()
        return s?.attach && s.modelPill ? s : null
      }, 'the desktop composer')
      const wideWhat = JSON.stringify(wide)
      expect(Math.abs(wide.attach!.width - 24), wideWhat).toBeLessThanOrEqual(1)
      expect(Math.abs(wide.attach!.height - 24), wideWhat).toBeLessThanOrEqual(1)
      expect(wide.extensions?.count ?? null, wideWhat).toBeNull()
      await mobile().composerClick('model')
      const panel = await until(() => mobile().modelPanel(), 'the desktop model panel')
      expect(panel).toEqual({ position: 'fixed', inTouchSheet: false })
      expect(await mobile().touchSheetNames()).toEqual([])
      await mobile().composerClick('model')
      await until(async () => (await mobile().modelPanel()) === null, 'the model panel closed')
    } finally {
      await phone()
    }
  })

  it('M-26 the model sheet: inside the viewport, 44px rows, a 16px search that does not take focus; its backdrop closes only the sheet', async () => {
    const config = sessionConfigPane(page())
    const layout = (): Promise<ComposerLayoutShot | null> => mobile().composerLayout(MODEL)
    const pillText = async (): Promise<string | null> => (await layout())?.modelPill?.text ?? null
    const row = (model: string): string => `${fakeProviderId}/${model}`
    try {
      await openFromList('MOB-composer')
      await chatPane(page()).ready()
      await until(async () => (await pillText()) === MODEL, 'the model pill showing the model')

      await mobile().tap({ composer: 'model' })
      const sheet = await settledTouchSheet('model')
      const what = JSON.stringify(sheet)
      expect(sheet.dialog.top, what).toBeGreaterThanOrEqual(-0.5)
      expect(Math.abs(sheet.dialog.bottom - sheet.innerHeight), what).toBeLessThanOrEqual(1)
      expect(Math.abs(sheet.dialog.left), what).toBeLessThanOrEqual(0.5)
      expect(Math.abs(sheet.dialog.right - sheet.innerWidth), what).toBeLessThanOrEqual(0.5)
      expect(sheet.dialog.height, what).toBeLessThanOrEqual(0.8 * sheet.innerHeight + 1)
      expect(sheet.search, what).toEqual({ fontSize: '16px', focused: false })
      expect(
        sheet.rows.map((r) => r.id),
        what
      ).toContain(row(MODEL))
      for (const r of sheet.rows) expect(r.height, `${r.id} ${what}`).toBeGreaterThanOrEqual(44)

      // 遮罩离顶 40px 那一点压在对话页的标题上：只关抽屉，不点穿到标题（那会开会话设置）
      expect(await config.isOpen()).toBe(false)
      await mobile().tap({ touchSheetBackdrop: 'model' })
      await until(
        async () => (await mobile().touchSheet('model')) === null,
        'the model sheet closed'
      )
      await sleep(400)
      expect(await mobile().chatOpen()).toBe(true)
      expect(await mobile().chatTitle()).toBe('MOB-composer')
      expect(await config.isOpen()).toBe(false)

      // 第二个模型（beforeAll 在同一家提供商下加的 LONG）：换过去，胶囊跟着；再换回来
      expect(
        sheet.rows.map((r) => r.id),
        'a second model in the sheet'
      ).toContain(row(LONG))
      for (const model of [LONG, MODEL]) {
        await mobile().tap({ composer: 'model' })
        await settledTouchSheet('model')
        await mobile().tap({ touchSheetItem: row(model) })
        await until(
          async () => (await mobile().touchSheet('model')) === null,
          `the sheet closed after picking ${model}`
        )
        await until(async () => (await pillText()) === model, `the pill showing ${model}`)
      }
    } finally {
      await closeTouchSheets()
      if ((await pillText().catch(() => null)) !== MODEL) {
        await app.main.eval(
          `window.api.agent.setModel(${JSON.stringify({ sessionId: sids.composer, provider: fakeProviderId, model: MODEL })})`
        )
      }
    }
  })

  it('M-27 the extensions sheet: 48px rows, 20px checkboxes; a tick writes the session and keeps the sheet open; the backdrop closes it', async () => {
    const config = sessionConfigPane(page())
    const layout = (): Promise<ComposerLayoutShot | null> => mobile().composerLayout(MODEL)
    const before = await enabledToolsOf(sids.composer)
    try {
      expect(before ?? [], 'precondition: ssh is not ticked yet').not.toContain('mcp:ssh')
      await openFromList('MOB-composer')
      await chatPane(page()).ready()
      const idle = await until(async () => {
        const s = await layout()
        return s?.extensions?.count ? s : null
      }, 'the extensions pill with its count')
      const count = Number(idle.extensions!.count)

      await mobile().tap({ composer: 'extensions' })
      const sheet = await settledTouchSheet('extensions')
      const what = JSON.stringify(sheet)
      expect(sheet.title, what).toBe(en.input.extensions)
      expect(sheet.dialog.top, what).toBeGreaterThanOrEqual(-0.5)
      expect(Math.abs(sheet.dialog.bottom - sheet.innerHeight), what).toBeLessThanOrEqual(1)
      expect(Math.abs(sheet.dialog.left), what).toBeLessThanOrEqual(0.5)
      expect(Math.abs(sheet.dialog.right - sheet.innerWidth), what).toBeLessThanOrEqual(0.5)
      const toolRows = sheet.rows.filter((r) => r.id.startsWith('mcp:'))
      // 技能不在抽屉里（2026-10-28 起不按会话勾选）
      expect(
        sheet.rows.filter((r) => r.id.startsWith('skill')),
        what
      ).toEqual([])
      expect(
        toolRows.map((r) => r.id),
        what
      ).toContain('mcp:ssh')
      for (const r of toolRows) expect(r.height, `${r.id} ${what}`).toBeGreaterThanOrEqual(48)
      expect(sheet.checkboxes.length, what).toBeGreaterThanOrEqual(toolRows.length)
      for (const c of sheet.checkboxes) {
        expect(Math.abs(c.box.width - 20), `${c.id} checkbox ${what}`).toBeLessThanOrEqual(1)
        expect(Math.abs(c.box.height - 20), `${c.id} checkbox ${what}`).toBeLessThanOrEqual(1)
      }

      await mobile().tap({ touchSheetItem: 'mcp:ssh', checkbox: true })
      await until(
        async () => ((await enabledToolsOf(sids.composer)) ?? []).includes('mcp:ssh'),
        'mcp:ssh ticked in the session'
      )
      expect(await mobile().touchSheet('extensions'), 'the sheet stays open').not.toBeNull()
      await until(
        async () => (await layout())?.extensions?.count === String(count + 1),
        `the extension count ${count} → ${count + 1}`
      )

      await mobile().tap({ touchSheetBackdrop: 'extensions' })
      await until(
        async () => (await mobile().touchSheet('extensions')) === null,
        'the extensions sheet closed'
      )
      await sleep(400)
      expect(await mobile().chatOpen()).toBe(true)
      expect(await config.isOpen()).toBe(false)
    } finally {
      await closeTouchSheets()
      await app.main.eval(
        `window.api.session.updateEnabledTools(${JSON.stringify({ id: sids.composer, enabledTools: before ?? [] })})`
      )
    }
  })

  it('M-28 a real Enter is a newline; send sends both lines; a real hold on Now opens the menu and Append queues', async () => {
    const chat = chatPane(page())
    const layout = (): Promise<ComposerLayoutShot | null> => mobile().composerLayout(MODEL)
    const userTexts = async (): Promise<string[]> =>
      (
        await app.main.eval<Array<{ role: string; content: string }>>(
          `window.api.message.list(${JSON.stringify(sids.composer)})`
        )
      )
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
    const replied = (reply: string): Promise<boolean> =>
      app.main
        .eval<
          Array<{ role: string; content: string }>
        >(`window.api.message.list(${JSON.stringify(sids.composer)})`)
        .then((ms) => ms.some((m) => m.role === 'assistant' && m.content === reply))
    try {
      await openFromList('MOB-composer')
      await chat.ready()
      await until(async () => !!(await layout())?.send, 'the idle composer')

      // 可信输入：回车不发，浏览器自己换行
      await mobile().typeTrusted('line one')
      await mobile().pressEnterTrusted()
      await mobile().typeTrusted('line two')
      await until(
        async () => (await mobile().composerValue()) === 'line one\nline two',
        'two lines in the composer'
      )
      const requests = provider.chatRequestCount()
      const t0 = Date.now()
      while (Date.now() - t0 < 500) {
        expect(await chat.isBusy(), 'Enter must not send').toBe(false)
        await sleep(50)
      }
      expect(provider.chatRequestCount()).toBe(requests)

      provider.script({ text: 'MOB-COMPOSER-REPLY', usage: USAGE })
      await mobile().tap({ composer: 'send' })
      await until(
        async () => (await userTexts()).includes('line one\nline two'),
        'the two-line user message'
      )
      await until(() => replied('MOB-COMPOSER-REPLY'), 'the reply to the two lines')
      await chat.waitIdle()

      // 运行中（hold 住）：打字 → 一颗「立即」；真按住它 → 菜单，什么都没发
      provider.script(
        { text: 'MOB-HOLD-REPLY', holdMs: 20_000, usage: USAGE },
        { text: 'MOB-FOLLOW-REPLY', usage: USAGE }
      )
      await mobile().typeTrusted('hold ask')
      await mobile().tap({ composer: 'send' })
      await until(async () => (await chat.isBusy()) && provider.holding(), 'the held run')
      await mobile().typeTrusted('hold me')
      await until(async () => {
        const s = await layout()
        return (await mobile().composerValue()) === 'hold me' && s?.queue.length === 1
      }, 'the steer button with the typed text')
      await mobile().longPress({ composer: 'steer' }, 800)
      await until(
        async () => JSON.stringify(await mobile().queueMenu()) === '["steer","followUp"]',
        'the long-press queue menu'
      )
      // 按住之后那一下 click（长按的宽限期 600ms 内）会被吞：等它过去，也给误发留出时间
      await sleep(700)
      expect(await mobile().composerValue()).toBe('hold me')
      expect(await chat.queueRows(), 'nothing queued or steered by the hold').toEqual([])
      expect(await userTexts()).not.toContain('hold me')

      await mobile().tap({ queueMenuTier: 'followUp' })
      await until(async () => (await mobile().composerValue()) === '', 'the composer cleared')
      const rows = await until(async () => {
        const r = await chat.queueRows()
        return r.length === 1 ? r : null
      }, 'one queued Append')
      expect(rows[0]).toMatchObject({ mode: 'followUp', text: 'hold me' })
      expect(await mobile().queueMenu()).toBeNull()

      provider.release()
      await until(() => replied('MOB-FOLLOW-REPLY'), 'the follow-up answered after the release')
      expect(await userTexts()).toContain('hold me')
      await chat.waitIdle()
    } finally {
      provider.release()
      await chat.waitIdle().catch(() => undefined)
      await closeTouchSheets()
    }
  })

  it('M-29 a real tap on a user bubble reveals its actions; the remote label sits above it, right-aligned; reply actions are always there', async () => {
    const chat = chatPane(page())
    if ((await page().eval<number>('innerWidth')) !== PHONE.width) await phone()
    await openFromList('MOB-actions')
    await chat.ready()
    await sendActionsTurn()
    const { user: uid, reply: rid } = await actionsIds(page())
    const viewport = await page().eval<{ w: number; h: number }>(
      `({ w: window.innerWidth, h: window.innerHeight })`
    )

    // 来源标签在气泡右上方
    const rest = await until(async () => {
      const s = await mobile().userMessageShot(uid)
      return s?.meta && s.chip ? s : null
    }, 'the Hi bubble with its meta row')
    expectLabelAboveRight(rest, 'phone')
    expect(rest.actions, 'no actions before a tap').toEqual([])

    // 真点一下气泡：复制与回退出现在气泡下面
    await mobile().tap({ userBubble: uid })
    const open = await until(async () => {
      const s = await mobile().userMessageShot(uid)
      return s && s.actions.length === 2 ? s : null
    }, 'the user actions after a tap')
    const what = JSON.stringify(open)
    expect(
      open.actions.map((a) => a.label),
      what
    ).toEqual([en.message.copy, en.message.rollback])
    for (const a of open.actions) {
      expect(a.opacity, `${a.label} ${what}`).toBe('1')
      expect(a.box.top, `${a.label} below the bubble ${what}`).toBeGreaterThanOrEqual(
        open.bubble.bottom - 0.5
      )
      expectTouchSized(a.box, a.label)
      expectInViewport(a.box, viewport, a.label)
    }
    expect(open.actions[0]!.box.right, what).toBeLessThanOrEqual(open.actions[1]!.box.left + 0.5)
    const overflow = await mobile().conversationOverflow()
    expect(overflow, 'the conversation scroller').not.toBeNull()
    expect(overflow!.offenders, JSON.stringify(overflow)).toEqual([])
    expect(overflow!.scrollWidth).toBeLessThanOrEqual(overflow!.clientWidth)
    expect(overflow!.docScrollWidth).toBeLessThanOrEqual(overflow!.innerWidth)

    // 再点一下：收起
    await mobile().tap({ userBubble: uid })
    await until(
      async () => (await mobile().userMessageShot(uid))?.actions.length === 0,
      'the user actions hidden by a second tap'
    )

    // 回复卡的操作不用碰就在
    const reply = await until(async () => {
      const b = await mobile().assistantActionsShot(rid)
      return b.length > 0 ? b : null
    }, 'the reply actions')
    const titles = reply.map((b) => b.title)
    expect(titles).toEqual(expect.arrayContaining([en.message.copy, en.message.regenerate]))
    for (const b of reply) {
      expect(b.opacity, `${b.title} ${JSON.stringify(reply)}`).toBe('1')
      expectTouchSized(b.box, b.title)
    }
    const body = await mobile().replyBody(rid)
    expect(body, 'the reply body').not.toBeNull()
    expect(reply[0]!.icon, 'the first reply icon').not.toBeNull()
    expect(
      Math.abs(reply[0]!.icon!.left - body!.left),
      JSON.stringify({ reply, body })
    ).toBeLessThanOrEqual(1.5)
  })

  it('M-30 the desktop main window: the remote label right-aligned above the bubble; actions show on hover only', async () => {
    await sendActionsTurn()
    const desk = webMobilePane(app.main)
    try {
      await until(
        () => sidebarPane(app.main).openSession('MOB-actions'),
        'MOB-actions in the main window'
      )
      await chatPane(app.main).ready()
      const { user: uid, reply: rid } = await actionsIds(app.main)

      // 不悬停：都在 DOM 里、opacity 0（等过渡走完）
      await desk.hover(null)
      const rest = await until(async () => {
        const s = await desk.userMessageShot(uid)
        return s?.meta &&
          s.chip &&
          s.actions.length === 2 &&
          s.actions.every((a) => a.opacity === '0')
          ? s
          : null
      }, 'the Hi bubble at rest in the main window')
      expect(rest.actions.map((a) => a.label)).toEqual([en.message.copy, en.message.rollback])
      expectLabelAboveRight(rest, 'desktop')
      const replyRest = await until(async () => {
        const b = await desk.assistantActionsShot(rid)
        return b.length > 0 && b.every((x) => x.opacity === '0') ? b : null
      }, 'the reply actions at rest (opacity 0)')
      expect(replyRest.map((b) => b.title)).toEqual(
        expect.arrayContaining([en.message.copy, en.message.regenerate])
      )

      // 悬停气泡：两颗显形，气泡与 meta 行不动
      await desk.hover({ userBubble: uid })
      const hovered = await until(async () => {
        const s = await desk.userMessageShot(uid)
        return s && s.actions.length === 2 && s.actions.every((a) => a.opacity === '1') ? s : null
      }, 'the user actions shown on hover')
      // 悬停前后量的是同一处（hover 里的滚进视口可能挪了列表）：用悬停后再量一次不悬停的位置比
      await desk.hover(null)
      const after = await until(async () => {
        const s = await desk.userMessageShot(uid)
        return s && s.actions.every((a) => a.opacity === '0') ? s : null
      }, 'the user actions hidden again')
      expectSameBox(hovered.bubble, after.bubble, 'the bubble')
      expectSameBox(hovered.meta!, after.meta!, 'the meta row')

      // 悬停回复正文：它的操作显形
      await desk.hover({ replyBody: rid })
      await until(async () => {
        const b = await desk.assistantActionsShot(rid)
        return b.length > 0 && b.every((x) => x.opacity === '1')
      }, 'the reply actions shown on hover')
    } finally {
      await desk.hover(null).catch(() => undefined)
    }
  })

  it('M-23 settings: Providers and LLM Tools drill down — a list, one item under a second-level header, back to the list where it was', async () => {
    const pane = mobile()
    type ProviderRow = {
      id: string
      name: string
      displayName: string
      isEnabled: number
      isBuiltin: number
    }
    const listAll = (): Promise<ProviderRow[]> =>
      app.main.eval<ProviderRow[]>(
        `window.api.provider.listAll().then((ps) => ps.map((p) => ({ id: p.id, name: p.name, displayName: p.displayName, isEnabled: p.isEnabled, isBuiltin: p.isBuiltin })))`
      )
    const providers = await listAll()
    const fake = providers.find((p) => p.id === fakeProviderId)
    expect(fake, 'the fake provider in listAll').toBeDefined()
    const fakeName = fake!.displayName || fake!.name
    const read = (
      await app.main.eval<Array<{ name: string; label: string }>>(
        `window.api.tools.definitions().then((ds) => ds.map((d) => ({ name: d.name, label: d.label })))`
      )
    ).find((d) => d.name === 'read')
    expect(read, 'the read tool in tools.definitions').toBeDefined()
    const readLabel = read!.label || read!.name
    /** 步骤 8 切过的那一家（finally 里没切回来就经 IPC 放回去） */
    let flipped: ProviderRow | undefined

    const sectionList = (): Promise<unknown> =>
      until(async () => (await pane.settingsTabs()).length === 11, 'the settings section list')
    const subList = (
      what: string,
      id?: string
    ): Promise<{ rows: Array<{ id: string; height: number }> }> =>
      until(async () => {
        const v = await pane.settingsSubView()
        return v.list && !v.detail && v.rows.length > 0 && (!id || v.rows.some((r) => r.id === id))
          ? v
          : null
      }, what)
    const subDetail = (what: string): Promise<unknown> =>
      until(async () => {
        const v = await pane.settingsSubView()
        return v.detail && !v.list
      }, what)
    /**
     * 头部落到这一层：分区报上来的「开着一项」走 effect（详情 / 列表先上屏，头部晚一拍），所以等它，不立刻断
     */
    const headerIs = async (
      level: 'section' | 'item',
      backText: string,
      heading: string,
      what: string
    ): Promise<void> => {
      const want = { back: { text: backText, ariaLabel: backText, level }, heading }
      let seen: unknown = null
      await until(async () => {
        seen = { back: await pane.settingsBackButton(), heading: await pane.settingsHeader() }
        return JSON.stringify(seen) === JSON.stringify(want)
      }, what).catch((e: Error) => {
        throw new Error(`${e.message}\nlast header seen: ${JSON.stringify(seen)}`)
      })
    }

    try {
      await toTab('settings')
      await settingsToList()

      // 1 「提供商」：一整屏的列表，什么都不选
      await pane.tap({ settingsTab: 'providers' })
      const list = await subList('the provider list', fakeProviderId)
      expect((await pane.settingsSubView()).detail).toBe(false)
      for (const row of list.rows) expect(row.height, `row ${row.id}`).toBeGreaterThanOrEqual(48)
      await headerIs('section', en.settings.title, en.settings.tabProviders, 'the Providers header')

      // 2 点假提供商 → 只剩它的详情，头部到第二层
      await pane.tap({ settingsProviderRow: fakeProviderId })
      await subDetail('the fake provider’s detail')
      await headerIs('item', en.settings.tabProviders, fakeName, 'the fake provider’s header')
      expect(await pane.settingsSubView()).toEqual({ list: false, rows: [], detail: true })

      // 3 返回 → 列表
      await pane.tap({ settingsBack: true })
      await subList('the provider list again', fakeProviderId)
      await headerIs('section', en.settings.title, en.settings.tabProviders, 'Providers again')

      // 4 再返回 → 设置列表
      await pane.tap({ settingsBack: true })
      await sectionList()
      expect(await pane.settingsHeader()).toBeNull()

      // 5 「LLM 工具」里点 read
      await pane.tap({ settingsTab: 'tools' })
      await subList('the tool list', 'read')
      await pane.tap({ settingsToolRow: 'read' })
      await subDetail('the read tool’s detail')
      await headerIs('item', en.settings.tabTools, readLabel, 'the read tool’s header')

      // 6 返回 → 列表；再返回 → 设置列表
      await pane.tap({ settingsBack: true })
      await subList('the tool list again', 'read')
      await headerIs('section', en.settings.title, en.settings.tabTools, 'LLM Tools again')
      await pane.tap({ settingsBack: true })
      await sectionList()

      // 7 滚动：列表滚到底，点靠底的一行 → 真正在滚的那一层回到顶上；返回 → 列表回到离开前的位置。
      //   点的行都在可见区的下半截：点之前把它滚到正中（pointOf）要往下滚，而列表已经到底，所以位置不动
      await pane.tap({ settingsTab: 'providers' })
      const long = await subList('the provider list for the scroll walk', fakeProviderId)
      const bottom = await pane.settingsSubScrollToBottom()
      expect(bottom, 'the provider list overflows its scroller').not.toBeNull()
      expect(bottom!.scrollTop).toBeGreaterThan(0)
      // dsf 2：scrollTop 可以是半像素，scrollHeight / clientHeight 是整数
      expect(Math.abs(bottom!.scrollTop - bottom!.maxScrollTop)).toBeLessThanOrEqual(1)
      // 落定：滚完没有谁把它挪回去
      await sleep(200)
      expect(await pane.settingsSubScroll()).toEqual(bottom)

      /**
       * 点进 `id` 的详情（在顶上），再返回（列表回到点之前的位置）。`overflow`：详情超不超出滚动层 ——
       * 'no' 不管、'eventually' 等它长出来（模型列表是点进去才载的）、'at once' 一上屏就超出
       */
      const drillAndBack = async (
        id: string,
        overflow: 'no' | 'eventually' | 'at once'
      ): Promise<void> => {
        await pane.tap({ settingsProviderRow: id })
        await subDetail(`the detail of ${id}`)
        const top =
          overflow === 'eventually'
            ? await until(() => pane.settingsSubScroll(), `the detail of ${id} overflows`)
            : await pane.settingsSubScroll()
        if (overflow === 'at once')
          expect(top, `the detail of ${id} overflows at once`).not.toBeNull()
        // 没有可滚的（详情没超出）= 就在顶上
        expect(
          top?.scrollTop ?? 0,
          `the scroller with ${id} open: ${JSON.stringify(top)}`
        ).toBeLessThanOrEqual(1)
        await pane.tap({ settingsBack: true })
        await subList(`the provider list after the detail of ${id}`, id)
        const restored = await pane.settingsSubScroll()
        expect(restored, `the list scroller after back from ${id}`).not.toBeNull()
        expect(
          Math.abs(restored!.scrollTop - bottom!.scrollTop),
          `restored ${JSON.stringify(restored)} vs left at ${JSON.stringify(bottom)}`
        ).toBeLessThanOrEqual(2)
      }
      // 最后一行（它的详情很短：没什么可滚，浏览器自己把位置夹到 0 —— 返回照样回到原处）
      await drillAndBack(long.rows.at(-1)!.id, 'no')
      // 最后五行里最靠下的一家模型多的：详情超出，「回到顶上」是真的挪了位置
      const modelCount = (id: string): Promise<number> =>
        app.main.eval<number>(
          `window.api.provider.listModels(${JSON.stringify(id)}).then((ms) => ms.length)`
        )
      let longDetail: string | undefined
      for (const row of long.rows.slice(-5).reverse()) {
        if ((await modelCount(row.id)) >= 20) {
          longDetail = row.id
          break
        }
      }
      expect(longDetail, 'one of the last five providers has a long model list').toBeDefined()
      // 第一次进去它的模型才载：详情先短后长，短的那一下浏览器已经把位置夹到 0 了
      await drillAndBack(longDetail!, 'eventually')
      // 第二次模型已在：详情从第一帧就超出 —— 落在顶上只能是产品挪的，不是浏览器夹的
      await drillAndBack(longDetail!, 'at once')

      // 8 行上的开关只切启用、不进详情（一家停用的内置提供商，切过去再切回来）
      const target = providers.find((p) => p.isBuiltin && !p.isEnabled)
      expect(target, 'a disabled builtin provider').toBeDefined()
      flipped = target
      for (const next of [1, 0]) {
        await pane.tap({ settingsProviderToggle: target!.id })
        await until(
          async () => (await listAll()).find((p) => p.id === target!.id)?.isEnabled === next,
          `${target!.name} isEnabled = ${next}`
        )
        const v = await pane.settingsSubView()
        expect(v.list && !v.detail, `still the list after toggling to ${next}`).toBe(true)
        expect(await pane.settingsBackButton()).toEqual({
          text: en.settings.title,
          ariaLabel: en.settings.title,
          level: 'section'
        })
      }
      flipped = undefined

      // 9 回设置列表、回会话标签
      await pane.tap({ settingsBack: true })
      await sectionList()
      await toTab('sessions')
    } finally {
      if (flipped) {
        const now = (await listAll()).find((p) => p.id === flipped!.id)
        if (now && now.isEnabled !== flipped.isEnabled)
          await app.main.eval(
            `window.api.provider.toggleEnabled(${JSON.stringify({ id: flipped.id, isEnabled: !!flipped.isEnabled })})`
          )
      }
      if ((await pane.activeTab()) === 'settings') await settingsToList().catch(() => undefined)
    }
  })

  it('M-31 an approval card on the phone: four 44px option rows across the card, 16px labels, no sideways scroll; no digit keys; a real tap allows', async () => {
    type ListedMessage = {
      role: string
      content: string
      blocks?: Array<{
        type: string
        toolCallId?: string
        toolName?: string
        result?: string
        isError?: boolean
      }>
    }
    const chat = chatPane(page())
    const dir = join(app.home, 'outside-mob-ask', 'deep')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'MOB-ASK-FILE')
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'MOB-ask', projectId: projects.main.id })}).then((s) => s.id)`
    )
    const messages = (): Promise<ListedMessage[]> =>
      app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)
    provider.script(
      {
        toolCalls: [{ id: 'mob-ask-1', name: 'read', args: JSON.stringify({ path: file }) }],
        usage: USAGE
      },
      { text: 'MOB-ASK-DONE', usage: USAGE }
    )
    // agent.prompt 等整轮跑完才回，而这一轮停在询问上：只发出去，不等
    await app.main.eval(
      `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'read the note' })}).catch(() => {}), true)`
    )
    let answered = false
    try {
      if ((await page().eval<number>('innerWidth')) !== PHONE.width) await phone()
      await toTab('sessions')
      // 单跑这一条时 MobProj 是收着的（M-2 才展开它）
      if ((await mobile().listGroupExpanded(projects.main.name)) === false) {
        await mobile().tap({ listGroupToggle: projects.main.name })
        await until(
          async () => (await mobile().listGroupExpanded(projects.main.name)) === true,
          'MobProj expanded'
        )
      }
      await until(
        async () => (await mobile().listRows()).includes('MOB-ask'),
        'MOB-ask in the phone list'
      )
      await openFromList('MOB-ask')
      await chat.ready()

      const card = await until(async () => {
        const c = await mobile().pendingCard()
        return c?.kind === 'ask' && c.rows.length > 0 ? c : null
      }, 'the approval card on the phone')
      const what = JSON.stringify(card)
      expect(
        card.rows.map((r) => r.id),
        what
      ).toEqual(['allow', 'remember-path', 'remember-folder', 'deny'])
      expect(
        card.rows.map((r) => r.label),
        what
      ).toEqual([
        en.toolCall.askAllowOnce,
        en.toolCall.askRememberFile,
        en.toolCall.askRememberFolder,
        en.toolCall.deny
      ])
      card.rows.forEach((r, i) => {
        const msg = `${r.id} ${what}`
        expect(r.box.height, msg).toBeGreaterThanOrEqual(43.5)
        expect(Math.abs(r.box.left - card.panel.left), msg).toBeLessThanOrEqual(1)
        expect(Math.abs(r.box.right - card.panel.right), msg).toBeLessThanOrEqual(1)
        expect(r.box.left, msg).toBeGreaterThanOrEqual(0)
        expect(r.box.right, msg).toBeLessThanOrEqual(PHONE.width)
        expect(r.fontSize, msg).toBe('16px')
        if (i > 0) expect(r.box.top, msg).toBeGreaterThanOrEqual(card.rows[i - 1]!.box.bottom - 0.5)
      })
      expect(card.rows[0]!.box.top, what).toBeGreaterThanOrEqual(0)
      expect(card.rows[card.rows.length - 1]!.box.bottom, what).toBeLessThanOrEqual(card.viewport.h)
      const folderRow = card.rows.find((r) => r.id === 'remember-folder')!
      expect(card.folderDetail, what).not.toBeNull()
      expect(card.folderDetail!.right, what).toBeLessThanOrEqual(folderRow.box.right + 0.5)
      expect(card.overflow.doc, what).toBeLessThanOrEqual(0)
      expect(card.overflow.shell, what).not.toBeNull()
      expect(card.overflow.shell!, what).toBeLessThanOrEqual(0)
      expect(card.placeholder).toBe(en.pendingInputs.otherPlaceholderAsk)

      // 触屏没有数字键：焦点在 body 上按可信的 1，什么都不答
      const requests = provider.chatRequestCount()
      await mobile().pressDigitOnBodyTrusted('1')
      await sleep(500)
      expect((await mobile().pendingCard())?.kind, 'the card is still there').toBe('ask')
      expect(provider.chatRequestCount(), 'nothing answered by the key').toBe(requests)

      // 真点「允许这一次」
      await mobile().tap({ pendingOption: 'allow' })
      await until(async () => (await mobile().pendingCard()) === null, 'the card closed')
      await until(
        async () =>
          (await messages()).some((m) => m.role === 'assistant' && m.content === 'MOB-ASK-DONE'),
        'the reply after the allow'
      )
      answered = true
      const tool = (await messages())
        .flatMap((m) => m.blocks ?? [])
        .find((b) => b.type === 'tool' && b.toolCallId === 'mob-ask-1')
      expect(tool, 'the read tool block').toBeDefined()
      expect(tool!.toolName).toBe('read')
      expect(tool!.isError ?? false, JSON.stringify(tool)).toBe(false)
      expect(tool!.result ?? '').toContain('MOB-ASK-FILE')
      await chat.waitIdle()
    } finally {
      // 半路失败时别把这一轮挂在询问上
      if (!answered)
        await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`).catch(() => undefined)
    }
  })
})

/** 设置标签停在分区列表上：开着分区（或分区里的一项）就一层层返回 */
async function settingsToList(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const back = await mobile().settingsBackButton()
    if (!back) return
    await mobile().tap({ settingsBack: true })
    await until(
      async () => JSON.stringify(await mobile().settingsBackButton()) !== JSON.stringify(back),
      'one settings level back'
    )
  }
}

/** b 整个落在 card 里（±0.5px） */
function expectInside(b: BoxShot | null, card: BoxShot, what: string): void {
  expect(b, `${what} on screen`).not.toBeNull()
  const msg = `${what} ${JSON.stringify(b)} inside the card ${JSON.stringify(card)}`
  expect(b!.left, msg).toBeGreaterThanOrEqual(card.left - 0.5)
  expect(b!.right, msg).toBeLessThanOrEqual(card.right + 0.5)
  expect(b!.top, msg).toBeGreaterThanOrEqual(card.top - 0.5)
  expect(b!.bottom, msg).toBeLessThanOrEqual(card.bottom + 0.5)
}

function expectTruncated(name: ComposerLayoutShot['modelName'], what: string): void {
  expect(name, `${what} on screen`).not.toBeNull()
  expect(name!.scrollWidth, `${what} is truncated`).toBeGreaterThan(name!.clientWidth)
}

/** 失败信息里带上的宽度（取整到 0.1px） */
function widthsOf(s: ComposerLayoutShot): Record<string, number | null> {
  const w = (b: BoxShot | null): number | null => (b ? Math.round(b.width * 10) / 10 : null)
  return {
    card: w(s.card),
    toolbar: Math.round(s.toolbarWidth * 10) / 10,
    modelTrigger: w(s.modelTrigger),
    modelName: s.modelName ? w(s.modelName.box) : null,
    toolPicker: w(s.toolPicker),
    ringItem: w(s.ringItem),
    queueSteer: s.queue[0] ? w(s.queue[0].box) : null,
    queueFollowUp: s.queue[1] ? w(s.queue[1].box) : null,
    stop: w(s.stop)
  }
}
