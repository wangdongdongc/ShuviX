#!/usr/bin/env node
// 校验 package-lock.json 是否记录了目标平台需要的原生 optional 依赖。
//
// 背景：npm 有个长期 bug（https://github.com/npm/cli/issues/4828），在某些情况下会把
// 「非当前平台」的 optionalDependencies 从 lockfile 里剪掉。一旦剪过头，lockfile 就只剩
// 生成它的那台机器的平台（本仓库曾经只剩 darwin-arm64）。`npm ci` 严格按 lockfile 安装，
// 于是在 Linux/Windows runner 上 @rollup/rollup-linux-x64-gnu 之类根本不会被装，
// 直到 vite build 才抛出一堆看不懂的 rollup 堆栈。
//
// 这个脚本在 npm ci 之前跑，直接读 lockfile 判断，失败时给出明确的修复指引。
// 用法：node .github/scripts/check-lockfile-natives.mjs [--os=linux] [--cpu=x64]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const targetOs = argOf('os', process.platform)
const targetCpu = argOf('cpu', process.arch)
const token = `${targetOs}-${targetCpu}`

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lockPath = path.join(repoRoot, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const pkgs = lock.packages ?? {}

// 复刻 node 的向上查找：从 importer 所在目录逐级回退到根 node_modules
function resolve(importer, name) {
  let scope = importer
  for (;;) {
    const candidate = scope ? `${scope}/node_modules/${name}` : `node_modules/${name}`
    if (candidate in pkgs) return candidate
    if (!scope) return null
    const i = scope.lastIndexOf('/node_modules/')
    scope = i === -1 ? '' : scope.slice(0, i)
  }
}

const missing = []
let checked = 0

for (const [importer, meta] of Object.entries(pkgs)) {
  const optional = meta.optionalDependencies
  if (!optional) continue
  // 只看名字里带 <os>-<cpu> 的原生包（@rollup/rollup-linux-x64-gnu、@esbuild/linux-x64、
  // lightningcss-linux-x64-musl、@tailwindcss/oxide-linux-x64-gnu …都符合这个形状）
  for (const name of Object.keys(optional)) {
    if (!name.includes(token)) continue
    checked++
    if (!resolve(importer, name)) {
      missing.push({ importer: importer || '<root>', name, version: optional[name] })
    }
  }
}

if (checked === 0) {
  console.log(`⚠️  lockfile 里没有任何 ${token} 原生 optional 依赖可校验，跳过。`)
  process.exit(0)
}

if (missing.length > 0) {
  console.error(`❌ package-lock.json 缺少 ${missing.length}/${checked} 个 ${token} 原生依赖：\n`)
  for (const m of missing) {
    console.error(`   ${m.name}@${m.version}   (被 ${m.importer} 声明)`)
  }
  console.error(
    `\nlockfile 的 optionalDependencies 被 npm 剪掉了（npm/cli#4828）。` +
      `\n注意：npm install --package-lock-only 修不好，它对已存在的 lockfile 是 no-op。` +
      `\n修复方式（在能联网的开发机上执行后提交 package-lock.json）：` +
      `\n\n    rm -rf node_modules package-lock.json && npm install\n`
  )
  process.exit(1)
}

console.log(`✅ package-lock.json 已包含全部 ${checked} 个 ${token} 原生依赖。`)
