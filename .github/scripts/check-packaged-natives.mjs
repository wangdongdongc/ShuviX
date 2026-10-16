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
// 用法：node .github/scripts/check-packaged-natives.mjs <dist 目录> <linux|darwin|win32>

import { readFileSync, readdirSync, statSync } from 'node:fs'
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
}
process.exit(failed ? 1 : 0)
