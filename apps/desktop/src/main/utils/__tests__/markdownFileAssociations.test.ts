/**
 * md 文件关联的打包配置 —— 静态检查（electron-builder.yml + build/），扫的是**配置本身**。
 *
 * 契约（2026-10-11）：安装包**不登记任何文件关联** —— 不进 macOS / Linux 的 fileAssociations，
 * Windows 不再写 OpenWithProgids（曾经的 build/installer.nsh 已删）。用户想用 ShuviX 打开 md，
 * 自己在「打开方式 → 其他…」里手动选；运行时的接收（open-file / argv / second-instance）照旧保留。
 *
 * 这些错了不会有任何一条运行时用例变红 —— 它们只在别人的机器上装包时才显形，所以按文本钉住。
 *
 *   PK-1 顶层 / mac / linux / win / nsis / deb 都没有 fileAssociations
 *   PK-2 nsis 不 include 自定义脚本；build/installer.nsh 不存在（electron-builder 会自动引入它）
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/utils/__tests__` 往上四层 = apps/desktop */
const DESKTOP_DIR = resolve(HERE, '../../../..')
const BUILDER_YML = join(DESKTOP_DIR, 'electron-builder.yml')

let yml: Record<string, Record<string, unknown> | undefined>

beforeAll(() => {
  yml = parse(readFileSync(BUILDER_YML, 'utf8')) as typeof yml
})

describe('安装包不登记文件关联', () => {
  it('PK-1 顶层与各平台段都没有 fileAssociations', () => {
    expect(yml).not.toHaveProperty('fileAssociations')
    for (const section of ['mac', 'linux', 'win', 'nsis', 'deb', 'appImage', 'dmg']) {
      expect(yml[section] ?? {}, section).not.toHaveProperty('fileAssociations')
    }
  })

  it('PK-2 没有 NSIS 自定义脚本（installer.nsh 会被 electron-builder 自动引入）', () => {
    expect(yml.nsis ?? {}).not.toHaveProperty('include')
    const buildResources =
      (yml.directories as { buildResources?: string } | undefined)?.buildResources ?? 'build'
    expect(existsSync(join(DESKTOP_DIR, buildResources, 'installer.nsh'))).toBe(false)
  })
})
