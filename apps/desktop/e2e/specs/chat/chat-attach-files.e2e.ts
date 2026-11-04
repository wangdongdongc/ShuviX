/**
 * 输入框添加任意文件（真实实例）：文件经真的 `<input type=file>` / DataTransfer 进来，路径是 webUtils 从 File 对象
 * 取到的（CDP 的 DOM.setFileInputFiles 给的是磁盘上的真文件）。
 *
 *  - AF-E1 「+」里是「添加文件」；选一个家目录里的文件 → 胶囊；**发送之前**权限表里没有它；
 *  - AF-E2 发送：模型收到绝对路径；权限表多一行读（来源 user）；read 工具不问、受限命令读得到（沙箱可用时）；
 *          同目录里没添加的文件照旧要问 —— 授权的是那一个文件；
 *  - AF-E3 胶囊删掉再发：不授权；
 *  - AF-E4 真的 File 对象经 drop 事件进来：路径照样取得到；工作目录里的文件成胶囊，但权限表不多一行；
 *  - AF-E5 模型能看图时图片仍是图片（请求里是 image），图片与文件混着选各走各的。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { syncProbe, type SyncProbe } from '../../harness/sync'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  sandboxAvailable,
  seedFakeProvider,
  setSandboxEnabled,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 6 }
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let probe: SyncProbe
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
let docsDir = ''
let reportPath = ''
let siblingPath = ''
let imagePath = ''
let scratch = ''
const sids: Record<string, string> = {}

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(`(async () => {
    const s = await window.api.session.create({ title: ${JSON.stringify(title)}, projectId: ${JSON.stringify(projectId)} })
    return s.id
  })()`)

/** 经真的文件选择框选文件（真文件、真 File 对象） */
async function chooseFiles(paths: string[]): Promise<void> {
  const { result } = await app.main.send<{ result: { objectId: string } }>('Runtime.evaluate', {
    expression: `document.querySelector('input[data-attach-input]')`
  })
  await app.main.send('DOM.setFileInputFiles', { files: paths, objectId: result.objectId })
}

/** 用文件选择框造出真的 File 对象，再装进 DataTransfer 触发 drop（CDP 没有直接拖文件的办法） */
async function dropFiles(paths: string[]): Promise<void> {
  await app.main.eval(`(() => {
    const input = document.querySelector('input[data-attach-input]')
    window.__dropInput = input.cloneNode()
    window.__dropInput.removeAttribute('data-attach-input')
    window.__dropInput.setAttribute('data-e2e-drop', '')
    document.body.appendChild(window.__dropInput)
  })()`)
  const { result } = await app.main.send<{ result: { objectId: string } }>('Runtime.evaluate', {
    expression: `document.querySelector('input[data-e2e-drop]')`
  })
  await app.main.send('DOM.setFileInputFiles', { files: paths, objectId: result.objectId })
  await app.main.eval(`(() => {
    const dt = new DataTransfer()
    for (const file of window.__dropInput.files) dt.items.add(file)
    document.querySelector('textarea').dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
    )
    window.__dropInput.remove()
  })()`)
}

const userGrants = (sid: string): Promise<Array<{ target: string; access: string }>> =>
  app.main.eval(
    `window.api.session.listAcl(${JSON.stringify(sid)}).then((rows) => rows.filter((r) => r.source === 'user').map((r) => ({ target: r.target, access: r.access })))`
  )

const toolResultText = async (sid: string, id: string): Promise<string> =>
  String((await probe.waitToolResult(sid, id, 10_000)).result)

async function open(title: string): Promise<void> {
  provider.reset()
  await events.clear()
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

beforeAll(async () => {
  app = await launchApp()
  await setSandboxEnabled(app.main, true)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-attach')
  docsDir = join(app.home, 'Documents')
  mkdirSync(projDir, { recursive: true })
  mkdirSync(docsDir, { recursive: true })
  reportPath = join(docsDir, 'report final.txt')
  siblingPath = join(docsDir, 'not-attached.txt')
  writeFileSync(reportPath, 'REPORT-E2E\n')
  writeFileSync(siblingPath, 'SIBLING-E2E\n')
  writeFileSync(join(projDir, 'inside.log'), 'INSIDE-E2E\n')
  scratch = mkdtempSync('/private/tmp/shuvix-e2e-attach-')
  imagePath = join(scratch, 'dot.png')
  writeFileSync(imagePath, PNG_1X1)

  const project = await createProject(app.main, { name: 'AttachProj', path: projDir })
  for (const title of ['S-send', 'S-removed', 'S-drop', 'S-mixed']) {
    sids[title] = await createSession(title, project.id)
  }
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('S-send'), 'sidebar list refreshed')
  events = eventRecorder(app.main)
  await events.install()
  probe = syncProbe(app.main)
  await probe.install()
})

afterAll(async () => {
  await app?.stop()
  await provider?.close()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('添加任意文件', () => {
  it('AF-E1/2 选文件 → 胶囊，发送才授权；read 与受限命令都读得到，别的文件照旧要问', async (ctx) => {
    const sid = sids['S-send']!
    await open('S-send')
    await app.main.eval(`document.querySelector('[data-attach-button]').click()`)
    await until(
      () =>
        app.main.eval<boolean>(
          `document.querySelector('[data-plus-files]')?.textContent === 'Add files'`
        ),
      'the + menu offers files'
    )
    expect(await app.main.eval(`document.querySelector('[data-plus-images]') === null`)).toBe(true)
    await app.main.eval(`document.querySelector('[data-attach-button]').click()`)

    await chooseFiles([reportPath])
    await until(async () => (await chat.composerChips()).length === 1, 'chip appears')
    expect(await chat.composerChips()).toEqual(['@report final.txt'])
    expect(await userGrants(sid)).toEqual([])

    provider.script(
      {
        toolCalls: [{ id: 'read_it', name: 'read', args: JSON.stringify({ path: reportPath }) }],
        usage: USAGE
      },
      {
        toolCalls: [
          {
            id: 'cat_it',
            name: 'bash',
            args: JSON.stringify({
              command: `cat ${JSON.stringify(reportPath)}`,
              description: 'read it'
            })
          }
        ],
        usage: USAGE
      },
      { text: 'done', usage: USAGE }
    )
    await chat.pressEnter()
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()

    expect(provider.chatRequests()[0]!.lastUserText).toContain(`[file: ${reportPath}]`)
    expect(await userGrants(sid)).toEqual([{ target: reportPath, access: 'read' }])
    expect(await asksRaisedIn(events, sid)).toBe(0)
    expect(await toolResultText(sid, 'read_it')).toContain('REPORT-E2E')
    if (await sandboxAvailable(app.main)) {
      expect(await toolResultText(sid, 'cat_it')).toContain('REPORT-E2E')
    } else {
      ctx.annotate('sandbox unavailable: the confined command was not checked')
    }

    // 同目录没添加的文件：照旧要问
    provider.reset()
    provider.script(
      {
        toolCalls: [
          { id: 'read_other', name: 'read', args: JSON.stringify({ path: siblingPath }) }
        ],
        usage: USAGE
      },
      { text: 'done', usage: USAGE }
    )
    await chat.typeAndSend('and this one')
    const ask = await probe.nextAsk(sid)
    expect(JSON.stringify(ask)).toContain('not-attached.txt')
    await app.main.eval(
      `window.api.agent.respondToInput({ sessionId: ${JSON.stringify(sid)}, requestId: ${JSON.stringify(ask.id)}, response: { kind: 'ask', allowed: false } })`
    )
    await chat.waitIdle()
  })

  it('AF-E3 胶囊删掉再发：不授权', async () => {
    const sid = sids['S-removed']!
    await open('S-removed')
    await chooseFiles([reportPath])
    await until(async () => (await chat.composerChips()).length === 1, 'chip appears')
    provider.script({ text: 'done', usage: USAGE })
    await chat.typeAndSend('never mind')
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(provider.chatRequests()[0]!.lastUserText).not.toContain(reportPath)
    expect(await userGrants(sid)).toEqual([])
  })

  it('AF-E4 drop 进来的真 File：路径取得到；工作目录里的文件不多一行', async () => {
    const sid = sids['S-drop']!
    const inside = join(projDir, 'inside.log')
    await open('S-drop')
    await dropFiles([inside])
    await until(async () => (await chat.composerChips()).length === 1, 'chip appears')
    expect(await chat.composerChips()).toEqual(['@inside.log'])
    provider.script({ text: 'done', usage: USAGE })
    await chat.pressEnter()
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    const sent = provider.chatRequests()[0]!.lastUserText
    expect(sent).toContain('[file: ')
    expect(sent).toContain('inside.log]')
    expect(await userGrants(sid)).toEqual([])
  })

  it('AF-E5 模型能看图：图片与文件混着选，图片仍是图片，文件成胶囊并授权', async () => {
    const sid = sids['S-mixed']!
    await open('S-mixed')
    await chooseFiles([imagePath, reportPath])
    await until(
      async () => (await chat.composerChips()).includes('@report final.txt'),
      'file chip appears'
    )
    expect(await chat.composerChips()).toEqual(['@report final.txt'])
    provider.script({ text: 'done', usage: USAGE })
    await chat.pressEnter()
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    const body = JSON.stringify(provider.chatRequests()[0]!.body)
    expect(body).toContain('image_url')
    expect(await userGrants(sid)).toEqual([{ target: reportPath, access: 'read' }])
  })
})
