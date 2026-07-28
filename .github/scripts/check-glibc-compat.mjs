#!/usr/bin/env node
// 校验已安装的原生 .node 二进制所需的 glibc 版本，是否超出当前系统提供的版本。
//
// 背景：Linux 产物特意在 ubuntu:20.04（glibc 2.31）里编译，以兼容 Ubuntu 20.04+。
// 但构建期工具链的预编译二进制是上游自己打的，上游换构建机就可能悄悄抬高 glibc 门槛。
// 实例：@rollup/rollup-linux-x64-gnu 4.62.2 只需要 GLIBC_2.14，4.62.3 却要 GLIBC_2.34，
// 于是 npm ci 成功、直到 vite build 才炸在 ERR_DLOPEN_FAILED，报错还伪装成
// 「Cannot find module @rollup/rollup-linux-x64-gnu」，极难定位。
//
// 只在 Linux 上有意义；其它平台直接跳过。
// 用法：node .github/scripts/check-glibc-compat.mjs [--root=node_modules]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

// --system-glibc 只为在非 Linux 机器上自测检测逻辑用（CI 里不传）
const forcedGlibc = argOf('system-glibc', null)

if (process.platform !== 'linux' && !forcedGlibc) {
  console.log(`⚠️  非 Linux（${process.platform}），跳过 glibc 校验。`)
  process.exit(0)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scanRoot = path.resolve(repoRoot, argOf('root', 'node_modules'))

const cmp = (a, b) => {
  const [, a1] = a.split('.').map(Number)
  const [, b1] = b.split('.').map(Number)
  return a1 - b1
}

// 当前系统的 glibc 版本
let systemGlibc = forcedGlibc
if (!systemGlibc) {
  try {
    const out = execSync('ldd --version 2>&1 | head -1', { encoding: 'utf8' })
    systemGlibc = (out.match(/(\d+\.\d+)\s*$/m) || out.match(/(\d+\.\d+)/) || [])[1] ?? null
  } catch {
    /* ignore */
  }
}
if (!systemGlibc) {
  console.log('⚠️  无法探测系统 glibc 版本，跳过校验。')
  process.exit(0)
}
const systemTag = `2.${systemGlibc.split('.')[1]}`
console.log(`系统 glibc: ${systemGlibc}`)

// 递归收集 .node 二进制
// 只看「从 npm 下载的预编译平台包」——包名里带 <os>-<cpu> 的那一类
// （@rollup/rollup-linux-x64-gnu、@tailwindcss/oxide-linux-x64-gnu、lightningcss-linux-x64-gnu …）。
// 它们由上游打好二进制直接分发，glibc 门槛不对就只能靠 overrides 钉版本，正是要拦的场景。
//
// 反过来，better-sqlite3 / node-pty 这类**本地编译**的原生模块必须排除：
// npm ci 阶段 prebuild-install 拉下来的是 Node ABI 预编译件（可能是在更新的 glibc 上打的），
// 但 electron-builder 配了 npmRebuild + buildDependenciesFromSource，打包时会在本容器里
// 用容器自己的 glibc 从源码重编，那个临时件根本不会进产物。扫它只会误报。
// --target 只为自测用（CI 里不传，默认就是当前平台）
const platformToken = argOf('target', `${process.platform}-${process.arch}`)

const binaries = []
const walk = (dir, depth = 0) => {
  if (depth > 8) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, depth + 1)
    else if (e.isFile() && e.name.endsWith('.node') && full.includes(platformToken)) {
      binaries.push(full)
    }
  }
}
walk(scanRoot)

const GLIBC_RE = /GLIBC_2\.\d+/g
const offenders = []

for (const bin of binaries) {
  let buf
  try {
    if (statSync(bin).size > 200 * 1024 * 1024) continue
    buf = readFileSync(bin)
  } catch {
    continue
  }
  // 版本符号以 NUL 分隔的 ASCII 存在 .dynstr 里，直接按字节扫即可
  const tags = [...new Set(buf.toString('latin1').match(GLIBC_RE) ?? [])]
  if (tags.length === 0) continue
  const max = tags.sort(cmp).at(-1)
  if (cmp(max, systemTag) > 0) {
    offenders.push({ bin: path.relative(repoRoot, bin), max })
  }
}

console.log(`扫描了 ${binaries.length} 个 .node 二进制。`)

if (offenders.length > 0) {
  console.error(`\n❌ ${offenders.length} 个原生模块要求的 glibc 高于系统的 ${systemTag}：\n`)
  for (const o of offenders) console.error(`   ${o.bin}\n      需要 ${o.max}`)
  console.error(
    `\n这些二进制在本容器里 dlopen 会失败（ERR_DLOPEN_FAILED），` +
      `\n而 rollup 之类的加载器会把它误报成「Cannot find module ...」。` +
      `\n修法：在根 package.json 的 overrides 里把对应包钉回未抬高 glibc 门槛的版本。\n`
  )
  process.exit(1)
}

console.log(`✅ 全部原生模块都兼容 glibc ${systemTag}。`)
