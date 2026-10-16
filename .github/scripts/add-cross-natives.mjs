#!/usr/bin/env node
// 给「另一个架构」的安装包补上它的平台原生包（发布构建在 npm ci 之后、electron-builder 之前跑）。
//
// 背景：每个发布 job 在一台机器上给两个架构打包（Linux：x64 机器打 x64 + arm64；macOS：arm64 runner 打
// arm64 + x64；Windows：x64 打 x64 + arm64），但 npm ci 只装**本机**架构的 optional 平台包
// （@vscode/ripgrep-linux-x64、@napi-rs/canvas-linux-x64-gnu …）。两个架构的包都从同一个 node_modules
// 打出来，于是另一个架构的包里带的是本机的二进制，启动时 `@vscode/ripgrep` 找不到自己的平台包，主进程
// 在加载模块时就抛错 —— v0.1.19（ripgrep 换成按平台拆包）起 Linux arm64 / macOS x64 / Windows arm64
// 的发布都是坏的。
//
// 做法：读 package-lock.json，把匹配目标 os/cpu、非 dev、尚未安装的 optional 平台包按 lockfile 里的
// resolved 地址下载、校验 integrity（sha512），解到 lockfile 记录的位置。不跑任何安装脚本（平台包只装
// 二进制），不改 lockfile、不动别的包；运行时由各包按 process.arch 挑自己那一份，两份都在也无妨。
//
// 用法：node .github/scripts/add-cross-natives.mjs --os=linux --cpu=x64 --cpu=arm64
//   （本机架构的那些已经装了，会被跳过；所以给全两个架构即可，不必判断哪个是「另一个」）

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const valuesOf = (name) =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))
const targetOs = valuesOf('os')[0]
const targetCpus = valuesOf('cpu')
if (!targetOs || targetCpus.length === 0) {
  console.error(
    'usage: add-cross-natives.mjs --os=<linux|darwin|win32> --cpu=<x64|arm64> [--cpu=…]'
  )
  process.exit(2)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
const pkgs = lock.packages ?? {}

/** 该 lockfile 键的上一级包目录（`node_modules/a/node_modules/@s/b` → `node_modules/a`；顶层 → 仓库根） */
function parentDir(key) {
  const i = key.lastIndexOf('/node_modules/')
  return i === -1 ? repoRoot : path.join(repoRoot, key.slice(0, i))
}

/** 按 lockfile 的 integrity（`sha512-<base64>`）校验 */
function verifyIntegrity(buf, integrity) {
  const ok = integrity.split(/\s+/).some((entry) => {
    const dash = entry.indexOf('-')
    if (dash === -1) return false
    const algo = entry.slice(0, dash)
    if (!['sha512', 'sha384', 'sha256', 'sha1'].includes(algo)) return false
    return createHash(algo).update(buf).digest('base64') === entry.slice(dash + 1)
  })
  if (!ok) throw new Error('integrity mismatch')
}

/**
 * 把 npm tarball 解到 dest，去掉顶层的 package/。纯 Node 实现：Windows runner 上 PATH 里的 `tar` 可能是
 * Git 带的 GNU tar，会把 `C:\\…` 当成远程主机。只认平台包里会有的东西：普通文件、目录、pax 长路径。
 */
function extractTgz(buf, dest) {
  const tar = gunzipSync(buf)
  const root = path.resolve(dest)
  const field = (block, start, len) => {
    const raw = block.subarray(start, start + len)
    const end = raw.indexOf(0)
    return raw.subarray(0, end === -1 ? len : end).toString('utf8')
  }
  let paxPath = null
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const size = parseInt(field(header, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const body = tar.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const m = body.toString('utf8').match(/^\d+ path=(.*)$/m)
      paxPath = m ? m[1] : null
      continue
    }
    if (type === 'g') continue
    const prefix = field(header, 345, 155)
    const name = paxPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    paxPath = null
    const rel = name.split('/').slice(1).join('/')
    if (!rel) continue
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error(`unsafe path ${name}`)
    if (type === '5') {
      mkdirSync(target, { recursive: true })
    } else if (type === '0') {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, body)
      // 保留可执行位（ripgrep 的 rg）；Windows 上 chmod 只认只读位，无所谓
      const mode = parseInt(field(header, 100, 8).trim() || '644', 8) & 0o777
      chmodSync(target, mode | 0o600)
    }
  }
}

async function download(url) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      lastError = error
      console.warn(`  download attempt ${attempt} failed: ${error.message}`)
      await new Promise((r) => setTimeout(r, 3000 * attempt))
    }
  }
  throw lastError
}

const wanted = Object.entries(pkgs).filter(
  ([key, meta]) =>
    key !== '' &&
    meta.optional === true &&
    meta.dev !== true &&
    Array.isArray(meta.os) &&
    meta.os.includes(targetOs) &&
    Array.isArray(meta.cpu) &&
    targetCpus.some((cpu) => meta.cpu.includes(cpu)) &&
    typeof meta.resolved === 'string' &&
    typeof meta.integrity === 'string'
)

let added = 0
for (const [key, meta] of wanted) {
  const dest = path.join(repoRoot, key)
  if (existsSync(path.join(dest, 'package.json'))) continue
  // 声明它的那个包没装（比如只在别的平台才装的父包）→ 补了也没人用
  if (!existsSync(parentDir(key))) continue
  console.log(`+ ${key.replace(/^.*node_modules\//, '')}@${meta.version}  (${meta.os}/${meta.cpu})`)
  const buf = await download(meta.resolved)
  verifyIntegrity(buf, meta.integrity)
  extractTgz(buf, dest)
  if (!existsSync(path.join(dest, 'package.json')))
    throw new Error(`${key}: no package.json after extracting`)
  added++
}

console.log(
  `✅ ${targetOs} ${targetCpus.join('+')}: ${wanted.length} platform package(s) in the lockfile, ${added} added`
)
