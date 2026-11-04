#!/usr/bin/env node
// 打包之后验一遍：Windows 安装包里的应用压缩包，安装时真解得开。
//
// 背景：electron-builder 26.15 起用 7-Zip 24 压包，它给 arm64 的 exe / dll 自动加 ARM64 过滤器；而安装时解压用的
// Nsis7z 插件很旧，读不了，**不报错，直接跳过这些文件**。结果 arm64 安装包「安装成功」，目录里却没有 shuvix.exe 和
// 任何 dll，只剩数据文件和卸载程序（x86 的，用的是旧插件读得了的过滤器）。v0.1.19 到 v0.2.52 都是这样，构建一路绿灯，
// 因为别的检查看的是解包目录，那里文件是全的（上游 electron-builder#9983，26.16 起钉成 BCJ）。
//
// 做法：从 dist 下每个架构的 *-<arch>-setup.exe 里切出嵌着的 7z（模板用 SetCompress off 存放，字节原样在里面；
// electron-builder 打完就删了 dist 下的 *.nsis.7z，而且查安装包本身才是查用户下载到的东西），用打包时同一个 7za
// 列出来：每个文件的压缩方法只能由 Nsis7z 读得了的那几种组成，主程序也得在里面。
//
// 用法：node .github/scripts/check-nsis-payload.mjs <dist 目录>

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const REQUIRED_ARCHES = ['x64', 'arm64']
const MAIN_EXECUTABLE = 'shuvix.exe' // electron-builder.yml 的 win.executableName
/** 只认上游给安装包钉死的这几种（Nsis7z 确定读得了的）；ARM64 读不了，BCJ2 也不在上游的保证之内 */
const DECODABLE_METHOD = /^(LZMA2?|Copy|BCJ)(:.*)?$/
const SEVEN_ZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
const SEVEN_ZIP_START_HEADER = 32

/** 文件里所有真的 7z 包的范围。魔数可能碰巧出现，靠 start header 自带的 CRC 认 */
function embeddedArchives(file) {
  const found = []
  for (
    let at = file.indexOf(SEVEN_ZIP_MAGIC);
    at !== -1;
    at = file.indexOf(SEVEN_ZIP_MAGIC, at + 1)
  ) {
    if (at + SEVEN_ZIP_START_HEADER > file.length) break
    if (crc32(file.subarray(at + 12, at + 32)) !== file.readUInt32LE(at + 8)) continue
    const end =
      at +
      SEVEN_ZIP_START_HEADER +
      Number(file.readBigUInt64LE(at + 12)) +
      Number(file.readBigUInt64LE(at + 20))
    if (end <= file.length) found.push({ start: at, end })
  }
  return found
}

/** `7za l -slt` 的输出 → 每个条目的 Path / Method */
function parseEntries(listing) {
  return listing
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const field = (name) => block.match(new RegExp(`^${name} = (.*)$`, 'm'))?.[1]?.trim()
      return { path: field('Path'), method: field('Method') }
    })
    .filter((entry) => entry.path)
}

const distDir = process.argv[2]
if (!distDir) {
  console.error('usage: check-nsis-payload.mjs <dist-dir>')
  process.exit(2)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(repoRoot, 'apps/desktop/package.json'))
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const sevenZip = await getPath7za()
const workDir = mkdtempSync(path.join(tmpdir(), 'nsis-payload-'))

const failures = []
for (const arch of REQUIRED_ARCHES) {
  const installers = readdirSync(distDir).filter((name) => name.endsWith(`-${arch}-setup.exe`))
  if (installers.length !== 1) {
    failures.push(`${arch}: expected one *-${arch}-setup.exe, found ${installers.length}`)
    continue
  }
  const [installer] = installers
  const bytes = readFileSync(path.join(distDir, installer))
  const archives = embeddedArchives(bytes)
  if (archives.length !== 1) {
    failures.push(`${installer}: expected one embedded 7z archive, found ${archives.length}`)
    continue
  }
  const carved = path.join(workDir, `${arch}.7z`)
  writeFileSync(carved, bytes.subarray(archives[0].start, archives[0].end))
  const listing = execFileSync(sevenZip, ['l', '-slt', '-ba', carved], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  const entries = parseEntries(listing)
  const undecodable = entries.filter(
    ({ method }) => method && !method.split(/\s+/).every((part) => DECODABLE_METHOD.test(part))
  )
  for (const { path: file, method } of undecodable.slice(0, 10)) {
    failures.push(`${installer}: ${file} uses ${method}, which the installer may skip silently`)
  }
  if (undecodable.length > 10) {
    failures.push(`${installer}: and ${undecodable.length - 10} more files`)
  }
  if (!entries.some((entry) => entry.path === MAIN_EXECUTABLE)) {
    failures.push(`${installer}: ${MAIN_EXECUTABLE} is not in the archive`)
  }
  console.log(`${installer}: ${entries.length} entries checked`)
}
rmSync(workDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`❌ Windows installer payload would not install:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('✅ every file in the Windows installers can be extracted at install time')
