/**
 * 侧栏「Bots」分组 + 主区 bot 档案页（UI 冒烟）。
 *
 * 分组读 `~/.shuvix/bots/`：合法 bot 一行一个，解析不过的文件以琥珀行呈现；点一行主区切到
 * bot 档案页。旧 Bots 拆除之后侧栏只剩这一个 Bots 分组 —— UI-1 钉的就是「没有第二个，
 * 标签里也没有「旧 / legacy」残留」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { writeBotMd, waitRendererReady } from '../../harness/seed'
import { botsPane } from '../../harness/pages'

let app: E2EApp
let bots: ReturnType<typeof botsPane>

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  writeBotMd(app, 'scout', { displayName: 'Scout', body: 'I am Scout.' })
  bots = botsPane(app.main)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('分组', () => {
  it('UI-1 侧栏只有一个 Bots 分组，标签不带「旧 / legacy」', async () => {
    await bots.expand()
    expect(await bots.headerCount()).toBe(1)
    const label = await bots.label()
    expect(label).toBeTruthy()
    expect(label).not.toMatch(/旧|legacy/i)
  })

  it('UI-2 读 ~/.shuvix/bots：合法 bot 一行一个', async () => {
    await bots.expand()
    expect(await bots.rows()).toEqual(['scout'])
  })
})

describe('点一行开档案页', () => {
  it('UI-3 点 bot 行 → bot 档案页（edit 态）', async () => {
    await bots.expand()
    await bots.selectRow('scout')
    expect(await bots.pageKind()).toBe('edit')
  })

  it('UI-4 解析不过的文件以琥珀行呈现（而不是被当成 bot 读进去）', async () => {
    // 一份 agent md 掉进 bots 目录 —— 标记类型不符，整份拒绝
    writeBotMd(app, 'stray', { marker: 'agent v1' })
    await bots.expand()
    await bots.refresh()
    expect(await bots.invalidRows()).toContain('stray.md')
    expect(await bots.rows()).not.toContain('stray')
  })
})
