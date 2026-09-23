/**
 * md 文件关联的打包配置 —— 静态检查（electron-builder.yml + build/installer.nsh），扫的是**配置本身**。
 *
 * 契约：「用 ShuviX 打开」只进各平台的「打开方式」，**不抢**用户的默认 md 应用；扩展名表只有一份
 * （utils/markdownFiles 的 MARKDOWN_EXTENSIONS），三个平台的登记都跟着它。
 *   - macOS：fileAssociations，role Editor、rank Alternate（Alternate = 进列表、不当默认）；
 *   - Linux：fileAssociations 带 mimeType text/markdown（deb 的 .desktop 声明 MimeType）；
 *   - Windows：**不**走 fileAssociations（electron-builder 的 NSIS 模板会把扩展名的默认值写成自己的
 *     ProgID），改由 build/installer.nsh 在 customInstall 里只写 OpenWithProgids、卸载时只删自己写的。
 *
 * 这些错了不会有任何一条运行时用例变红 —— 它们只在别人的机器上装包时才显形（默认应用被抢走、卸载后
 * 残留一个坏掉的 ProgID），所以按文本钉住。
 *
 *   PK-1 mac.fileAssociations：扩展名集合 = MARKDOWN_EXTENSIONS 去点；每条 role Editor、rank Alternate
 *   PK-2 linux.fileAssociations：mimeType text/markdown；扩展名集合同上
 *   PK-3 顶层 / win / nsis 都没有 fileAssociations；directories.buildResources 是 build；
 *        nsis.include 缺省或就是 build/installer.nsh；那份文件存在
 *   PK-4 customInstall：写 ProgID 键与 shell\open\command = "$appExe" "%1"；给 .md / .markdown 各写一个
 *        OpenWithProgids 值；从不写 .md / .markdown 键的默认值；不碰 UserChoice
 *   PK-5 customUnInstall（名字一字不差）：删那两个值与 ProgID 键；从不 DeleteRegKey .md / .markdown
 *   PK-6 .nsh 里登记的扩展名集合 = MARKDOWN_EXTENSIONS
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { MARKDOWN_EXTENSIONS } from '../markdownFiles'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/utils/__tests__` 往上四层 = apps/desktop */
const DESKTOP_DIR = resolve(HERE, '../../../..')
const BUILDER_YML = join(DESKTOP_DIR, 'electron-builder.yml')

interface FileAssociation {
  ext?: string | string[]
  name?: string
  role?: string
  rank?: string
  mimeType?: string
}

type Yml = Record<string, unknown> & {
  directories?: { buildResources?: string }
  mac?: { fileAssociations?: FileAssociation[] }
  linux?: { fileAssociations?: FileAssociation[] }
  win?: Record<string, unknown>
  nsis?: Record<string, unknown>
}

let yml: Yml
let nsh: string

/** 期望的扩展名集合（去点、排序） */
const EXPECTED_EXTS = [...MARKDOWN_EXTENSIONS].map((e) => e.replace(/^\./, '')).sort()

function extsOf(list: FileAssociation[] | undefined): string[] {
  const all = (list ?? []).flatMap((a) =>
    Array.isArray(a.ext) ? a.ext : a.ext !== undefined ? [a.ext] : []
  )
  return [...new Set(all.map((e) => String(e).replace(/^\./, '').toLowerCase()))].sort()
}

// ─── .nsh 的最小解析：!define 展开、按 macro 取正文、按 NSIS 规则切参数 ──────────────

/** 去掉注释行（`;` / `#` 开头），保留指令行 */
function codeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';') && !l.startsWith('#'))
}

/** `!define NAME "value"` 表 */
function definesOf(text: string): Map<string, string> {
  const defs = new Map<string, string>()
  for (const line of codeLines(text)) {
    const m = /^!define\s+(\S+)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(line)
    if (m) defs.set(m[1], m[2] ?? m[3] ?? m[4] ?? '')
  }
  return defs
}

/** 按 NSIS 的规则切一行参数：双引号 / 单引号 / 反引号包起来的是一个参数（引号不算内容） */
function nsisArgs(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = line.indexOf(ch, i + 1)
      if (end < 0) throw new Error(`unterminated quote in: ${line}`)
      out.push(line.slice(i + 1, end))
      i = end + 1
      continue
    }
    let j = i
    while (j < line.length && !/\s/.test(line[j])) j++
    out.push(line.slice(i, j))
    i = j
  }
  return out
}

interface Instr {
  op: string
  args: string[]
}

/** 取某个 macro 的指令（`!define` 已展开）；没有这个 macro 回 null */
function macroInstrs(text: string, name: string): Instr[] | null {
  const defs = definesOf(text)
  const lines = codeLines(text)
  const start = lines.findIndex((l) => new RegExp(`^!macro\\s+${name}\\s*$`).test(l))
  if (start < 0) return null
  const out: Instr[] = []
  for (const raw of lines.slice(start + 1)) {
    if (/^!macroend\b/.test(raw)) return out
    const line = raw.replace(/\$\{([A-Za-z0-9_]+)\}/g, (all, key: string) => defs.get(key) ?? all)
    const [op, ...args] = nsisArgs(line)
    out.push({ op, args })
  }
  throw new Error(`macro ${name} has no !macroend`)
}

/** 注册表键路径统一成小写 + 反斜杠（NSIS / 注册表都不分大小写） */
const keyOf = (k: string): string => k.replace(/\//g, '\\').toLowerCase()

const NSH_PATH = join(DESKTOP_DIR, 'build', 'installer.nsh')

beforeAll(() => {
  yml = parse(readFileSync(BUILDER_YML, 'utf8')) as Yml
  // 文件不在时读成空串：PK-3 会以「文件不存在」红，而不是整个文件在 beforeAll 里炸掉
  nsh = existsSync(NSH_PATH) ? readFileSync(NSH_PATH, 'utf8') : ''
})

describe('PK-1 / PK-2 macOS 与 Linux 的 fileAssociations', () => {
  it('PK-1 mac：扩展名集合 = MARKDOWN_EXTENSIONS；每条 role Editor、rank Alternate', () => {
    const list = yml.mac?.fileAssociations
    expect(Array.isArray(list) && list.length > 0).toBe(true)
    expect(extsOf(list)).toEqual(EXPECTED_EXTS)
    for (const assoc of list!) {
      expect(assoc.role).toBe('Editor')
      expect(assoc.rank).toBe('Alternate')
    }
  })

  it('PK-2 linux：mimeType text/markdown；扩展名集合同上', () => {
    const list = yml.linux?.fileAssociations
    expect(Array.isArray(list) && list.length > 0).toBe(true)
    expect(extsOf(list)).toEqual(EXPECTED_EXTS)
    for (const assoc of list!) expect(assoc.mimeType).toBe('text/markdown')
  })
})

describe('PK-3 Windows 不走 fileAssociations，走 installer.nsh', () => {
  it('PK-3 顶层 / win / nsis 都没有 fileAssociations', () => {
    expect(yml).not.toHaveProperty('fileAssociations')
    expect(yml.win ?? {}).not.toHaveProperty('fileAssociations')
    expect(yml.nsis ?? {}).not.toHaveProperty('fileAssociations')
  })

  it('PK-3 buildResources 是 build；nsis.include 缺省或就是 build/installer.nsh；那份文件存在', () => {
    expect(yml.directories?.buildResources).toBe('build')
    const include = yml.nsis?.include
    expect(include === undefined || include === 'build/installer.nsh').toBe(true)
    expect(existsSync(NSH_PATH)).toBe(true)
  })
})

describe('PK-4 ~ PK-6 installer.nsh', () => {
  /** customInstall 里写 OpenWithProgids 的那几条：扩展名 → ProgID（值名） */
  function openWithProgids(instrs: Instr[]): Map<string, string> {
    const out = new Map<string, string>()
    for (const { op, args } of instrs) {
      if (op !== 'WriteRegStr') continue
      const m = /^software\\classes\\(\.[^\\]+)\\openwithprogids$/.exec(keyOf(args[1] ?? ''))
      if (m) out.set(m[1], args[2] ?? '')
    }
    return out
  }

  it('PK-4 customInstall：ProgID 的打开命令是 "$appExe" "%1"；.md / .markdown 各一个 OpenWithProgids 值', () => {
    const instrs = macroInstrs(nsh, 'customInstall')
    expect(instrs).not.toBeNull()
    const progIds = openWithProgids(instrs!)
    expect([...progIds.keys()].sort()).toEqual([...MARKDOWN_EXTENSIONS].sort())
    const progId = [...new Set(progIds.values())]
    expect(progId).toHaveLength(1)
    expect(progId[0]).toMatch(/\S/)

    const command = instrs!.find(
      (i) =>
        i.op === 'WriteRegStr' &&
        keyOf(i.args[1] ?? '') === keyOf(`Software\\Classes\\${progId[0]}\\shell\\open\\command`)
    )
    expect(command).toBeDefined()
    // 值名是空串（键的默认值），值是带引号的 exe + 带引号的 %1（路径里有空格时不被劈开）
    expect(command!.args[2]).toBe('')
    expect(command!.args[3]).toBe('"$appExe" "%1"')
  })

  it('PK-4 customInstall 从不写 .md / .markdown 键的默认值，也不碰 UserChoice', () => {
    const instrs = macroInstrs(nsh, 'customInstall')!
    for (const ext of MARKDOWN_EXTENSIONS) {
      const extKey = keyOf(`Software\\Classes\\${ext}`)
      const writesDefault = instrs.some(
        (i) => i.op === 'WriteRegStr' && keyOf(i.args[1] ?? '') === extKey && i.args[2] === ''
      )
      expect(writesDefault).toBe(false)
      // 扩展名键本身只许出现在 OpenWithProgids 这一层
      const touched = instrs
        .filter((i) => /^(WriteReg|DeleteReg)/.test(i.op))
        .map((i) => keyOf(i.args[1] ?? ''))
        .filter((k) => k === extKey || k.startsWith(`${extKey}\\`))
      expect(touched.every((k) => k === `${extKey}\\openwithprogids`)).toBe(true)
    }
    expect(/userchoice/i.test(nsh)).toBe(false)
  })

  it('PK-5 customUnInstall（名字一字不差）：删两个 OpenWithProgids 值与 ProgID 键；从不 DeleteRegKey 扩展名', () => {
    // electron-builder 只认 customUnInstall —— 写成 customUninstall 的宏永远不会被调用
    expect(/^!macro\s+customUninstall\b/m.test(nsh)).toBe(false)
    const install = macroInstrs(nsh, 'customInstall')!
    const progId = [...new Set(openWithProgids(install).values())][0]
    const instrs = macroInstrs(nsh, 'customUnInstall')
    expect(instrs).not.toBeNull()

    for (const ext of MARKDOWN_EXTENSIONS) {
      const del = instrs!.find(
        (i) =>
          i.op === 'DeleteRegValue' &&
          keyOf(i.args[1] ?? '') === keyOf(`Software\\Classes\\${ext}\\OpenWithProgids`)
      )
      expect(del?.args[2]).toBe(progId)
      const nukesExt = instrs!.some(
        (i) =>
          i.op === 'DeleteRegKey' &&
          keyOf(i.args[i.args[0]?.startsWith('/') ? 2 : 1] ?? '').startsWith(
            keyOf(`Software\\Classes\\${ext}`)
          )
      )
      expect(nukesExt).toBe(false)
    }
    const delProgId = instrs!.find(
      (i) =>
        i.op === 'DeleteRegKey' &&
        keyOf(i.args[i.args[0]?.startsWith('/') ? 2 : 1] ?? '') ===
          keyOf(`Software\\Classes\\${progId}`)
    )
    expect(delProgId).toBeDefined()
  })

  it('PK-6 .nsh 里登记的扩展名集合 = MARKDOWN_EXTENSIONS', () => {
    const exts = new Set<string>()
    for (const m of nsh.matchAll(/Software\\Classes\\(\.[A-Za-z0-9]+)\\/g)) {
      exts.add(m[1].toLowerCase())
    }
    expect([...exts].sort()).toEqual([...MARKDOWN_EXTENSIONS].sort())
  })
})
