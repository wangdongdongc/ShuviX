#!/usr/bin/env node
// 打包之后验一遍：Linux 安装包里每个 ELF（Electron 本体、.node 原生模块、ripgrep …）要求的 glibc / libstdc++
// 版本，都不得高过我们承诺支持的最老发行版 —— Ubuntu 20.04。
//
// 背景：Linux 包特意在 ubuntu:20.04 容器里编，可「在 20.04 里编」不等于「产物只要 20.04 的库」，至今漏过两回：
// - 容器里根 postinstall 没被 CI 跳过，better-sqlite3 用的是 prebuild-install 下来的上游件（GLIBC_2.34），
//   electron-builder 又因为 .forge-meta 跳过了重编 —— v0.2.13 及以前的 x64 包启动即「GLIBC_2.33 not found」；
// - 容器里的 GCC 11 头文件引用 std::__throw_bad_array_new_length（GLIBCXX_3.4.29），20.04 的 libstdc++ 只到 3.4.28。
// 两回构建都一路绿灯。这里读每个 ELF 的 .gnu.version_r（真正交给动态链接器的版本需求，不是按字符串扫），
// 超出门槛就列出文件、版本和用到它的符号，不上传。
//
// 用法：node .github/scripts/check-packaged-glibc.mjs <dist 目录>
// 扫 dist 下所有 *-unpacked 目录（linux-unpacked / linux-arm64-unpacked）。

import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Ubuntu 20.04（focal）自带的版本：glibc 2.31，libstdc++6 / libgcc-s1 来自 GCC 10
const LIMITS = {
  GLIBC: '2.31',
  GLIBCXX: '3.4.28',
  CXXABI: '1.3.12',
  GCC: '10.0.0'
}

const distDir = process.argv[2]
if (!distDir) {
  console.error('usage: check-packaged-glibc.mjs <dist-dir>')
  process.exit(2)
}

const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const isElf = (file) => {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32BE(0) === 0x7f454c46
  } finally {
    closeSync(fd)
  }
}

const SHT_DYNSYM = 11
const SHT_GNU_VERNEED = 0x6ffffffe
const SHT_GNU_VERSYM = 0x6fffffff

/**
 * ELF 的版本需求：版本名（GLIBC_2.34 …）→ 绑在它上面的动态符号名。
 * 只读节头表，32/64 位、大小端都认；没有 .gnu.version_r（静态链接、musl）就是空表。
 */
function versionNeeds(buf) {
  const is64 = buf[4] === 2
  const le = buf[5] === 1
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const word = (o) => (is64 ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)) : u32(o))
  const machine = u16(18)
  const shoff = word(is64 ? 0x28 : 0x20)
  const shentsize = u16(is64 ? 0x3a : 0x2e)
  const shnum = u16(is64 ? 0x3c : 0x30)
  const sections = []
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize
    sections.push({
      type: u32(o + 4),
      offset: word(is64 ? o + 0x18 : o + 0x10),
      size: word(is64 ? o + 0x20 : o + 0x14),
      link: u32(is64 ? o + 0x28 : o + 0x18),
      info: u32(is64 ? o + 0x2c : o + 0x1c)
    })
  }
  const cstr = (strtab, o) => {
    const start = strtab.offset + o
    let end = start
    while (buf[end] !== 0) end++
    return buf.toString('latin1', start, end)
  }

  /** versym 里的版本索引 → 版本名 */
  const byIndex = new Map()
  const verneed = sections.find((s) => s.type === SHT_GNU_VERNEED)
  if (verneed) {
    const strtab = sections[verneed.link]
    let p = verneed.offset
    for (let n = 0; n < verneed.info; n++) {
      let a = p + u32(p + 8)
      for (let k = 0; k < u16(p + 2); k++) {
        byIndex.set(u16(a + 6), cstr(strtab, u32(a + 8)))
        a += u32(a + 12)
      }
      const next = u32(p + 12)
      if (!next) break
      p += next
    }
  }

  const needs = new Map([...new Set(byIndex.values())].map((v) => [v, []]))
  const dynsym = sections.find((s) => s.type === SHT_DYNSYM)
  const versym = sections.find((s) => s.type === SHT_GNU_VERSYM)
  if (dynsym && versym) {
    const strtab = sections[dynsym.link]
    const entsize = is64 ? 24 : 16
    for (let i = 0; i < dynsym.size / entsize; i++) {
      const version = byIndex.get(u16(versym.offset + i * 2) & 0x7fff)
      if (version) needs.get(version).push(cstr(strtab, u32(dynsym.offset + i * entsize)))
    }
  }
  return { machine, needs }
}

const ARCH = { 3: 'i386', 40: 'arm', 62: 'x86-64', 183: 'aarch64' }

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) yield* walk(full)
    else if (st.isFile() && st.size >= 64) yield full
  }
}

const roots = readdirSync(distDir)
  .filter((name) => name.endsWith('-unpacked'))
  .map((name) => path.join(distDir, name))
  .filter((dir) => lstatSync(dir).isDirectory())
if (roots.length === 0) {
  console.error(`❌ no *-unpacked directory under ${distDir}`)
  process.exit(1)
}

let failed = false
for (const root of roots) {
  let elfCount = 0
  /** 家族 → 包里出现过的最高版本 */
  const highest = {}
  const offenders = []
  for (const file of walk(root)) {
    if (!isElf(file)) continue
    elfCount++
    const { machine, needs } = versionNeeds(readFileSync(file))
    const tooNew = []
    for (const [version, symbols] of needs) {
      const m = version.match(/^([A-Z]+)_([\d.]+)$/)
      if (!m || !(m[1] in LIMITS)) continue
      const [, family, number] = m
      if (!highest[family] || cmpVersion(number, highest[family]) > 0) highest[family] = number
      if (cmpVersion(number, LIMITS[family]) > 0) tooNew.push({ version, symbols })
    }
    if (tooNew.length > 0) {
      offenders.push({ file: path.relative(root, file), arch: ARCH[machine] ?? machine, tooNew })
    }
  }

  const summary = Object.entries(highest)
    .map(([family, number]) => `${family}_${number}`)
    .join(' ')
  console.log(`${path.basename(root)}: ${elfCount} ELF files, highest ${summary || '(none)'}`)
  for (const { file, arch, tooNew } of offenders) {
    failed = true
    console.error(`❌ ${path.basename(root)}/${file} (${arch})`)
    for (const { version, symbols } of tooNew.sort((a, b) => a.version.localeCompare(b.version))) {
      const shown = symbols.slice(0, 6).join(', ')
      const more = symbols.length > 6 ? ` … +${symbols.length - 6}` : ''
      console.error(
        `     needs ${version} (limit ${LIMITS[version.split('_')[0]]}): ${shown}${more}`
      )
    }
  }
}

if (failed) {
  console.error(
    `\n这些二进制在 Ubuntu 20.04 上 dlopen 即失败（version \`…' not found）。` +
      `\n上游预编译件：确认它是在本容器里从源码重编的（CI=true 跳过根 postinstall，见 release.yml）；` +
      `\nGLIBCXX / CXXABI：确认 electron-builder 带着 LDFLAGS=-static-libstdc++ 跑。\n`
  )
  process.exit(1)
}
console.log(
  `✅ every ELF stays within Ubuntu 20.04 (${Object.entries(LIMITS)
    .map(([f, v]) => `${f}_${v}`)
    .join(' ')})`
)
