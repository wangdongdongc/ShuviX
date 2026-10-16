#!/usr/bin/env node
// 打包之后验一遍：每个架构的安装包里，按平台拆包的原生依赖都带着**它自己架构**的那一份。
//
// 背景见 add-cross-natives.mjs：一台机器给两个架构打包，另一个架构的包曾经带着本机的二进制
// （arm64 的 deb 里只有 @vscode/ripgrep-linux-x64），启动即崩，而构建一路绿灯。这里在上传之前拦住。
//
// 做法：找出 dist 下每个 app.asar（linux-unpacked / linux-arm64-unpacked、mac / mac-arm64 的 .app、
// win-unpacked / win-arm64-unpacked），从路径认架构（含 arm64 → arm64，否则 x64），列出 asar 里
// node_modules 顶层的平台包（名字里带 -<os>-<cpu>），按去掉平台后缀的「家族」分组：包里出现过的每个家族，
// 只要 lockfile 里有它 <os>-<本架构> 的成员（上游发布了这个架构的二进制），包里就必须带着；上游没发布的
// （@napi-rs/canvas 没有 win32-arm64）只记一行。
//
// 第二道：app.asar.unpacked 里每个原生二进制（.node、ripgrep、node-pty 的 spawn-helper …）读文件头
// （ELF / Mach-O / PE）认出它是哪个系统、哪个 CPU 的 —— 本系统的二进制必须是本架构的。从源码编译的模块
// （better-sqlite3、node-pty）不在任何平台包里，第一道看不见它们：v0.2.13 的 Linux arm64 包里它们是
// x86-64 的（交叉编译时用错了编译器），一启动就崩。路径里写明是别的系统 / 架构的文件（平台包的另一个
// 架构、node-pty 自带的 prebuilds/<os>-<arch>）是故意带着的，不算；别的系统的二进制加载不到，也不算。
// 有纯 JS 退路的可选模块（OPTIONAL_NATIVE）只警告。
//
// 用法：node .github/scripts/check-packaged-natives.mjs <dist 目录> <linux|darwin|win32>

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [distDir, os] = process.argv.slice(2)
if (!distDir || !['linux', 'darwin', 'win32'].includes(os)) {
  console.error('usage: check-packaged-natives.mjs <dist-dir> <linux|darwin|win32>')
  process.exit(2)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const asar = createRequire(path.join(repoRoot, 'package.json'))('@electron/asar')

/** dist 下所有 app.asar（不进 node_modules，深度有限） */
function findAsars(dir, depth = 0, out = []) {
  if (depth > 6) return out
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.endsWith('.asar.unpacked')) continue
      findAsars(full, depth + 1, out)
    } else if (name === 'app.asar') {
      out.push(full)
    }
  }
  return out
}

const lockPkgs =
  JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')).packages ?? {}

const PLATFORM =
  /^(.*?)-(linux|darwin|win32|android|freebsd|openbsd|sunos|aix)-([a-z0-9]+)(?:-.*)?$/

/** lockfile 里（非 dev 的 optional）平台包：`family|os|cpu` 的集合 —— 上游确实发布了的那些 */
const published = new Set()
for (const [key, meta] of Object.entries(lockPkgs)) {
  if (meta.optional !== true || meta.dev === true) continue
  const m = key.replace(/^.*node_modules\//, '').match(PLATFORM)
  if (m) published.add(`${m[1]}|${m[2]}|${m[3]}`)
}

const ELF_MACHINE = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' }
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32' }
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' }

/** 原生二进制的系统与 CPU（读文件头；不是 ELF / Mach-O / PE → null） */
function binaryInfo(file) {
  const buf = Buffer.alloc(4096)
  const fd = openSync(file, 'r')
  let n
  try {
    n = readSync(fd, buf, 0, buf.length, 0)
  } finally {
    closeSync(fd)
  }
  if (n < 64) return null
  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const machine = buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18)
    return { os: 'linux', cpus: [ELF_MACHINE[machine] ?? `elf:${machine}`] }
  }
  const le = buf.readUInt32LE(0)
  if (le === 0xfeedfacf || le === 0xfeedface) {
    const cpu = buf.readUInt32LE(4)
    return { os: 'darwin', cpus: [MACHO_CPU[cpu] ?? `macho:${cpu}`] }
  }
  // 通用二进制（cafebabe，大端）；Java class 文件同一个魔数，但那里第二个字是版本号（≥ 45）
  if (buf.readUInt32BE(0) === 0xcafebabe) {
    const count = buf.readUInt32BE(4)
    if (count > 0 && count < 20) {
      const cpus = []
      for (let i = 0; i < count; i++) {
        const cpu = buf.readUInt32BE(8 + i * 20)
        cpus.push(MACHO_CPU[cpu] ?? `macho:${cpu}`)
      }
      return { os: 'darwin', cpus }
    }
  }
  if (buf.readUInt16LE(0) === 0x5a4d) {
    const pe = buf.readUInt32LE(0x3c)
    if (pe + 6 <= n && buf.readUInt32LE(pe) === 0x00004550) {
      const machine = buf.readUInt16LE(pe + 4)
      return { os: 'win32', cpus: [PE_MACHINE[machine] ?? `pe:${machine}`] }
    }
  }
  return null
}

/**
 * 路径里写明的系统 / 架构（平台包名、prebuilds/<os>-<arch>、skia.darwin-arm64.node、node-pty 自带的
 * third_party/conpty/<版本>/win10-x64 …）；没写 → null。win10 / win 都按 win32 算
 */
const TARGET_IN_PATH =
  /(?:^|[\\/._@-])(linux|darwin|win32|win10|win)[-.](x64|arm64|ia32|arm)(?=$|[\\/._-])/
const osOfToken = (token) => (token.startsWith('win') ? 'win32' : token)

/** 有纯 JS 退路的可选原生模块：架构不对只警告（ssh2 的加密加速：加载失败就用 JS 实现） */
const OPTIONAL_NATIVE = [/(^|[\\/])ssh2[\\/]lib[\\/]protocol[\\/]crypto[\\/]build[\\/]/]

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 第二道：本系统的原生二进制都是本架构的。回 [错误, 警告, 看过的个数] */
function checkBinaries(unpacked, arch) {
  const errors = []
  const warnings = []
  let checked = 0
  for (const file of walkFiles(unpacked)) {
    const rel = path.relative(unpacked, file)
    const named = rel.match(TARGET_IN_PATH)
    if (named && (osOfToken(named[1]) !== os || named[2] !== arch)) continue
    const info = binaryInfo(file)
    if (!info || info.os !== os) continue
    checked++
    if (info.cpus.includes(arch)) continue
    // 32 位的 Windows 独立程序（ssh2 自带的 pagent.exe）在 x64（WOW64）与 arm64（x86 模拟）上都跑得了；
    // 加载进进程的 .node 模块才必须与进程同架构
    if (os === 'win32' && /\.exe$/i.test(rel) && info.cpus.includes('ia32')) continue
    const line = `${rel} is ${info.cpus.join('+')}`
    if (OPTIONAL_NATIVE.some((re) => re.test(rel))) warnings.push(line)
    else errors.push(line)
  }
  return [errors, warnings, checked]
}

const asars = findAsars(distDir)
if (asars.length === 0) {
  console.error(`❌ no app.asar under ${distDir}`)
  process.exit(1)
}

let failed = false
for (const file of asars) {
  const rel = path.relative(distDir, file)
  const arch = rel.split(path.sep).some((seg) => seg.includes('arm64')) ? 'arm64' : 'x64'
  const top = new Set()
  for (const entry of asar.listPackage(file, { isPack: false })) {
    const m = entry.replace(/\\/g, '/').match(/^\/node_modules\/((?:@[^/]+\/)?[^/]+)/)
    if (m) top.add(m[1])
  }
  /** 家族 → 包里有的平台成员 */
  const families = new Map()
  for (const name of top) {
    const m = name.match(PLATFORM)
    if (!m) continue
    const family = m[1]
    if (!families.has(family)) families.set(family, [])
    families.get(family).push({ name, os: m[2], cpu: m[3] })
  }
  const lacking = [...families].filter(
    ([, members]) => !members.some((p) => p.os === os && p.cpu === arch)
  )
  const missing = lacking.filter(([family]) => published.has(`${family}|${os}|${arch}`))
  for (const [family] of lacking) {
    if (!published.has(`${family}|${os}|${arch}`)) {
      console.log(`   note: ${rel}: ${family} publishes no ${os}-${arch} build (not checked)`)
    }
  }
  if (missing.length > 0) {
    failed = true
    console.error(`❌ ${rel} (${os} ${arch}) lacks its own platform package for:`)
    for (const [family, members] of missing) {
      console.error(`   ${family}-${os}-${arch}*   (has: ${members.map((p) => p.name).join(', ')})`)
    }
  } else {
    console.log(
      `✅ ${rel} (${os} ${arch}): ${[...families.keys()].join(', ') || 'no platform packages'}`
    )
  }
  const unpacked = `${file}.unpacked`
  if (!existsSync(unpacked)) {
    failed = true
    console.error(`❌ ${rel}: no app.asar.unpacked next to it (native modules live there)`)
    continue
  }
  const [errors, warnings, checked] = checkBinaries(unpacked, arch)
  for (const w of warnings) {
    console.log(`   warning: ${rel}: ${w} (optional, has a JavaScript fallback)`)
  }
  if (errors.length > 0) {
    failed = true
    console.error(`❌ ${rel} (${os} ${arch}) carries native binaries for the wrong CPU:`)
    for (const e of errors) console.error(`   ${e}`)
  } else if (checked === 0) {
    failed = true
    console.error(
      `❌ ${rel}: no ${os} native binary found in app.asar.unpacked (nothing to check?)`
    )
  } else {
    console.log(`✅ ${rel} (${os} ${arch}): ${checked} native binaries, all ${arch}`)
  }
}
process.exit(failed ? 1 : 0)
