/**
 * 种子与常用流程助手 —— 把本仓 e2e 的固定习语收拢在一处：
 *
 *   - agent md 种子直接写 fake HOME 的 ~/.shuvix/agents（subAgent.list 每次现扫文件系统）；
 *   - 「创建 Agent 而不触发 LLM」用 `agent.getInfo(sid, { ensure: true })`（ensure 只做懒创建
 *     并回快照，不发任何请求）；
 *   - 「触发首条 prompt 的注入路径」允许 LLM 调用失败（隔离实例无 API key）——
 *     prompt 前的系统提示词组装 / 消息树写入已经发生，断言只看这些副作用。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect } from 'vitest'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  type RegistryNoteKind
} from '@shuvix/chat-protocol/registryNotes'
import type { CdpClient } from './cdp'
import { sleep, until } from './cdp'
import type { E2EApp } from './launch'

export interface AgentMdSeed {
  description?: string
  /** shuvix-tools 逗号串（如 'read, grep'） */
  tools?: string
  /** shuvix-model 原样值（`<providerId>/<modelId>` 或裸 `<modelId>`） */
  model?: string
  body?: string
  displayName?: string
  /** shuvix-instruction-files 逗号串（如 'AGENTS.md, CLAUDE.md'） */
  instructionFiles?: string
  projectAwareness?: boolean
  /** 追加的原始 frontmatter 行（测未知/废弃 key 时用） */
  rawLines?: string[]
}

/** 写一个 agent 定义文件到隔离实例的 ~/.shuvix/agents/<name>.md */
export function writeAgentMd(app: E2EApp, name: string, seed: AgentMdSeed = {}): string {
  mkdirSync(app.agentsDir, { recursive: true })
  // 与规范化写入口同形：文件类型标记居首（解析侧不作要求，见 definitionFile 的向后兼容说明）
  const lines = ['---', 'shuvix: agent v1', `name: ${name}`]
  if (seed.description) lines.push(`description: ${seed.description}`)
  if (seed.tools) lines.push(`shuvix-tools: ${seed.tools}`)
  if (seed.model) lines.push(`shuvix-model: ${seed.model}`)
  if (seed.displayName) lines.push(`shuvix-displayName: ${seed.displayName}`)
  if (seed.instructionFiles) lines.push(`shuvix-instruction-files: ${seed.instructionFiles}`)
  if (seed.projectAwareness) lines.push('shuvix-project-awareness: true')
  if (seed.rawLines) lines.push(...seed.rawLines)
  lines.push('---', '', seed.body ?? 'BODY.')
  const filePath = join(app.agentsDir, `${name}.md`)
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

export interface BotMdSeed {
  /** 一句话介绍（可选；侧栏行的 title 提示） */
  description?: string
  displayName?: string
  /** 正文 = 人设与记忆（围栏后追加到**根** Agent 的系统提示词） */
  body?: string
  /** 追加的原始 frontmatter 行（测未知键 / 类型错时用） */
  rawLines?: string[]
  /** 省略文件类型标记（bot md 与 agent md 同口径：读取可选） */
  omitMarker?: boolean
  /** 写一个别的类型标记（测「agent md 掉进 bots 目录要被拒」） */
  marker?: string
  /** 落盘的文件名（缺省 `<name>.md`）—— 同名的几份文件只能靠文件名分开 */
  fileName?: string
}

/**
 * 写一个 bot 定义文件到隔离实例的 ~/.shuvix/bots/<name>.md（`seed.fileName` 可换文件名）。
 *
 * 一个 bot 只声明身份，正文是它的人设与记忆 —— 没有管线、没有槽位。与 agent/policy/hook
 * 同为纯 md 驱动：文件落盘即被 `bot:list` 现扫看见，没有启用开关也没有旁路配置要一并种。
 */
export function writeBotMd(app: E2EApp, name: string, seed: BotMdSeed = {}): string {
  mkdirSync(app.botsDir, { recursive: true })
  const lines = ['---']
  if (!seed.omitMarker) lines.push(`shuvix: ${seed.marker ?? 'bot v2'}`)
  lines.push(`name: ${name}`)
  if (seed.description !== '')
    lines.push(`description: ${seed.description ?? `e2e seeded bot ${name}`}`)
  if (seed.displayName) lines.push(`shuvix-displayName: ${seed.displayName}`)
  if (seed.rawLines) lines.push(...seed.rawLines)
  lines.push('---', '', seed.body ?? 'BOT BODY.')
  const filePath = join(app.botsDir, seed.fileName ?? `${name}.md`)
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

/**
 * 让一个模型出现在「可用模型目录」里 —— 档案模型解析（findAllEnabledModels）要求
 * **提供商 isEnabled=1 且模型 isEnabled=1**，而内置提供商的种子数据是 isEnabled=0，
 * 不先启用则目录为空、任何 shuvix-model 都解析不出来。
 * 手动 addModel 插入的模型即 isEnabled=1，故只需额外启用提供商。
 */
export async function seedEnabledModel(
  main: CdpClient,
  opts: { providerId: string; modelId: string }
): Promise<void> {
  await main.eval(
    `(async () => {
      await window.api.provider.toggleEnabled({ id: ${JSON.stringify(opts.providerId)}, isEnabled: true })
      await window.api.provider.addModel(${JSON.stringify(opts)})
    })()`
  )
}

/** 造一个自定义提供商（id 为 uuidv7，插入即 isEnabled=1），返回其 id */
export function seedCustomProvider(
  main: CdpClient,
  opts: { name: string; baseUrl?: string; apiKey?: string; apiProtocol?: string }
): Promise<string> {
  return main.eval(
    `window.api.provider.add(${JSON.stringify({
      name: opts.name,
      baseUrl: opts.baseUrl ?? 'https://example.invalid/v1',
      apiKey: opts.apiKey ?? '',
      apiProtocol: opts.apiProtocol ?? 'openai-completions'
    })}).then((p) => p.id)`
  )
}

/**
 * 写一个全局 skill（`~/.shuvix/skills/<name>/SKILL.md`），返回文件路径。
 *
 * 全局 skill 缺省即启用（`.config.json` 的 disabled 列表里没有就是启用）。种它是为了让
 * `skill:<name>` 成为**真实可用**的工具名 —— 会话工具集在读取时会经 filterAvailableTools
 * 剔除不存在的条目，光往会话设置里写一个查无此人的名字是断言不到的。
 */
export function seedSkill(app: E2EApp, name: string, description = 'e2e seeded skill'): string {
  return seedSkillIn(join(app.home, '.shuvix', 'skills'), name, { description })
}

export interface SkillSeed {
  /** 触发条件（侧栏行的 title 提示；卡片上的 description 字段） */
  description?: string
  /**
   * frontmatter 里的 `name`。**缺省等于目录名**；写成别的就是「目录名与 name 不同」那一类
   * 技能 —— 宿主按 `basePath` 的最后一段拼 notebookPath、按注册表定位删除，两处都不能
   * 从 name 切（见 SKN-7 / SSG-14）
   */
  frontmatterName?: string
  /** 正文（笔记本里读到的就是它）—— 默认带一行纯散文，好当「读的是盘上这一份」的特征串 */
  body?: string
}

/**
 * 往**任意目录**写一个技能（`<dir>/<dirEntry>/SKILL.md`），返回 SKILL.md 的路径。
 *
 * 一个技能是目录而不是单文件，所以种子也是目录：`seedSkill` 是它在默认根上的特例，
 * 外部目录与「目录名 ≠ frontmatter name」的样本都从这里来。
 */
export function seedSkillIn(dir: string, dirEntry: string, seed: SkillSeed = {}): string {
  const base = join(dir, dirEntry)
  mkdirSync(base, { recursive: true })
  const filePath = join(base, 'SKILL.md')
  const lines = [
    '---',
    `name: ${seed.frontmatterName ?? dirEntry}`,
    `description: ${seed.description ?? 'e2e seeded skill'}`,
    '---',
    '',
    seed.body ?? `Seeded body for ${dirEntry}.`,
    ''
  ]
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

/**
 * 造一个**外部技能目录**（隔离实例 HOME 下、技能默认根之外）并种两个技能，返回它的绝对路径。
 *
 * 只造目录、不落配置：把它加进来要走 UI 那两步（OS 选择器桩 → 取名框），这正是 SK-8 要测的
 * 东西；两个技能是为了让「整组开关」与「组内每一行都变淡」有不止一行可断。
 */
export function seedExternalSkillDir(app: E2EApp, dirName: string): string {
  const dir = join(app.home, 'external-skills', dirName)
  mkdirSync(dir, { recursive: true })
  seedSkillIn(dir, `${dirName}-one`, { description: `${dirName} first skill` })
  seedSkillIn(dir, `${dirName}-two`, { description: `${dirName} second skill` })
  return dir
}

// ── 最小 PNG 编码器（图片种子现造，不往仓库里塞二进制夹具） ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let c = 0xffffffff
  for (const b of body) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 写一张 PNG 图片种子，返回文件路径。
 *
 * `incompressible: true` → 噪声像素 + deflate level 0，几乎压不动：这是造 **>1MB** 样本
 * （走 read 的「缩放重编码 + 派生图落盘」分支）唯一便宜的办法 —— 纯色图哪怕几千像素宽，
 * 压完也只有几百字节，永远够不着 1MB 阈值。默认（纯色 + 最高压缩）则是「未超限直出」的样本。
 */
export function writePng(
  filePath: string,
  opts: { width: number; height: number; incompressible?: boolean }
): string {
  const { width: w, height: h, incompressible = false } = opts
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3
      raw[o] = incompressible ? (x * 2654435761 + y * 40503) & 0xff : 200
      raw[o + 1] = incompressible ? (x * 97 + y * 31337) & 0xff : 40
      raw[o + 2] = incompressible ? (x * 1103515245 + y * 12345) & 0xff : 40
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: incompressible ? 0 : 9 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  )
  return filePath
}

/**
 * 把 `startFakeProvider()` 起的假提供商接进隔离实例，并设为**新会话的默认模型**
 * （连带标题模型 —— 不设的话 `generateTitle` 早退，自动标题链路测不到）。
 *
 * `maxInputTokens` 给足 200k：模型 contextWindow 由它决定，而自动压缩阈值是
 * `contextWindow - 16384`；给小了会让脚本里那几百 token 的 usage 触发压缩。
 */
export async function seedFakeProvider(
  main: CdpClient,
  opts: { baseUrl: string; modelId: string; name?: string }
): Promise<{ providerId: string }> {
  const args = JSON.stringify({ name: opts.name ?? 'E2E Fake', baseUrl: opts.baseUrl })
  const modelId = JSON.stringify(opts.modelId)
  return main.eval(
    `(async () => {
      const args = ${args}
      const p = await window.api.provider.add({
        name: args.name,
        baseUrl: args.baseUrl,
        apiKey: 'e2e',
        apiProtocol: 'openai-completions'
      })
      await window.api.provider.addModel({ providerId: p.id, modelId: ${modelId} })
      const row = (await window.api.provider.listModels(p.id)).find((m) => m.modelId === ${modelId})
      if (row) {
        await window.api.provider.updateModelCapabilities({
          id: row.id,
          capabilities: { maxInputTokens: 200000, maxOutputTokens: 4096, vision: true }
        })
      }
      for (const [key, value] of [
        ['general.defaultProvider', p.id],
        ['general.defaultModel', ${modelId}]
      ]) {
        await window.api.settings.set({ key, value })
      }
      return { providerId: p.id }
    })()`
  )
}

/**
 * 自动放行安全询问 —— 扮演那个会点「允许一次」的用户。
 *
 * 隔离实例带着全套内置策略（`ask-on-command` 对每条命令问、`ask-on-sub-session` 对开
 * 子会话问），而 e2e 里没人看着：不装它的话，任何触发询问的用例都会挂到超时。
 * 装在渲染端（`agent.onEvent` → `agent.respondToInput`），走的是用户点按钮的同一条 IPC。
 *
 * 想**故意**测「没人回答」的那条路径就别装它（或用 `only` 只放行一部分）。
 */
export async function installAutoAllow(
  main: CdpClient,
  opts?: { only?: (command: string) => boolean }
): Promise<void> {
  const filter = opts?.only ? `(${opts.only.toString()})` : '(() => true)'
  await main.eval(
    `(() => {
      if (window.__e2eAutoAllow) return true
      window.__e2eAutoAllow = []
      window.api.agent.onEvent((ev) => {
        if (ev.type !== 'input_request') return
        const req = ev.request
        const command = req.command ?? req.question ?? ''
        if (!${filter}(command)) return
        window.__e2eAutoAllow.push(command)
        window.api.agent.respondToInput({
          sessionId: ev.sessionId,
          requestId: req.id,
          response: { kind: req.kind, allowed: true, selections: [] }
        })
      })
      return true
    })()`
  )
}

/** 捕获到的一次「浏览器下载」 */
export interface CapturedDownload {
  /** `<a download>` 的文件名 */
  download: string
  /** Blob 的文本内容 */
  text: string
}

export interface DownloadCapture {
  /** 装桩（**在 beforeAll 里装，整文件生效**，理由见 downloadCapture 的说明） */
  install(): Promise<void>
  /** 还原原生实现（afterAll） */
  uninstall(): Promise<void>
  /** 清掉上一次捕获（每个 it 开头调一次，免得读到上一条用例的文件） */
  clear(): Promise<void>
  /** 等下一次下载被捕获并回文件名 + 正文；上界内没有则抛 */
  wait(timeoutMs?: number): Promise<CapturedDownload>
  /** 此刻是否已捕获到（「不该下载」的否定断言用） */
  captured(): Promise<boolean>
}

/**
 * 下载出口的桩 —— 扮演浏览器那一端，与 installAutoAllow 同类（顶掉一个 e2e 里没人扮演的角色）。
 *
 * 会话导出（`useSessionExport`）最后一跳是 `URL.createObjectURL` + `<a download>` + `a.click()`，
 * 而桌面主进程**没有** `will-download` 监听 —— 那一击会弹原生「另存为」面板，e2e 关不掉，
 * 整条 spec 随之挂死。故在渲染端顶两处：createObjectURL（记住 Blob，返回一个假 `blob:e2e-N`）
 * 与 `HTMLAnchorElement.prototype.click`（**仅当 `download` 非空**时记下并吞掉，其余转调原实现）。
 *
 * **必须装在 beforeAll**：若按用例装，中途任何一次抛错都会让后面的导出裸奔一次 ——
 * 那一次就足以把整个文件挂死在一个没人能关的系统面板上。
 */
export function downloadCapture(main: CdpClient): DownloadCapture {
  const captured = (): Promise<boolean> => main.eval<boolean>(`!!window.__E2E_EXPORT`)
  return {
    install: async () => {
      await main.eval(
        `(() => {
          if (window.__E2E_EXPORT_ORIG) return true
          const origRevoke = URL.revokeObjectURL.bind(URL)
          const origClick = HTMLAnchorElement.prototype.click
          window.__E2E_EXPORT_ORIG = {
            createObjectURL: URL.createObjectURL.bind(URL),
            revokeObjectURL: origRevoke,
            click: origClick
          }
          window.__E2E_EXPORT = null
          let seq = 0
          const blobs = new Map()
          URL.createObjectURL = (obj) => {
            const url = 'blob:e2e-' + ++seq
            blobs.set(url, obj)
            return url
          }
          // 假 URL 交回给我们自己回收；真 URL（别处生成的）照常还给原实现
          URL.revokeObjectURL = (url) => {
            if (!blobs.delete(url)) origRevoke(url)
          }
          HTMLAnchorElement.prototype.click = function () {
            if (!this.download) return origClick.call(this)
            // href 用 getAttribute 取原值：假 blob: URL 不可解析，属性读法会被规范化掉
            const href = this.getAttribute('href') ?? ''
            window.__E2E_EXPORT = { download: this.download, href, blob: blobs.get(href) ?? null }
            return undefined
          }
          return true
        })()`
      )
    },
    uninstall: async () => {
      await main.eval(
        `(() => {
          const orig = window.__E2E_EXPORT_ORIG
          if (!orig) return true
          URL.createObjectURL = orig.createObjectURL
          URL.revokeObjectURL = orig.revokeObjectURL
          HTMLAnchorElement.prototype.click = orig.click
          delete window.__E2E_EXPORT_ORIG
          window.__E2E_EXPORT = null
          return true
        })()`
      )
    },
    clear: async () => {
      await main.eval(`(() => { window.__E2E_EXPORT = null; return true })()`)
    },
    captured,
    wait: (timeoutMs = 10_000) =>
      until(
        () =>
          main.eval<CapturedDownload | null>(
            `(() => {
              const hit = window.__E2E_EXPORT
              if (!hit || !hit.blob) return null
              return hit.blob.text().then((text) => ({ download: hit.download, text }))
            })()`
          ),
        'a download triggered',
        timeoutMs
      )
  }
}

/**
 * 等 React 真正挂载（`launchApp` 只等到 preload 的 `window.api`，此后还有 ~1.5s 才上屏）。
 *
 * ⚠️ **不要用 `location.reload()` 让渲染端重新初始化**：主进程的 `will-navigate`
 * 守卫（`src/main/index.ts`，防止应用变成浏览器）会 `preventDefault` 掉它，页面被卸载
 * 后不再重建 —— 表现就是「整页再也不渲染」。要让渲染端拿到新种的模型/会话，走 UI 自己的
 * 刷新入口（`sidebarPane.clickNewChat()` 会 `setSessions(await session.list())`）。
 */
export async function waitRendererReady(main: CdpClient): Promise<void> {
  await until(() => main.eval<boolean>('!!window.api'), 'window.api ready')
  await until(
    () => main.eval<boolean>('document.querySelectorAll("button").length > 0'),
    'renderer mounted'
  )
}

/**
 * 页内 ChatEvent 收集器 —— 断言「链路发了什么」的主接缝（优先于 DOM）。
 *
 * 装在渲染进程里旁挂 `window.api.agent.onEvent`，与 `useAgentEvents` 并行接收，
 * 不干扰应用自身的处理。收集器是**全局**的（不分会话），断言前按 `sessionId` 过滤；
 * 每个 it 开头 `clear()` 一次，免得上一条用例的事件混进序列断言。
 *
 * `waitFor` 是**流式游标**语义：每次返回该 (type, sessionId) 的**下一条**事件，
 * 不会重复返回已经等到过的那条。一个 it 里跑两轮对话时这是唯一正确的语义 ——
 * 老实现按整个缓冲区 `find`，第二次 `waitFor('agent_end')` 会秒回上一轮的事件，
 * 于是紧随其后的 `chat.waitIdle()` 在「新一轮还没起流」的空窗期（实测 6~33ms）里
 * 判定为空闲，断言就跑在了本轮任何消息落库之前（chat-history 回退用例的偶发失败）。
 * 需要绕过游标时用 `mark()` 取当前序号，再显式传 `since`。
 */
export interface EventRecorder {
  install(): Promise<void>
  clear(): Promise<void>
  all<T = RecordedEvent>(): Promise<T[]>
  /** 序号在 `since`（`mark()` 取得）之后的事件 —— 「这一步里发生了什么（没发生什么）」的切片 */
  allSince<T = RecordedEvent>(since: number): Promise<T[]>
  /** 事件类型序列（去掉高频 delta 后更好读；传 true 保留 delta） */
  types(withDeltas?: boolean): Promise<string[]>
  count(type: string): Promise<number>
  /** 当前事件序号（单调递增，不随 clear 归零）—— 作为 `waitFor` 的 `since` 起点 */
  mark(): Promise<number>
  /** 等该 (type, sessionId) 的下一条事件；`since` 显式指定起点。超时抛错 */
  waitFor<T = RecordedEvent>(
    type: string,
    opts?: { timeoutMs?: number; sessionId?: string; since?: number }
  ): Promise<T>
}

/** 收集到的事件（只声明 spec 会读的字段，其余原样保留） */
export interface RecordedEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

const RECORDER_KEY = '__shuvixE2eEvents'
const SEQ_KEY = '__shuvixE2eSeq'
/** 缓冲区里存的是 `{ seq, e }` 包装：序号单调递增且不随 clear 归零，游标才有意义 */
const BUF = `(window.${RECORDER_KEY} ?? [])`

export function eventRecorder(main: CdpClient): EventRecorder {
  /** `${type}|${sessionId}` → 已等到的最大序号（下一次 waitFor 从它之后开始找） */
  const cursors = new Map<string, number>()

  const install = async (): Promise<void> => {
    await main.eval(
      `(() => {
        if (window.${RECORDER_KEY}) return true
        window.${RECORDER_KEY} = []
        window.${SEQ_KEY} = 0
        window.api.agent.onEvent((e) => window.${RECORDER_KEY}.push({ seq: ++window.${SEQ_KEY}, e }))
        return true
      })()`
    )
  }
  const all = <T>(): Promise<T[]> => main.eval<T[]>(`${BUF}.map((w) => w.e)`)

  return {
    install,
    clear: async () => {
      cursors.clear()
      await main.eval(`${BUF}.length = 0`)
    },
    all,
    allSince: <T>(since: number) =>
      main.eval<T[]>(`${BUF}.filter((w) => w.seq > ${since}).map((w) => w.e)`),
    mark: () => main.eval<number>(`window.${SEQ_KEY} ?? 0`),
    types: (withDeltas = false) =>
      main.eval<string[]>(
        `${BUF}
          .map((w) => w.e.type)
          .filter((t) => ${withDeltas} || !t.endsWith('_delta'))`
      ),
    count: (type) =>
      main.eval<number>(`${BUF}.filter((w) => w.e.type === ${JSON.stringify(type)}).length`),
    waitFor: async <T>(
      type: string,
      opts: { timeoutMs?: number; sessionId?: string; since?: number } = {}
    ): Promise<T> => {
      const key = `${type}|${opts.sessionId ?? '*'}`
      const since = opts.since ?? cursors.get(key) ?? 0
      const cond = opts.sessionId
        ? `w.e.type === ${JSON.stringify(type)} && w.e.sessionId === ${JSON.stringify(opts.sessionId)}`
        : `w.e.type === ${JSON.stringify(type)}`
      const hit = await until(
        () =>
          main.eval<{ seq: number; e: T } | null>(
            `${BUF}.find((w) => w.seq > ${since} && ${cond}) ?? null`
          ),
        `chat event ${type}`,
        opts.timeoutMs ?? 30_000
      )
      cursors.set(key, hit.seq)
      return hit.e
    }
  }
}

export interface ProjectSeed {
  name: string
  path: string
  systemPrompt?: string
  envVars?: Array<{ key: string; value: string }>
}

/** 经 IPC 创建项目（path 目录需已存在；envVars 走 settings.tool） */
export async function createProject(main: CdpClient, seed: ProjectSeed): Promise<{ id: string }> {
  return main.eval(
    `window.api.project.create(${JSON.stringify({
      name: seed.name,
      path: seed.path,
      ...(seed.systemPrompt !== undefined ? { systemPrompt: seed.systemPrompt } : {}),
      ...(seed.envVars
        ? { tool: { envVars: seed.envVars.map((v) => ({ ...v, sensitive: false })) } }
        : {})
    })})`
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 知识库（OKF）种子 —— 聊天输入框 `@` 引用「知识库」源的候选来自这里。
//
// 库就是目录：用户库 = `~/.shuvix/knowledge/<库名>/`，项目库 =
// `~/.shuvix/knowledge-shuvix/projects/<projectId>/`。条目 frontmatter 只写 title / description、
// 刻意**不带** shuvix 标记 —— 读宽：没有标记的 md 照样按概念解析（knowledge.ts 的 KNOWLEDGE_MARKER
// 说明），这条宽松路径顺带被钉住。
//
// **播种要在会话于 UI 里激活之前完成**：渲染端 provider 按 sessionId 缓存候选表
// （atMentionProviders），激活后才铺的条目要等 knowledge.changed 重扫才看得见。

export interface KnowledgeEntrySeed {
  /** bundle 内相对路径（如 `notes/token-refresh.md`；条目 id = `<bundle>/<path>`） */
  path: string
  title: string
  description?: string
}

function writeKnowledgeEntries(rootDir: string, entries: KnowledgeEntrySeed[]): void {
  for (const e of entries) {
    const filePath = join(rootDir, ...e.path.split('/'))
    mkdirSync(dirname(filePath), { recursive: true })
    const lines = ['---', `title: ${e.title}`]
    if (e.description) lines.push(`description: ${e.description}`)
    lines.push('---', '', `${e.title} 的正文。`, '')
    writeFileSync(filePath, lines.join('\n'))
  }
}

/** 铺一个用户知识库（`~/.shuvix/knowledge/<库名>/`），返回库目录（空库传 [] —— 库就是目录） */
export function seedKnowledgeBase(
  app: E2EApp,
  name: string,
  entries: KnowledgeEntrySeed[]
): string {
  const dir = join(app.home, '.shuvix', 'knowledge', name)
  mkdirSync(dir, { recursive: true })
  writeKnowledgeEntries(dir, entries)
  return dir
}

/** 铺项目库条目（`~/.shuvix/knowledge-shuvix/projects/<projectId>/`），返回库目录 */
export function seedProjectKnowledgeBase(
  app: E2EApp,
  projectId: string,
  entries: KnowledgeEntrySeed[]
): string {
  const dir = join(app.home, '.shuvix', 'knowledge-shuvix', 'projects', projectId)
  mkdirSync(dir, { recursive: true })
  writeKnowledgeEntries(dir, entries)
  return dir
}

/**
 * 创建会话并让 Agent 完成创建（不触发 LLM），返回运行时信息。
 * 系统提示词断言的标准入口：info.systemPrompt 与实际发给 LLM 的完全一致。
 */
export async function createAgentSession(
  main: CdpClient,
  opts: {
    projectId?: string
    title?: string
    notebookPath?: string
    /** 绑定一个 bot ⇒ 建出来的是 bot 会话：有根，根档案为基座 bot */
    bot?: string
    /**
     * 这条会话用哪几个知识库，**在根 Agent 起来之前**写下 —— 缺省是一个都不启用，而
     * `<knowledge_bases>` 围栏在创建 Agent 那一刻定型，所以要围栏的用例必须先把选择放好。
     */
    knowledgeBases?: string[]
  } = {}
): Promise<{ sid: string; systemPrompt: string }> {
  return main.eval(
    `(async () => {
      const s = await window.api.session.create(${JSON.stringify({
        title: opts.title ?? 'e2e',
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.notebookPath ? { notebookPath: opts.notebookPath } : {}),
        ...(opts.bot ? { bot: opts.bot } : {})
      })})
      const sid = s.id
      ${
        opts.knowledgeBases
          ? `await window.api.session.updateKnowledgeBases({ id: sid, knowledgeBases: ${JSON.stringify(opts.knowledgeBases)} })`
          : ''
      }
      const info = await window.api.agent.getInfo(sid, { ensure: true })
      return { sid, systemPrompt: info.systemPrompt }
    })()`
  )
}

/**
 * 创建一条 bot 会话（`settings.bot` 有值 = 绑定了一个 bot 的**有根**会话），返回 sid。
 *
 * 与 `createAgentSession({ bot })` 的差别是**只 create、不 getInfo**：根 Agent 是懒创建的，
 * 这里不替调用方决定何时建它 —— 「先建会话、再动 md、再让运行时起来」这类用例要的正是这个空档。
 * 形态在创建那一刻定死（不可换绑）。
 */
export async function createBotSession(
  main: CdpClient,
  opts: { bot: string; title?: string; projectId?: string }
): Promise<string> {
  return main.eval(
    `window.api.session.create(${JSON.stringify({
      bot: opts.bot,
      title: opts.title ?? 'e2e-bots',
      ...(opts.projectId ? { projectId: opts.projectId } : {})
    })}).then((s) => s.id)`
  )
}

/** 当前全部会话的 id（`session.list` 的顺序） */
export function listSessionIds(main: CdpClient): Promise<string[]> {
  return main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)
}

/**
 * 记录当前会话 id 集，执行 act 后等到列表里真的冒出新 id，返回新增的那些。
 *
 * **一冒出来就返回**：要断「恰好只建了一条」（如防重入），调用方须自己再留一个落定窗口，
 * 之后用 `listSessionIds` 重列 —— 迟到的第二条这里等不到。
 */
export function newSessionsAfter(main: CdpClient, act: () => Promise<void>): Promise<string[]> {
  return (async () => {
    const before = await listSessionIds(main)
    await act()
    return until(async () => {
      const added = (await listSessionIds(main)).filter((id) => !before.includes(id))
      return added.length > 0 ? added : null
    }, 'a new session created')
  })()
}

/** 绑定了某个 bot 的会话 id（`settings.bot` 精确等于 name）——「只有这一条绑它」的 IPC 判据 */
export function sessionsBoundTo(main: CdpClient, bot: string): Promise<string[]> {
  return main.eval<string[]>(
    `window.api.session.list().then((ss) =>
      ss.filter((s) => s.settings && s.settings.bot === ${JSON.stringify(bot)}).map((s) => s.id))`
  )
}

/** 隔离实例的 SQLite 库文件（`<home>/userdata/data/shuvix.db`） */
export function dbPathOf(home: string): string {
  return join(home, 'userdata', 'data', 'shuvix.db')
}

/** SQL 字符串字面量（sqlite3 CLI 没有参数绑定，值一律经它转义后拼进语句） */
export function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 对隔离实例的库直接跑一段 SQL（系统 sqlite3 CLI），回 stdout 原文。
 *
 * 用系统 sqlite3 而不是 better-sqlite3（先例：`e2e/live/probe.ts`）：后者是为 Electron
 * 编译的，普通 node 里加载会报 NODE_MODULE_VERSION 不符。`.timeout` 挡住与主进程写锁的
 * 偶发相撞 —— 实例在跑时也能读（WAL），改库则应在 `stop({ keepHome: true })` 之后做。
 * `home` 而不是 `app`：停机之后没有 app，只剩 HOME。
 */
export function sqlite(home: string, sql: string, opts: { json?: boolean } = {}): string {
  return execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 3000', ...(opts.json ? ['-json'] : []), dbPathOf(home), sql],
    { encoding: 'utf8' }
  )
}

/** 跑一条查询、按行回 JSON 对象（`sqlite3 -json`；没有行时 CLI 什么都不输出 → 空数组） */
export function sqliteJson<T = Record<string, unknown>>(home: string, sql: string): T[] {
  const out = sqlite(home, sql, { json: true }).trim()
  return out ? (JSON.parse(out) as T[]) : []
}

/**
 * 主进程日志里的一条安全决策（`security_decision {json}`，见 agent-runtime security/decisionLog.ts）。
 *
 * 每一次 enforce 都记一条 —— **放行也记**（L1 全工具门除外：它的放行是非事件）。这是断言
 * 「门到底有没有被过、按什么客体、谁赢了」的与语言无关的入口：询问卡片的文案随界面语言变，
 * 这里的字段不变。只声明断言会读的字段。
 */
export interface SecurityDecisionEntry {
  ts: number
  sessionId: string
  toolCallId: string
  toolName: string
  action: string
  /** 客体 type（'path' / 'url' / 'invocation' / …） */
  objectKind: string
  /** 路径全量 / 命令与 url 截断 200 字符 */
  objectSummary: string
  effect: 'allow' | 'ask' | 'deny'
  matched: string[]
  /** 胜出规则 id（`<policy>#<i>`），未命中任何规则时是 `default:<type>` */
  winning: string
  userResponse?: 'allowed' | 'allowed_remember' | 'denied' | 'feedback' | 'cancel'
}

/** 此刻主进程日志里的全部安全决策（按写入顺序）；解析不了的行跳过 */
export function securityDecisions(app: E2EApp): SecurityDecisionEntry[] {
  const MARK = 'security_decision '
  const out: SecurityDecisionEntry[] = []
  for (const line of app.mainLog().split('\n')) {
    const at = line.indexOf(MARK)
    if (at < 0) continue
    try {
      out.push(JSON.parse(line.slice(at + MARK.length)) as SecurityDecisionEntry)
    } catch {
      /* 被截断的行（日志正在写） */
    }
  }
  return out
}

/**
 * 绕过 API 直接往会话行的 settings 里写 `agentProfile`（系统 sqlite3 CLI 直写，见 `sqlite`）。
 *
 * 今天唯一会写这个键的入口是 session 工具 `create-sub-session` 的 `agent_profile`（经
 * sessionService.pinAgentProfile），它没有 IPC 面；「根会话残留的戳被忽略」「子会话的戳生效」
 * 这两类断言都需要一条**带戳但没经过 pin** 的会话，只能这样造。
 *
 * 主进程不缓存会话行（写完即生效），但运行时是懒建的：戳要写在首次
 * `agent.getInfo(sid, { ensure: true })` 之前，或写完后 `message.clear(sid)` 让它失效重建。
 */
export async function stampAgentProfile(app: E2EApp, sid: string, name: string): Promise<void> {
  sqlite(
    app.home,
    `UPDATE sessions SET settings = json_set(settings, '$.agentProfile', ${sqlLit(name)}) WHERE id = ${sqlLit(sid)}`
  )
  const settings = await app.main.eval<Record<string, unknown> | undefined>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s && s.settings)`
  )
  if (settings?.agentProfile !== name) {
    throw new Error(`agentProfile stamp did not land: settings=${JSON.stringify(settings)}`)
  }
}

/**
 * 建一条**带戳的子会话**：经 IPC `session.create({ parentId })` 直建（projectId 恒随父），
 * 再 sqlite 直写 `settings.agentProfile`。等价于 session 工具 `create-sub-session` 带
 * `agent_profile` 落库之后的形态，但**不经 pinAgentProfile** —— 准入与种子（模型 /
 * mcp:/skill: 替换）那半截只能在 sessions/ 区用假提供商脚本化的工具调用打；这里只要一条
 * 「带戳的子会话」给运行时去推导（systemPrompt / 内置工具白名单随戳走）。
 *
 * 返回子会话 id。**不 ensure**：调用方决定何时建运行时（戳已在 create 之后落下）。
 */
export async function createPinnedChildSession(
  app: E2EApp,
  opts: { parentSid: string; agentProfile: string; title?: string }
): Promise<string> {
  const sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({
      parentId: opts.parentSid,
      title: opts.title ?? `pinned:${opts.agentProfile}`
    })}).then((s) => s.id)`
  )
  await stampAgentProfile(app, sid, opts.agentProfile)
  return sid
}

/** 发送 prompt 并容忍 LLM 失败（无 API key），等事件落定后返回消息列表 */
export async function promptAndListMessages(
  main: CdpClient,
  sid: string,
  text = 'hi'
): Promise<Array<{ content?: unknown; metadata?: Record<string, unknown> }>> {
  await main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined)`
  )
  await sleep(1500)
  return main.eval(`window.api.message.list(${JSON.stringify(sid)})`)
}

// ─────────────────────────────────────────────────────────────────────────
// 注册表笔记（bot / agent / 安全策略 / hook md 的笔记本会话）
//
// 四类注册表 md 的打开 / 编辑路径是「一份文件 = 一条笔记本会话」：会话挂在该注册表目录的
// **隐藏项目**下（id 见 chat-protocol 的 REGISTRY_NOTE_PROJECT_IDS，path = 目录本身），
// notebookPath 就是文件名。这些会话照样出现在 `session.list()` / `listSessionIds` /
// `newSessionsAfter` 里 —— 计数时按 projectId 过滤。

export { REGISTRY_NOTE_PROJECT_IDS, type RegistryNoteKind }

/** kind → window.api 上的命名空间（agent 的 IPC 历史上叫 subAgent） */
const REGISTRY_API: Record<RegistryNoteKind, string> = {
  bot: 'bot',
  agent: 'subAgent',
  // 内置档案是只读的：没有写路径，开笔记本走 subAgent.openBuiltinNote（按 agent 名，不是文件名）
  agentBuiltin: 'subAgent',
  policy: 'policy',
  // 内置策略是只读的：没有写路径，开笔记本走 policy.openBuiltinNote（按策略名，不是文件名）
  policyBuiltin: 'policy',
  hook: 'hook',
  // 内置 hook 是只读的：没有写路径，开笔记本走 hook.openBuiltinNote（按 hook 名，不是文件名）
  hookBuiltin: 'hook'
}

export interface RegistryNoteSession {
  id: string
  notebookPath: string
  title: string
}

/** 某个注册表隐藏项目下的全部笔记本会话（`session.list` 的顺序） */
export function registryNoteSessions(
  main: CdpClient,
  projectId: string
): Promise<RegistryNoteSession[]> {
  return main.eval<RegistryNoteSession[]>(
    `window.api.session.list().then((ss) => ss
      .filter((s) => s.projectId === ${JSON.stringify(projectId)})
      .map((s) => ({ id: s.id, notebookPath: (s.settings && s.settings.notebookPath) || '', title: s.title })))`
  )
}

/** `<ns>.openNote` 的结果：成功带会话要素，失败带 IPC 拒绝消息（不抛，便于断言原因） */
export type OpenNoteOutcome =
  | {
      ok: true
      id: string
      projectId: string | null
      notebookPath: string
      title: string
      workingDirectory: string
    }
  | { ok: false; error: string }

/** 打开 / 复用一份注册表文件的笔记本会话（IPC 直调，不经 UI） */
export function openRegistryNote(
  main: CdpClient,
  kind: RegistryNoteKind,
  fileName: string
): Promise<OpenNoteOutcome> {
  return main.eval<OpenNoteOutcome>(
    `window.api.${REGISTRY_API[kind]}.openNote(${JSON.stringify({ fileName })}).then(
      (s) => ({
        ok: true,
        id: s.id,
        projectId: s.projectId,
        notebookPath: (s.settings && s.settings.notebookPath) || '',
        title: s.title,
        workingDirectory: s.workingDirectory || ''
      }),
      (e) => ({ ok: false, error: String(e && e.message ? e.message : e) })
    )`
  )
}

/**
 * 写路径 IPC：`<ns>.openNote({ fileName })` 打开 / 复用这份文件的笔记本会话，再经 `files.write`
 * 落盘 —— 与笔记本自动保存同一个 writeSessionFile（原子写 + bot 文件的写入回执）。用它代替
 * 「往 CodeMirror 里打字」。同一文件的连续写入要**串行**：writeSessionFile 的临时文件名按
 * 「文件 + 进程」固定，并发写会互相踩。
 */
export function noteWrite(
  main: CdpClient,
  kind: RegistryNoteKind,
  fileName: string,
  content: string
): Promise<{ ok: boolean; error?: string }> {
  return main.eval<{ ok: boolean; error?: string }>(
    `(async () => {
      const session = await window.api.${REGISTRY_API[kind]}.openNote(${JSON.stringify({ fileName })})
      return window.api.files.write({
        sessionId: session.id,
        path: ${JSON.stringify(fileName)},
        content: ${JSON.stringify(content)}
      })
    })()`
  )
}

/**
 * 页内 AppEvent 收集器（`window.api.events.subscribe` 旁挂，与应用自身的 useAppEvent 并行接收）。
 * 与 ChatEvent 的 eventRecorder 分开：AppEvent 走的是另一条 IPC（`app:event`），载荷也不分会话。
 * 收集器是全局的；每段断言前 `clear()` 一次。
 */
export interface AppEventRecorder {
  install(): Promise<void>
  clear(): Promise<void>
  count(type: string): Promise<number>
  types(): Promise<string[]>
}

const APP_EVENTS_KEY = '__shuvixE2eAppEvents'

export function appEventRecorder(main: CdpClient): AppEventRecorder {
  const BUFFER = `(window.${APP_EVENTS_KEY} ?? [])`
  return {
    install: async () => {
      await main.eval(
        `(() => {
          if (window.${APP_EVENTS_KEY}) return true
          window.${APP_EVENTS_KEY} = []
          window.api.events.subscribe((e) => window.${APP_EVENTS_KEY}.push(e))
          return true
        })()`
      )
    },
    clear: async () => {
      await main.eval(`${BUFFER}.length = 0`)
    },
    count: (type) =>
      main.eval<number>(`${BUFFER}.filter((e) => e.type === ${JSON.stringify(type)}).length`),
    types: () => main.eval<string[]>(`${BUFFER}.map((e) => e.type)`)
  }
}

/**
 * 等一份文件被重写并落定，回落定后的全文（调用方再对它做 toBe 全等，失败时给得出 diff）。
 * 落定 = 与旧值不同 + 非空 + **连续两次轮询读到一致**：自动保存是 200ms 防抖，外部写入方
 * 「先截断再写」时还可能读到半截（实测撞到过一次）。
 */
export async function waitFileWritten(
  filePath: string,
  before: string,
  what = `file rewritten: ${filePath}`
): Promise<string> {
  let last = ''
  await until(() => {
    const now = readFileSync(filePath, 'utf8')
    const settled = now !== before && now !== '' && now === last
    last = now
    return settled
  }, what)
  return last
}

/** 「不该写盘」的探针：跨过防抖窗口后仍逐字节相同 */
export async function expectFileUnchanged(
  filePath: string,
  expected: string,
  waitMs = 500
): Promise<void> {
  await sleep(waitMs)
  expect(readFileSync(filePath, 'utf8')).toBe(expected)
}
