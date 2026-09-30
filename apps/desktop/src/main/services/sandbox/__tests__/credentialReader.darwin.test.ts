/**
 * 命令沙箱的凭据清单 —— 真读取口 + 真 Seatbelt（[darwin]）：RS-12。
 *
 * 生产接线原样走一遍：main 启动时 `setSandboxCredentialReader(sessionCredentialPaths)`，管理器每次算规格
 * 都问它；它读**真实的** policyService（~/.shuvix/policies 里的用户覆盖，现扫）与随包的内置策略 md，
 * 求出生效的 protect-credentials 的 `credentialDirs`。所以用户往策略目录里放一份覆盖副本，下一条命令
 * 就照新清单受限 —— 不重固定会话、不重启。
 *
 * 替身与 sandboxManager.darwin.test.ts 同一套：`os.homedir()` / `os.tmpdir()` / `app.getPath('userData')`
 * 指向本文件自建的假家目录（建在 realpath(os.tmpdir()) 下，不在任何可写根里），logger 静音；toolContext 的
 * 上游（dao、sessionService、skillService）照 toolContext.test.ts 桩掉。utils/paths 用真的（策略目录因此是
 * `<fakeHome>/.shuvix/policies`），只把随包内置策略目录钉到仓库那一份（单测里 __dirname 不是 out/main）。
 *
 * 跳过条件：不是 macOS，或管理器的真探测不过（例如本套件跑在别的沙箱里）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const state = vi.hoisted(() => ({
  home: '',
  tmp: '',
  userData: '',
  // 随包内置策略的事实源 —— 仓库里那一份。src/main/services/sandbox/__tests__ 往上七级是仓库根
  builtinPoliciesDir: `${__dirname}/../../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const mocked = {
    ...actual,
    homedir: () => state.home || actual.homedir(),
    tmpdir: () => state.tmp || actual.tmpdir()
  }
  return { ...mocked, default: mocked }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData' || !state.userData) throw new Error(`unexpected app.getPath(${name})`)
      return state.userData
    },
    getAppPath: () => '',
    isPackaged: false
  },
  shell: { openPath: () => Promise.resolve('') }
}))

// electron-log 在 Electron 之外会往真家目录的 Logs 里写
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../../utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/paths')>()
  return { ...actual, getBuiltinPoliciesDir: () => state.builtinPoliciesDir }
})
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../../dao/sessionDao', () => ({ sessionDao: { pickSettings: () => undefined } }))
vi.mock('../../sessionService', () => ({
  sessionService: { getById: () => undefined, addAllowListPaths: () => {} }
}))
vi.mock('../../skillService', () => ({ skillService: { listExternalDirs: () => [] } }))

import { parsePolicyDefinitionFile } from '@shuvix/agent-runtime'
import {
  cleanupSession,
  pinSession,
  planFor,
  sandboxStatus,
  setSandboxCredentialReader,
  setSandboxSettingReader,
  type SandboxPlan
} from '../index'
/* eslint-disable boundaries/dependencies -- 端到端用例有意把注入方（扁平的 toolContext）、计划的产出方（本模块）与消费方（扁平的 bgTaskService）放进同一个进程；产品代码里是 main 把 toolContext 注入本模块 */
import { killAllBgTasks, runCommand } from '../../bgTaskService'
import { sessionCredentialPaths } from '../../toolContext'
/* eslint-enable boundaries/dependencies */

const RAND = randomBytes(4).toString('hex')
const SID = `sbxtest-cred-${RAND}`

let fakeHome = ''
let ws = ''
let available = false
let callSeq = 0
const nextId = (): string => `sbxtest-cred-call-${RAND}-${++callSeq}`

const BUILTIN_MD = (): string =>
  readFileSync(join(state.builtinPoliciesDir, 'protect-credentials.md'), 'utf8')

/** 覆盖副本的几种写法 —— 每一份都先确认它真的解析成了想要的形状 */
const OVERRIDES = {
  /** 出厂 en 原样、只去掉 `'.aws', ` */
  withoutAws: (): string => {
    const md = BUILTIN_MD().replace("'.aws', ", '')
    const parsed = parsePolicyDefinitionFile(md, 'protect-credentials')!
    expect(parsed.lets?.credentialDirs).not.toContain('.aws')
    expect(parsed.rules).toHaveLength(2)
    return md
  },
  /** 删掉整个 shuvix-policy-lets（规则改成不引用它的写法，仍是一份合法、有规则的策略） */
  withoutLets: (): string => {
    const md = BUILTIN_MD()
      .replace(/shuvix-policy-lets:\n(?: {2}.*\n)+/, '')
      .replaceAll('inDir(object.path, credentialDirs)', "inDir(object.path, vars.home + '/.never')")
    const parsed = parsePolicyDefinitionFile(md, 'protect-credentials')!
    expect(parsed.lets).toBeUndefined()
    expect(parsed.rules).toHaveLength(2)
    return md
  },
  /** 规则清空（移除这道门的约定写法），let 原样留着 */
  clearedRules: (): string => {
    const md = BUILTIN_MD().replace(
      /shuvix-policy-rules:\n(?: {2}.*\n)+/,
      'shuvix-policy-rules: []\n'
    )
    const parsed = parsePolicyDefinitionFile(md, 'protect-credentials')!
    expect(parsed.rules).toEqual([])
    expect(parsed.lets?.credentialDirs).toContain('.ssh')
    return md
  }
}

const overridePath = (): string => join(fakeHome, '.shuvix', 'policies', 'protect-credentials.md')

function writeOverride(md: string): void {
  mkdirSync(dirname(overridePath()), { recursive: true })
  writeFileSync(overridePath(), md)
}

function removeOverride(): void {
  rmSync(overridePath(), { force: true })
}

/** 这一刻的计划（生产里 bash 工具每条命令都要一次） */
function planNow(): SandboxPlan {
  const plan = planFor({
    sessionId: SID,
    workingDirectory: ws,
    grantedWrite: [],
    offerEscalation: true
  })
  expect(plan).not.toBeNull()
  return plan!
}

async function run(
  plan: SandboxPlan,
  command: string
): Promise<{ exitCode: number | null; output: string }> {
  const outcome = await runCommand({
    sessionId: SID,
    toolCallId: nextId(),
    shell: 'bash',
    command,
    description: 'sandbox credential list',
    cwd: ws,
    extraEnv: { HOME: fakeHome, SHUVIX_SESSION_ID: SID },
    background: false,
    timeoutMs: 20_000,
    sandbox: plan
  })
  expect(outcome.kind).toBe('settled')
  if (outcome.kind !== 'settled') throw new Error('command did not settle')
  return { exitCode: outcome.info.exitCode, output: outcome.output }
}

/** 读被拦：非零退出、日志末尾的 [sandbox] 说明点名这条路径 */
async function expectReadRefused(plan: SandboxPlan, file: string): Promise<void> {
  const r = await run(plan, `cat "${file}"`)
  expect(r.exitCode, r.output).not.toBe(0)
  expect(r.output).toContain('Operation not permitted')
  const at = r.output.lastIndexOf('\n[sandbox]')
  expect(at, r.output).toBeGreaterThanOrEqual(0)
  expect(r.output.slice(at + 1)).toContain(`cannot read: ${file}`)
}

async function expectReadable(plan: SandboxPlan, file: string, content: string): Promise<void> {
  const r = await run(plan, `cat "${file}"`)
  expect(r.exitCode, r.output).toBe(0)
  expect(r.output).toContain(content)
  expect(r.output).not.toContain('[sandbox]')
}

describe.skipIf(process.platform !== 'darwin')(
  'sandbox credential list via the injected reader [darwin]',
  () => {
    let aws = ''
    let ssh = ''

    beforeAll(async () => {
      const actualOs = await vi.importActual<typeof import('os')>('os')
      fakeHome = mkdtempSync(join(realpathSync(actualOs.tmpdir()), 'sbxc-'))
      state.home = fakeHome
      state.userData = join(fakeHome, 'Library', 'Application Support', 'ShuviX')
      state.tmp = mkdtempSync('/private/tmp/shuvix-sbxtest-')
      ws = join(fakeHome, 'proj')
      mkdirSync(ws, { recursive: true })
      mkdirSync(state.userData, { recursive: true })
      mkdirSync(join(fakeHome, '.shuvix'), { recursive: true })
      aws = join(fakeHome, '.aws', 'credentials')
      ssh = join(fakeHome, '.ssh', 'id')
      for (const [file, content] of [
        [aws, 'AWS-SECRET\n'],
        [ssh, 'SSH-KEY\n']
      ]) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
      }

      setSandboxSettingReader(() => undefined)
      setSandboxCredentialReader(sessionCredentialPaths)
      available = sandboxStatus().available
    })

    afterAll(() => {
      killAllBgTasks()
      cleanupSession(SID)
      setSandboxCredentialReader(null)
      for (const dir of [fakeHome, state.tmp])
        if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('RS-12a the production reader is wired: a confined cat of ~/.aws/credentials is refused and the note names it', async (ctx) => {
      if (!available) ctx.skip()
      expect(pinSession(SID)).toBe(true)
      const plan = planNow()
      expect(plan.spec.readDenied).toEqual(
        expect.arrayContaining([join(fakeHome, '.aws'), join(fakeHome, '.ssh')])
      )
      expect(plan.spec.readDenied).toContain(join(fakeHome, '.shuvix', '.session-state'))
      await expectReadRefused(plan, aws)
      await expectReadRefused(plan, ssh)
    })

    it('RS-12b an override written into ~/.shuvix/policies reaches the very next plan: .aws becomes readable, .ssh stays refused (no re-pin)', async (ctx) => {
      if (!available) ctx.skip()
      writeOverride(OVERRIDES.withoutAws())
      try {
        const plan = planNow()
        expect(plan.spec.readDenied).not.toContain(join(fakeHome, '.aws'))
        await expectReadable(plan, aws, 'AWS-SECRET')
        await expectReadRefused(plan, ssh)
      } finally {
        removeOverride()
      }
      // 删掉覆盖：下一份计划又回到出厂清单
      await expectReadRefused(planNow(), aws)
    })

    it('RS-12c an override without the let, and one that clears the rules, leave the sandbox with no credential list — commands stay confined otherwise', async (ctx) => {
      if (!available) ctx.skip()
      for (const [label, md] of [
        ['no shuvix-policy-lets', OVERRIDES.withoutLets()],
        ['shuvix-policy-rules: []', OVERRIDES.clearedRules()]
      ] as const) {
        writeOverride(md)
        try {
          const plan = planNow()
          expect(plan.spec.readDenied, label).toEqual([])
          await expectReadable(plan, ssh, 'SSH-KEY')
          // 仍然受限：写 ~/.shuvix 照样被拦
          const blocked = join(fakeHome, '.shuvix', `probe-${callSeq}`)
          const r = await run(plan, `touch "${blocked}"`)
          expect(r.exitCode, `${label}: ${r.output}`).not.toBe(0)
          expect(r.output).toContain(`cannot write: ${blocked}`)
        } finally {
          removeOverride()
        }
      }
      await expectReadRefused(planNow(), ssh)
    })
  }
)
