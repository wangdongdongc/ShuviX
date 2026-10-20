/**
 * The Linux command-line installer `scripts/install-linux.sh` (docs/headless/design.md §2), run for real with
 * `/bin/bash` — on macOS that is bash 3.2, which the script promises to support. Almost every case is a `--dry-run`
 * driven by the script's test-only overrides (`SHUVIX_INSTALL_UNAME_S/M`, `_PKG`, `_UID`, `_USER`, `_REPO`) in a
 * clean environment (nothing inherited, PATH = a directory of recording stubs + /usr/bin:/bin), so nothing here can
 * touch the real home folder, sudo, apt or systemd. The one real install (IL-18) goes into a temp HOME with sudo and
 * curl stubbed first on PATH; sudo only records, it never runs its arguments.
 *
 *   IL-0  syntax: `/bin/bash -n` and PATH `bash -n` clean; `node --check scripts/headless-smoke.mjs`; shellcheck when
 *         installed (skipped otherwise); shebang, `set -euo pipefail`, last code line `main "$@"`
 *   IL-1  `--help` / `-h`: usage on stdout, every option line (--lan / --bind marked deprecated), the network-admission
 *         paragraph; `-h --bogus` exits 0, `--bogus -h` exits 2
 *   IL-2  deb + `--service --port 8123` dry run: download → apt → helper → unit → systemctl → wait → summary → SSH hint
 *   IL-3  deb on aarch64 / arm64 → the arm64 .deb
 *   IL-4  AppImage on x86_64 / amd64 / aarch64 / arm64: extract into ~/.local/share/shuvix, --no-sandbox launcher,
 *         helper in ~/.local/bin, no sudo, no apt-get
 *   IL-5  AppImage: warning when ~/.local/bin is not on PATH, none when it is
 *   IL-6  AppImage + `--service` without a port: unit runs the launcher on 7766, systemctl through sudo
 *   IL-7  `--version` with and without the leading v, `--version=`, prerelease tags
 *   IL-8  no `--version`: the dry run says it would look up the latest release
 *   IL-9  `SHUVIX_INSTALL_REPO` changes the download URL and the unit's Documentation=
 *   IL-10 `--deb <relative file>`: resolved to an absolute path, no download
 *   IL-11 argument errors: exit 2, `error: …`, blank line, usage on stderr; port bounds 1024 / 65535 accepted
 *   IL-12 platform errors: exit 1 with one exact line (not Linux, architecture, SHUVIX_INSTALL_PKG, --deb without
 *         apt, HOME unset, missing .deb)
 *   IL-13 root: `--service` runs the unit as root, the deb's ExecStart adds --no-sandbox (the AppImage launcher
 *         already has it), the shared deb helper adds it at run time for root, one note; no sudo in commands or hints
 *   IL-14 `--uninstall --dry-run` as a user and as root; user data never named
 *   IL-15 dry runs change nothing: the stub log is never created, a real temp HOME stays empty
 *   IL-16 package detection without SHUVIX_INSTALL_PKG: apt-get + dpkg on PATH → deb, otherwise AppImage
 *   IL-17 not Linux and no dry run: refused before any command runs
 *   IL-18 a real AppImage install, rerun (upgrade) and uninstall in a temp HOME (stubbed sudo / curl); data and a
 *         launcher without our marker survive the uninstall
 *   IL-19 `--lan` (deprecated, still passed on): helper and unit carry --lan, the output ends with the "policy is
 *         written on first start" line and the no-password risk line, no SSH hint
 *   IL-20 default (`--service`, no --lan): the output ends with exactly the five SSH-tunnel lines (the fourth names
 *         Settings → General → Network access and the policy file); no deprecation note
 *   IL-21 no `--service`: the same five lines after the "rerun with --service" line; `--port` shows in them
 *   IL-22 AppImage + `--lan`: the helper gets --lan, the launcher does not; the same two closing lines as IL-19
 *   IL-23 `--lan=1` is an unknown option; `--uninstall --lan` is the same as `--uninstall`
 *   IL-24 the SSH hint names SHUVIX_INSTALL_USER
 *   IL-25 the headless About page's update command (`headlessUpdateCommand`), run the way it pipes the script in
 *         (`bash -s -- …` with the script on stdin) plus `--dry-run`: installs exactly that version, touches no
 *         service (no unit written, no systemctl enable), runs no command
 *   IL-26 `--bind eth1` (and `--bind=eth1`, and together with `--lan`): helper and unit carry `--bind eth1` and no --lan;
 *         after "Manage it with" exactly the "policy is written on first start" line for that network and its
 *         no-password line; no SSH hint, no LAN risk line
 *   IL-27 `--bind` values that are refused (whitespace, shell metacharacters, quotes, `/`, `\`, a tab, a newline that
 *         would inject a unit line, 65 characters, empty, a leading `-` including `--lan` itself, `%`, a non-ASCII
 *         letter — also under a UTF-8 locale): exit 2 with one exact message, no stub runs, no unit; 64 characters, an
 *         IPv6 and an IPv4 literal are accepted
 *   IL-28 `--bind` with nothing after it: its own message
 *   IL-29 root + deb + `--service --bind`: --bind before --port, --no-sandbox last; AppImage + `--bind`: the helper gets
 *         it, the launcher does not
 *   IL-30 no `--service`: the two one-network lines follow "rerun this script with --service"; the helper's comment
 *         names only `--port <n>`; `--uninstall --bind eth1` prints the same as `--uninstall`
 *   IL-31 the deprecation note: exactly one, right after the dry-run header (before anything is installed), naming
 *         `--lan` or `--bind <name>` (--bind wins when both are given), the policy and its file; none without them,
 *         none on stderr; a refused `--bind` value prints no note
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { headlessUpdateCommand } from '../headless'

const DESKTOP_ROOT = resolve(__dirname, '../../../..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const SCRIPT = join(REPO_ROOT, 'scripts/install-linux.sh')
const SMOKE = join(REPO_ROOT, 'scripts/headless-smoke.mjs')

/** bash 3.2 on macOS is what the script must survive; any bash elsewhere */
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'
const IS_WINDOWS = process.platform === 'win32'

const STUB_NAMES = [
  'sudo',
  'curl',
  'apt-get',
  'dpkg',
  'dpkg-query',
  'systemctl',
  'journalctl',
  'ufw',
  'ldd'
] as const

const MARKER = '# Installed by the ShuviX install-linux.sh script'
const DEFAULT_REPO_URL = 'https://github.com/wangdongdongc/ShuviX'
const HEADER_DEB = 'dry run: nothing is changed (deb, x86_64, user alice)'
const LAN_RISK =
  'Network access has no password: anyone on the same network who opens the address can fully control this computer through ShuviX.'
const ROOT_NOTE =
  "note: as root, ShuviX runs with --no-sandbox (Electron does not start as root otherwise), so Chromium's process sandbox is off; on a machine other people use, install as a normal user with sudo rights instead"
const NOTE_NO_SANDBOX =
  'note: ShuviX from the AppImage runs with --no-sandbox (the extracted app has no setuid sandbox helper)'
const PATH_WARNING =
  'warning: /home/alice/.local/bin is not on your PATH; add it to use the shuvix and shuvix-server commands'
const HELPER_COMMENT =
  '| # Runs ShuviX headless in the foreground (stop it with Ctrl+C). Options: --port <n>.'

/** The two closing lines of a one-network (`--bind`) install (IL-26) */
const bindHint = (name: string): string[] => [
  `On its first start ShuviX writes the network-admission policy from --bind ${name}: only this machine and the network of ${name} can connect (if you have such a policy already, yours decides).`,
  'Network access has no password: anyone on that network who opens the address can fully control this computer through ShuviX.'
]

/** The two closing lines of a `--lan` install (IL-19) */
const LAN_HINT = [
  'On its first start ShuviX writes the network-admission policy from --lan: every device on the local network can connect (if you have such a policy already, yours decides).',
  LAN_RISK
]

/** The one note a deprecated `--lan` / `--bind <name>` prints before anything is installed (IL-31) */
const deprecationNote = (option: string): string =>
  `note: ${option} is deprecated — who can connect is now the security policy network-admission; on its first start ShuviX writes ~/.shuvix/policies/network-admission.md from ${option}, if you have no such policy yet`

/** The five closing lines of a default (no --lan / --bind) install (IL-20) */
const sshHint = (port: number, user = 'alice'): string[] => [
  'ShuviX only accepts connections from this machine (127.0.0.1). From another computer, open an SSH tunnel:',
  `  ssh -L ${port}:127.0.0.1:${port} ${user}@<this machine's address>`,
  `and open http://127.0.0.1:${port}/ there. To let other devices in, follow Settings → General → Network access`,
  'in that browser (a prompt sets up the policy network-admission with an agent), or write ~/.shuvix/policies/network-admission.md.',
  `Network access has no password: anyone who can reach port ${port} on this machine (other users on it, or through a tunnel) can fully control it through ShuviX.`
]

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** stdout split into lines (the final newline dropped, blank lines inside kept) */
  lines: string[]
  /** what the stubs recorded, or null when none of them ran (the log file was never created) */
  stubCalls: string[] | null
}

interface RunOptions {
  /** merged over the base env; `undefined` removes a variable (e.g. HOME) */
  env?: Record<string, string | undefined>
  cwd?: string
  /** stub directory placed first on PATH (default: the shared one) */
  stubDir?: string
  /** full PATH override (the stub dir is not added) */
  path?: string
  /** run as `bash -s -- <args>` with the script on stdin (how `curl … | bash -s -- …` runs it) */
  viaStdin?: boolean
}

let root = ''
let stubDir = ''
let runCounter = 0
let usageText = ''

const toLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

/** A recording no-op: appends `$0 $*` to $STUB_LOG and succeeds. */
const RECORDING_STUB = '#!/bin/sh\nprintf \'%s\\n\' "$0 $*" >> "$STUB_LOG"\nexit 0\n'

function makeStubDir(dir: string, names: readonly string[] = STUB_NAMES): string {
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeExecutable(join(dir, name), RECORDING_STUB)
  return dir
}

function runInstaller(args: string[], options: RunOptions = {}): RunResult {
  const stubLog = join(root, `stub-${++runCounter}.log`)
  const merged: Record<string, string | undefined> = {
    HOME: '/home/alice',
    SHUVIX_INSTALL_UNAME_S: 'Linux',
    SHUVIX_INSTALL_UNAME_M: 'x86_64',
    SHUVIX_INSTALL_PKG: 'deb',
    SHUVIX_INSTALL_UID: '1000',
    SHUVIX_INSTALL_USER: 'alice',
    PATH: options.path ?? `${options.stubDir ?? stubDir}:/usr/bin:/bin`,
    STUB_LOG: stubLog,
    ...options.env
  }
  // a clean environment: only what is listed above, nothing inherited from the test process
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) env[key] = value

  const result = spawnSync(BASH, options.viaStdin ? ['-s', '--', ...args] : [SCRIPT, ...args], {
    env,
    cwd: options.cwd ?? root,
    encoding: 'utf-8',
    timeout: 30_000,
    ...(options.viaStdin ? { input: readFileSync(SCRIPT, 'utf-8') } : {})
  })
  if (result.error) throw result.error
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: toLines(result.stdout),
    stubCalls: existsSync(stubLog) ? toLines(readFileSync(stubLog, 'utf-8')) : null
  }
}

/** Every expected line appears, each one after the previous. */
function expectInOrder(lines: string[], expected: string[]): void {
  let from = 0
  for (const line of expected) {
    const at = lines.indexOf(line, from)
    expect(
      at,
      `missing (or out of order): ${JSON.stringify(line)}\n--- output ---\n${lines.join('\n')}`
    ).toBeGreaterThanOrEqual(0)
    from = at + 1
  }
}

/** The output ends with exactly these lines. */
function expectEndsWith(lines: string[], tail: string[]): void {
  expect(lines.slice(-tail.length)).toStrictEqual(tail)
}

/** The lines that carry ShuviX's flags: the helper's exec and the unit's ExecStart (the helper's comment line mentions --lan). */
const flagLines = (lines: string[]): string[] =>
  lines.filter((line) => line.startsWith('| exec ') || line.startsWith('| ExecStart='))

function expectArgumentError(result: RunResult, message: string): void {
  expect(result.code).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`error: ${message}\n\n${usageText}`)
}

describe.skipIf(IS_WINDOWS)('scripts/install-linux.sh', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shuvix-install-linux-'))
    stubDir = makeStubDir(join(root, 'stubs'))
    const help = runInstaller(['--help'])
    expect(help.code).toBe(0)
    usageText = help.stdout
    expect(usageText.length).toBeGreaterThan(0)
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  // ── IL-0 ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('IL-0 syntax', () => {
    it('IL-0 — /bin/bash -n and PATH bash -n pass with empty stderr', () => {
      for (const shell of [BASH, 'bash']) {
        const result = spawnSync(shell, ['-n', SCRIPT], { encoding: 'utf-8' })
        expect(result.error, shell).toBeUndefined()
        expect(result.status, shell).toBe(0)
        expect(result.stderr, shell).toBe('')
      }
    })

    it('IL-0 — node --check scripts/headless-smoke.mjs passes', () => {
      const result = spawnSync(process.execPath, ['--check', SMOKE], { encoding: 'utf-8' })
      expect(result.status, result.stderr).toBe(0)
    })

    const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf-8' })
    const hasShellcheck = !shellcheck.error && shellcheck.status === 0
    it.skipIf(!hasShellcheck)('IL-0 [OPT] — shellcheck (warnings and errors) passes', () => {
      const result = spawnSync('shellcheck', ['--severity=warning', SCRIPT], { encoding: 'utf-8' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    })

    it('IL-0 [W] — shebang, set -euo pipefail, last code line runs main "$@"', () => {
      const text = readFileSync(SCRIPT, 'utf-8')
      const lines = text.split('\n')
      expect(lines[0]).toBe('#!/usr/bin/env bash')
      expect(lines).toContain('set -euo pipefail')
      const code = lines.filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
      expect(code[code.length - 1]).toBe('main "$@"')
    })
  })

  // ── IL-1 ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('IL-1 help', () => {
    it.each([['--help'], ['-h']])('IL-1 — %s prints the usage and exits 0', (flag) => {
      const result = runInstaller([flag])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.startsWith('Install ShuviX on Linux')).toBe(true)
      const trimmed = result.lines.map((line) => line.trimStart())
      for (const option of [
        '--version <tag>',
        '--service',
        '--port <n>',
        '--deb <file>',
        '--uninstall',
        '--dry-run',
        '-h, --help'
      ]) {
        expect(
          trimmed.some((line) => line.startsWith(option)),
          option
        ).toBe(true)
      }
      expect(trimmed).toContain(
        '--lan             deprecated: on its first start ShuviX writes a network-admission policy that'
      )
      expect(trimmed).toContain(
        '--bind <name>     deprecated: the same for one network only — a network interface (e.g. eth1) or'
      )
      expect(result.lines).toContain(
        "Who can connect is decided by ShuviX's security policy network-admission. By default only this"
      )
      expect(result.stdout).toContain('Settings → General → Network access')
      expect(result.stdout).toContain('~/.shuvix/policies/network-admission.md')
      expect(result.stdout).not.toContain('listens only there')
      expect(result.stubCalls).toBeNull()
    })

    it('IL-1 [W] — help is handled where it appears: -h --bogus exits 0, --bogus -h exits 2', () => {
      const first = runInstaller(['-h', '--bogus'])
      expect(first.code).toBe(0)
      expect(first.stdout).toBe(usageText)
      expectArgumentError(runInstaller(['--bogus', '-h']), 'unknown option: --bogus')
    })
  })

  // ── IL-2 / IL-3 (deb) ────────────────────────────────────────────────────────────────────────────────────────

  describe('IL-2 / IL-3 deb', () => {
    it('IL-2 — deb + --service --port 8123 dry run, step by step', () => {
      const result = runInstaller([
        '--version',
        'v0.2.12',
        '--service',
        '--port',
        '8123',
        '--dry-run'
      ])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      const { lines } = result
      expect(lines[0]).toBe(HEADER_DEB)
      expect(lines[1]).toBe('ShuviX v0.2.12 (shuvix-0.2.12-amd64.deb)')
      expectInOrder(lines, [
        HEADER_DEB,
        'ShuviX v0.2.12 (shuvix-0.2.12-amd64.deb)',
        '+ curl -fL --retry 3 --retry-delay 2 -o /tmp/shuvix-install.XXXXXX/shuvix-0.2.12-amd64.deb https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.12/shuvix-0.2.12-amd64.deb',
        '+ sudo env DEBIAN_FRONTEND=noninteractive apt-get update -q',
        '+ sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades /tmp/shuvix-install.XXXXXX/shuvix-0.2.12-amd64.deb',
        'would write /usr/local/bin/shuvix-server (mode 0755):',
        '| #!/bin/sh',
        `| ${MARKER}`,
        '| exec "/opt/ShuviX/shuvix" --headless --ozone-platform=headless --disable-gpu "$@"',
        'would install: /opt/ShuviX/shuvix and /usr/local/bin/shuvix-server',
        'would write /etc/systemd/system/shuvix.service (mode 0644):',
        '| User=alice',
        '| Environment=SHUVIX_HEADLESS=1',
        '| ExecStart=/opt/ShuviX/shuvix --headless --port 8123 --ozone-platform=headless --disable-gpu',
        '| Restart=on-failure',
        '| WantedBy=multi-user.target',
        '+ sudo systemctl daemon-reload',
        '+ sudo systemctl enable shuvix.service',
        '+ sudo systemctl restart shuvix.service',
        'would wait up to 120s for "ShuviX headless: ready" in journalctl -u shuvix',
        'would run ShuviX headless as the systemd service "shuvix" (user alice, port 8123).'
      ])
      // the helper file starts with its shebang
      const helperAt = lines.indexOf('would write /usr/local/bin/shuvix-server (mode 0755):')
      expect(lines[helperAt + 1]).toBe('| #!/bin/sh')
      expectEndsWith(lines, sshHint(8123))
      // only the helper's run-time root check names --no-sandbox; as a user nothing passes it
      for (const line of flagLines(lines)) expect(line).not.toContain('--no-sandbox')
      expect(lines).not.toContain(ROOT_NOTE)
      expect(result.stdout).not.toContain('would look up the latest release')
      expect(lines.slice(1)).not.toContain(LAN_RISK)
      for (const line of flagLines(lines)) expect(line).not.toContain('--lan')
      expect(result.stubCalls).toBeNull()
    })

    it.each([['aarch64'], ['arm64']])('IL-3 — deb on %s downloads the arm64 package', (machine) => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_UNAME_M: machine }
      })
      expect(result.code).toBe(0)
      expect(result.lines[0]).toBe(`dry run: nothing is changed (deb, ${machine}, user alice)`)
      expect(result.lines).toContain('ShuviX v0.2.12 (shuvix-0.2.12-arm64.deb)')
      expect(result.lines).toContain(
        '+ curl -fL --retry 3 --retry-delay 2 -o /tmp/shuvix-install.XXXXXX/shuvix-0.2.12-arm64.deb https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.12/shuvix-0.2.12-arm64.deb'
      )
      expect(result.stdout).not.toContain('amd64')
    })
  })

  // ── IL-4 / IL-5 / IL-6 (AppImage) ────────────────────────────────────────────────────────────────────────────

  describe('IL-4 / IL-5 / IL-6 AppImage', () => {
    it.each([
      ['x86_64', 'shuvix-0.2.12-x86_64.AppImage'],
      ['amd64', 'shuvix-0.2.12-x86_64.AppImage'],
      ['aarch64', 'shuvix-0.2.12-arm64.AppImage'],
      ['arm64', 'shuvix-0.2.12-arm64.AppImage']
    ])('IL-4 — AppImage on %s → %s, extracted into ~/.local/share/shuvix', (machine, asset) => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_UNAME_M: machine, SHUVIX_INSTALL_PKG: 'appimage' }
      })
      expect(result.code).toBe(0)
      const { lines } = result
      expect(lines[0]).toBe(`dry run: nothing is changed (appimage, ${machine}, user alice)`)
      expectInOrder(lines, [
        `ShuviX v0.2.12 (${asset})`,
        '+ mkdir -p /home/alice/.local/share/shuvix /home/alice/.local/bin',
        `+ curl -fL --retry 3 --retry-delay 2 -o /home/alice/.local/share/shuvix/.install.XXXXXX/${asset} https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.12/${asset}`,
        `+ (cd /home/alice/.local/share/shuvix/.install.XXXXXX && ./${asset} --appimage-extract)`,
        '+ mv /home/alice/.local/share/shuvix/app.new /home/alice/.local/share/shuvix/app',
        'would write /home/alice/.local/bin/shuvix (mode 0755):',
        '| exec "/home/alice/.local/share/shuvix/app/shuvix" --no-sandbox "$@"',
        NOTE_NO_SANDBOX,
        'would write /home/alice/.local/bin/shuvix-server (mode 0755):',
        '| exec "/home/alice/.local/bin/shuvix" --headless --ozone-platform=headless --disable-gpu "$@"',
        'would install: /home/alice/.local/bin/shuvix and /home/alice/.local/bin/shuvix-server'
      ])
      expect(lines.filter((line) => line.startsWith('+ sudo'))).toStrictEqual([])
      expect(result.stdout).not.toContain('apt-get')
      for (const line of flagLines(lines)) expect(line).not.toContain('--lan')
      expectEndsWith(lines, sshHint(7766))
      expect(result.stubCalls).toBeNull()
    })

    it('IL-5 — ~/.local/bin not on PATH: one warning on stderr', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: 'appimage' }
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe(`${PATH_WARNING}\n`)
    })

    it('IL-5 — ~/.local/bin on PATH: no warning', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: 'appimage' },
        path: `${stubDir}:/home/alice/.local/bin:/usr/bin:/bin`
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
    })

    it('IL-6 — AppImage + --service without a port: the unit runs the launcher on 7766, systemctl through sudo', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--service', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: 'appimage' }
      })
      expect(result.code).toBe(0)
      const { lines } = result
      expect(lines).toContain(
        '| ExecStart=/home/alice/.local/bin/shuvix --headless --port 7766 --ozone-platform=headless --disable-gpu'
      )
      expectInOrder(lines, [
        '+ sudo systemctl daemon-reload',
        '+ sudo systemctl enable shuvix.service',
        '+ sudo systemctl restart shuvix.service'
      ])
      const systemctl = lines.filter((line) => line.startsWith('+ ') && line.includes('systemctl'))
      expect(systemctl.length).toBe(3)
      for (const line of systemctl) expect(line.startsWith('+ sudo systemctl ')).toBe(true)
      for (const line of flagLines(lines)) expect(line).not.toContain('--lan')
      expectEndsWith(lines, sshHint(7766))
    })
  })

  // ── IL-7 / IL-8 / IL-9 / IL-10 (release and source) ─────────────────────────────────────────────────────────

  describe('IL-7 … IL-10 release selection', () => {
    it.each([[['--version', '0.2.12']], [['--version=0.2.12']]])(
      'IL-7 — %j gets the leading v added',
      (args) => {
        const result = runInstaller([...args, '--dry-run'])
        expect(result.code).toBe(0)
        expect(result.lines[1]).toBe('ShuviX v0.2.12 (shuvix-0.2.12-amd64.deb)')
        expect(result.stdout).toContain(
          'https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.12/shuvix-0.2.12-amd64.deb'
        )
      }
    )

    it('IL-7 — a prerelease tag on aarch64', () => {
      const result = runInstaller(['--version', 'v1.0.0-beta.2', '--dry-run'], {
        env: { SHUVIX_INSTALL_UNAME_M: 'aarch64' }
      })
      expect(result.code).toBe(0)
      expect(result.lines[1]).toBe('ShuviX v1.0.0-beta.2 (shuvix-1.0.0-beta.2-arm64.deb)')
      expect(result.stdout).toContain(
        'https://github.com/wangdongdongc/ShuviX/releases/download/v1.0.0-beta.2/shuvix-1.0.0-beta.2-arm64.deb'
      )
    })

    it('IL-8 [W] — without --version the dry run would look up the latest release', () => {
      const result = runInstaller(['--dry-run'])
      expect(result.code).toBe(0)
      expectInOrder(result.lines, [
        HEADER_DEB,
        'would look up the latest release at https://github.com/wangdongdongc/ShuviX/releases/latest',
        'ShuviX LATEST (shuvix-LATEST-amd64.deb)'
      ])
      expect(result.stdout).toContain('/shuvix-LATEST-amd64.deb')
      expect(result.stubCalls).toBeNull()
    })

    it('IL-9 — SHUVIX_INSTALL_REPO changes the download URL and Documentation=', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--service', '--dry-run'], {
        env: { SHUVIX_INSTALL_REPO: 'me/fork' }
      })
      expect(result.code).toBe(0)
      expect(result.lines).toContain(
        '+ curl -fL --retry 3 --retry-delay 2 -o /tmp/shuvix-install.XXXXXX/shuvix-0.2.12-amd64.deb https://github.com/me/fork/releases/download/v0.2.12/shuvix-0.2.12-amd64.deb'
      )
      expect(result.lines).toContain('| Documentation=https://github.com/me/fork')
      expect(result.stdout).not.toContain('wangdongdongc')

      // contrast: without the override, the upstream repo
      const upstream = runInstaller(['--version', 'v0.2.12', '--service', '--dry-run'])
      expect(upstream.lines).toContain(`| Documentation=${DEFAULT_REPO_URL}`)
    })

    describe('IL-10 --deb', () => {
      let debDir = ''
      beforeAll(() => {
        debDir = mkdtempSync(join(root, 'deb-'))
        writeFileSync(join(debDir, 'pkg.deb'), 'not really a deb\n')
      })

      it('IL-10 — a relative --deb is resolved to an absolute path; nothing is downloaded', () => {
        const result = runInstaller(['--deb', 'pkg.deb', '--service', '--dry-run'], { cwd: debDir })
        expect(result.code).toBe(0)
        const from = result.lines.filter((line) => line.startsWith('ShuviX from '))
        expect(from.length).toBe(1)
        const debPath = from[0].slice('ShuviX from '.length)
        expect(isAbsolute(debPath)).toBe(true)
        expect(realpathSync(debPath)).toBe(join(realpathSync(debDir), 'pkg.deb'))
        // precondition for the exact apt-get line: printf %q leaves a path like this alone
        expect(debPath, 'temp path without characters %q would quote').toMatch(/^[\w./-]+$/)
        expect(result.lines).toContain(
          `+ sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades ${debPath}`
        )
        expect(result.stdout).not.toContain('curl')
        expect(result.lines.filter((line) => line.startsWith('ShuviX v'))).toStrictEqual([])
        expect(result.stubCalls).toBeNull()
      })
    })
  })

  // ── IL-11 / IL-12 / IL-13 (errors and root) ──────────────────────────────────────────────────────────────────

  describe('IL-11 argument errors', () => {
    it.each([
      [['--port', 'abc'], '--port must be a whole number between 1024 and 65535 (got "abc")'],
      [['--port', '1023'], '--port must be a whole number between 1024 and 65535 (got "1023")'],
      [['--port', '65536'], '--port must be a whole number between 1024 and 65535 (got "65536")'],
      [
        ['--port', '0007766'],
        '--port must be a whole number between 1024 and 65535 (got "0007766")'
      ],
      [['--port='], '--port must be a whole number between 1024 and 65535 (got "")'],
      [['--port'], '--port needs a number'],
      [['--version'], '--version needs a tag'],
      [['--deb'], '--deb needs a file'],
      [['--bogus'], 'unknown option: --bogus'],
      [['foo'], 'unknown option: foo'],
      [['--deb', 'x.deb', '--version', 'v1'], 'use either --deb or --version, not both']
    ])('IL-11 — %j → exit 2 with "%s" and the usage', (args, message) => {
      const result = runInstaller(args)
      expectArgumentError(result, message)
      expect(result.stubCalls).toBeNull()
    })

    it.each([['1024'], ['65535']])('IL-11 — --port %s is accepted', (port) => {
      const result = runInstaller([
        '--version',
        'v0.2.12',
        '--service',
        '--port',
        port,
        '--dry-run'
      ])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.lines).toContain(
        `| ExecStart=/opt/ShuviX/shuvix --headless --port ${port} --ozone-platform=headless --disable-gpu`
      )
    })
  })

  describe('IL-12 platform errors', () => {
    let existingDeb = ''
    beforeAll(() => {
      existingDeb = join(mkdtempSync(join(root, 'deb-')), 'pkg.deb')
      writeFileSync(existingDeb, 'not really a deb\n')
    })

    const expectDie = (result: RunResult, message: string): void => {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`error: ${message}\n`)
      expect(result.stubCalls).toBeNull()
    }

    it('IL-12 — not Linux', () => {
      expectDie(
        runInstaller(['--version', 'v0.2.12', '--dry-run'], {
          env: { SHUVIX_INSTALL_UNAME_S: 'Darwin' }
        }),
        'this installer is for Linux (this system is Darwin)'
      )
    })

    it.each([['i686'], ['armv7l']])('IL-12 — unsupported architecture %s', (machine) => {
      expectDie(
        runInstaller(['--version', 'v0.2.12', '--dry-run'], {
          env: { SHUVIX_INSTALL_UNAME_M: machine }
        }),
        `unsupported architecture: ${machine} (ShuviX ships builds for x86_64 and arm64)`
      )
    })

    it('IL-12 — SHUVIX_INSTALL_PKG must be deb or appimage', () => {
      expectDie(
        runInstaller(['--version', 'v0.2.12', '--dry-run'], { env: { SHUVIX_INSTALL_PKG: 'rpm' } }),
        'SHUVIX_INSTALL_PKG must be deb or appimage (got "rpm")'
      )
    })

    it('IL-12 — --deb on a system without apt', () => {
      expectDie(
        runInstaller(['--deb', existingDeb, '--dry-run'], {
          env: { SHUVIX_INSTALL_PKG: 'appimage' }
        }),
        '--deb needs apt-get and dpkg (Debian / Ubuntu)'
      )
    })

    it('IL-12 — HOME unset', () => {
      expectDie(
        runInstaller(['--version', 'v0.2.12', '--dry-run'], { env: { HOME: undefined } }),
        'HOME is not set'
      )
    })

    it('IL-12 — --deb naming a missing file: only the header, then the error', () => {
      const result = runInstaller(['--deb', '/nonexistent.deb', '--dry-run'])
      expect(result.code).toBe(1)
      expect(result.lines).toStrictEqual([HEADER_DEB])
      expect(result.stderr).toBe('error: no such file: /nonexistent.deb\n')
      expect(result.stubCalls).toBeNull()
    })
  })

  describe('IL-13 root', () => {
    const ROOT_ENV = { SHUVIX_INSTALL_UID: '0', SHUVIX_INSTALL_USER: 'root', HOME: '/root' }
    const ROOT_HEADER = 'dry run: nothing is changed (deb, x86_64, user root)'
    const ROOT_HELPER_CHECK = '| if [ "$(id -u)" = 0 ]; then set -- --no-sandbox "$@"; fi'
    /** no command or suggested command goes through sudo (the note's "sudo rights" is prose) */
    const expectNoSudo = (stdout: string): void =>
      expect(stdout).not.toMatch(/(^\+ sudo |sudo (systemctl|journalctl|ufw|env|rm|tee|chmod) )/m)

    it('IL-13 — root + --service: the unit runs as root with --no-sandbox, nothing through sudo', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--service', '--dry-run'], {
        env: ROOT_ENV
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.lines[0]).toBe(ROOT_HEADER)
      expectInOrder(result.lines, [
        '+ env DEBIAN_FRONTEND=noninteractive apt-get update -q',
        '+ env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades /tmp/shuvix-install.XXXXXX/shuvix-0.2.12-amd64.deb',
        'would write /usr/local/bin/shuvix-server (mode 0755):',
        ROOT_HELPER_CHECK,
        '| exec "/opt/ShuviX/shuvix" --headless --ozone-platform=headless --disable-gpu "$@"',
        'would install: /opt/ShuviX/shuvix and /usr/local/bin/shuvix-server',
        ROOT_NOTE,
        'would write /etc/systemd/system/shuvix.service (mode 0644):',
        '| User=root',
        '| ExecStart=/opt/ShuviX/shuvix --headless --port 7766 --ozone-platform=headless --disable-gpu --no-sandbox',
        '+ systemctl daemon-reload',
        '+ systemctl enable shuvix.service',
        '+ systemctl restart shuvix.service',
        'would run ShuviX headless as the systemd service "shuvix" (user root, port 7766).',
        'Manage it with: systemctl status|restart|stop shuvix · logs: journalctl -u shuvix -f'
      ])
      expect(result.lines.filter((line) => line === ROOT_NOTE)).toHaveLength(1)
      expectEndsWith(result.lines, sshHint(7766, 'root'))
      expectNoSudo(result.stdout)
      expect(result.stubCalls).toBeNull()
    })

    it('IL-13 — root + --service --lan: --lan before --port, --no-sandbox last', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--service', '--lan', '--dry-run'], {
        env: ROOT_ENV
      })
      expect(result.code).toBe(0)
      expect(flagLines(result.lines)).toStrictEqual([
        '| exec "/opt/ShuviX/shuvix" --headless --lan --ozone-platform=headless --disable-gpu "$@"',
        '| ExecStart=/opt/ShuviX/shuvix --headless --lan --port 7766 --ozone-platform=headless --disable-gpu --no-sandbox'
      ])
      expectNoSudo(result.stdout)
    })

    it('IL-13 — root without --service: root commands run without sudo, the helper still carries the root check', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], { env: ROOT_ENV })
      expect(result.code).toBe(0)
      expect(result.lines[0]).toBe(ROOT_HEADER)
      expectInOrder(result.lines, [
        '+ env DEBIAN_FRONTEND=noninteractive apt-get update -q',
        '+ env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades /tmp/shuvix-install.XXXXXX/shuvix-0.2.12-amd64.deb',
        ROOT_HELPER_CHECK,
        ROOT_NOTE
      ])
      expect(result.stdout).not.toContain('shuvix.service')
      expectNoSudo(result.stdout)
    })

    it('IL-13 — a user install writes the same shared helper (root check included), but no note', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'])
      expect(result.code).toBe(0)
      expect(result.lines).toContain(ROOT_HELPER_CHECK)
      expect(result.lines).not.toContain(ROOT_NOTE)
    })

    it('IL-13 — AppImage as root + --service: the launcher passes --no-sandbox, the unit does not repeat it', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--service', '--dry-run'], {
        env: { ...ROOT_ENV, SHUVIX_INSTALL_PKG: 'appimage' }
      })
      expect(result.code).toBe(0)
      expect(result.lines).toContain('| User=root')
      expect(result.lines).toContain(
        '| ExecStart=/root/.local/bin/shuvix --headless --port 7766 --ozone-platform=headless --disable-gpu'
      )
      expect(result.lines).toContain(NOTE_NO_SANDBOX)
      expect(result.lines).not.toContain(ROOT_NOTE)
      expect(result.lines).not.toContain(ROOT_HELPER_CHECK)
      expectNoSudo(result.stdout)
    })
  })

  // ── IL-14 / IL-15 (uninstall, dry runs change nothing) ───────────────────────────────────────────────────────

  const UNINSTALL_STEPS = [
    '+ sudo systemctl disable --now shuvix.service',
    '+ sudo rm -f /etc/systemd/system/shuvix.service',
    '+ sudo systemctl daemon-reload',
    '+ sudo rm -f /usr/local/bin/shuvix-server',
    '+ rm -f /home/alice/.local/bin/shuvix-server',
    '+ rm -f /home/alice/.local/bin/shuvix',
    '+ rm -rf /home/alice/.local/share/shuvix',
    '+ sudo env DEBIAN_FRONTEND=noninteractive apt-get purge -y shuvix',
    'ShuviX is removed. Your data is kept: ~/.config/shuvix and ~/.shuvix (delete them yourself to remove it too).'
  ]

  describe('IL-14 uninstall', () => {
    it('IL-14 — --uninstall --dry-run as a user', () => {
      const result = runInstaller(['--uninstall', '--dry-run'])
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.lines[0]).toBe(HEADER_DEB)
      expect(result.lines.slice(1)).toStrictEqual(UNINSTALL_STEPS)
      for (const line of result.lines.filter((l) => l.startsWith('+ '))) {
        expect(line).not.toContain('/.config/')
        expect(line).not.toContain('/.shuvix')
      }
      expect(result.stubCalls).toBeNull()
    })

    it('IL-14 — --uninstall --dry-run as root: the same steps without sudo', () => {
      const result = runInstaller(['--uninstall', '--dry-run'], {
        env: { SHUVIX_INSTALL_UID: '0', SHUVIX_INSTALL_USER: 'root' }
      })
      expect(result.code).toBe(0)
      expect(result.lines[0]).toBe('dry run: nothing is changed (deb, x86_64, user root)')
      expect(result.lines.slice(1)).toStrictEqual(
        UNINSTALL_STEPS.map((line) => line.replace(/^\+ sudo /, '+ '))
      )
    })
  })

  describe('IL-15 a dry run changes nothing', () => {
    let home = ''
    beforeAll(() => {
      home = mkdtempSync(join(root, 'home-'))
    })

    it.each([
      [
        'IL-2 deb + service',
        ['--version', 'v0.2.12', '--service', '--port', '8123', '--dry-run'],
        'deb'
      ],
      ['IL-6 AppImage + service', ['--version', 'v0.2.12', '--service', '--dry-run'], 'appimage'],
      ['IL-14 uninstall', ['--uninstall', '--dry-run'], 'deb'],
      [
        'IL-19 --lan',
        ['--version', 'v0.2.12', '--service', '--port', '8123', '--lan', '--dry-run'],
        'deb'
      ],
      ['IL-22 AppImage + --lan', ['--version', 'v0.2.12', '--lan', '--dry-run'], 'appimage'],
      ['IL-26 --bind', ['--version', 'v0.2.12', '--service', '--bind', 'eth1', '--dry-run'], 'deb']
    ])('IL-15 — %s: no stub runs, the temp HOME stays empty', (_label, args, pkg) => {
      const result = runInstaller(args, { env: { HOME: home, SHUVIX_INSTALL_PKG: pkg } })
      expect(result.code).toBe(0)
      expect(result.stubCalls).toBeNull()
      expect(readdirSync(home)).toStrictEqual([])
    })
  })

  // ── IL-16 / IL-17 (detection, refusal before anything runs) ──────────────────────────────────────────────────

  describe('IL-16 package detection', () => {
    let minBin = ''
    let withApt = ''
    let withoutApt = ''
    beforeAll(() => {
      minBin = join(root, 'minbin')
      mkdirSync(minBin)
      const sed = ['/usr/bin/sed', '/bin/sed'].find((path) => existsSync(path))
      expect(sed, 'sed on this system').toBeDefined()
      symlinkSync(sed!, join(minBin, 'sed'))
      withApt = makeStubDir(join(root, 'stubs-apt'))
      withoutApt = makeStubDir(
        join(root, 'stubs-no-apt'),
        STUB_NAMES.filter((name) => name !== 'apt-get' && name !== 'dpkg')
      )
    })

    it('IL-16 [W] — apt-get and dpkg on PATH → deb', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: undefined },
        path: `${withApt}:${minBin}`
      })
      expect(result.code).toBe(0)
      expect(result.lines[0]).toBe('dry run: nothing is changed (deb, x86_64, user alice)')
      expect(result.stubCalls ?? []).toStrictEqual([])
    })

    it('IL-16 [W] — without them → AppImage', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: undefined },
        path: `${withoutApt}:${minBin}`
      })
      expect(result.code).toBe(0)
      expect(result.lines[0]).toBe('dry run: nothing is changed (appimage, x86_64, user alice)')
      expect(result.stubCalls ?? []).toStrictEqual([])
    })
  })

  it('IL-17 — not Linux and no dry run: refused before any command runs', () => {
    const result = runInstaller(['--version', 'v1'], { env: { SHUVIX_INSTALL_UNAME_S: 'FreeBSD' } })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: this installer is for Linux (this system is FreeBSD)\n')
    expect(result.stubCalls).toBeNull()
  })

  // ── IL-18 (a real AppImage install into a temp HOME) ─────────────────────────────────────────────────────────

  describe('IL-18 real AppImage install / upgrade / uninstall', () => {
    const URL =
      'https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.12/shuvix-0.2.12-x86_64.AppImage'
    let caseRoot = ''
    let home = ''
    let stubs = ''

    /** What the stub curl writes: an "AppImage" whose --appimage-extract makes squashfs-root/shuvix. */
    const FAKE_APPIMAGE = [
      '#!/bin/sh',
      '# fake AppImage written by the installer test',
      'if [ "$1" = "--appimage-extract" ]; then',
      '  mkdir -p squashfs-root',
      "  printf '#!/bin/sh\\necho fake-shuvix\\n' > squashfs-root/shuvix",
      '  chmod 755 squashfs-root/shuvix',
      '  exit 0',
      'fi',
      'echo "fake AppImage: unexpected arguments: $*" >&2',
      'exit 1'
    ].join('\n')

    const CURL_STUB = [
      '#!/bin/sh',
      'printf \'%s\\n\' "$0 $*" >> "$STUB_LOG"',
      'dest=""',
      'url=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -o) dest="$2"; shift 2 ;;',
      '    --retry | --retry-delay) shift 2 ;;',
      '    -*) shift ;;',
      '    *) url="$1"; shift ;;',
      '  esac',
      'done',
      '[ -n "$dest" ] && [ -n "$url" ] || exit 22',
      'cat > "$dest" <<\'FAKE_APPIMAGE_EOF\'',
      FAKE_APPIMAGE,
      'FAKE_APPIMAGE_EOF',
      'exit 0',
      ''
    ].join('\n')

    /** `systemctl is-active` says "inactive", so an installed unit on the test machine never triggers a restart */
    const SYSTEMCTL_STUB = [
      '#!/bin/sh',
      'printf \'%s\\n\' "$0 $*" >> "$STUB_LOG"',
      '[ "$1" = "is-active" ] && exit 3',
      'exit 0',
      ''
    ].join('\n')

    const appRoot = (): string => join(home, '.local/share/shuvix')
    const binDir = (): string => join(home, '.local/bin')

    const realRun = (args: string[]): RunResult =>
      runInstaller(args, {
        env: { HOME: home, SHUVIX_INSTALL_PKG: 'appimage' },
        stubDir: stubs,
        cwd: caseRoot
      })

    const expectInstalled = (result: RunResult): void => {
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toBe(
        `warning: ${binDir()} is not on your PATH; add it to use the shuvix and shuvix-server commands\n`
      )
      expect(result.lines).toContain(`installed: ${binDir()}/shuvix and ${binDir()}/shuvix-server`)

      const app = join(appRoot(), 'app/shuvix')
      expect(existsSync(app)).toBe(true)
      expect(statSync(app).mode & 0o111).not.toBe(0)

      const launcher = join(binDir(), 'shuvix')
      expect(statSync(launcher).mode & 0o777).toBe(0o755)
      const launcherLines = readFileSync(launcher, 'utf-8').split('\n')
      expect(launcherLines[0]).toBe('#!/bin/sh')
      expect(launcherLines).toContain(MARKER)
      expect(launcherLines).toContain(`exec "${appRoot()}/app/shuvix" --no-sandbox "$@"`)

      const helper = join(binDir(), 'shuvix-server')
      expect(statSync(helper).mode & 0o777).toBe(0o755)
      const helperLines = readFileSync(helper, 'utf-8').split('\n')
      expect(helperLines[0]).toBe('#!/bin/sh')
      expect(helperLines).toContain(MARKER)
      expect(helperLines).toContain(
        `exec "${binDir()}/shuvix" --headless --ozone-platform=headless --disable-gpu "$@"`
      )

      // no work directory and no half-moved app left behind
      expect(readdirSync(appRoot())).toStrictEqual(['app'])

      // the download went to the right URL; sudo was only asked to validate, never to run anything
      const calls = result.stubCalls ?? []
      const curl = calls.filter((line) => line.startsWith(`${stubs}/curl `))
      expect(curl.length).toBe(1)
      expect(curl[0]).toContain(` -o ${appRoot()}/.install.`)
      expect(curl[0].endsWith(` ${URL}`)).toBe(true)
      expect(calls.filter((line) => line.startsWith(`${stubs}/sudo`))).toStrictEqual([
        `${stubs}/sudo -v`
      ])
    }

    afterEach(() => {
      if (caseRoot) rmSync(caseRoot, { recursive: true, force: true })
      caseRoot = ''
    })

    const setUp = (): void => {
      caseRoot = mkdtempSync(join(tmpdir(), 'shuvix-il18-'))
      home = join(caseRoot, 'home')
      mkdirSync(home)
      stubs = makeStubDir(join(caseRoot, 'stubs'))
      writeExecutable(join(stubs, 'curl'), CURL_STUB)
      writeExecutable(join(stubs, 'systemctl'), SYSTEMCTL_STUB)
      // the guard this whole case rests on: HOME is the temp one, never the user's
      expect(home.startsWith(caseRoot)).toBe(true)
      expect(home).not.toBe(process.env.HOME)
    }

    it('IL-18 — install, rerun (same state), uninstall keeps the data', () => {
      setUp()
      expectInstalled(realRun(['--version', 'v0.2.12']))
      // rerun = upgrade in place, same result
      expectInstalled(realRun(['--version', 'v0.2.12']))

      mkdirSync(join(home, '.config/shuvix'), { recursive: true })
      writeFileSync(join(home, '.config/shuvix/keep'), 'data\n')
      mkdirSync(join(home, '.shuvix'), { recursive: true })
      writeFileSync(join(home, '.shuvix/keep'), 'data\n')

      const removed = realRun(['--uninstall'])
      expect(removed.code, removed.stderr).toBe(0)
      expect(removed.stderr).toBe('')
      expect(removed.lines[removed.lines.length - 1]).toBe(
        'ShuviX is removed. Your data is kept: ~/.config/shuvix and ~/.shuvix (delete them yourself to remove it too).'
      )
      expect(existsSync(join(binDir(), 'shuvix'))).toBe(false)
      expect(existsSync(join(binDir(), 'shuvix-server'))).toBe(false)
      expect(existsSync(appRoot())).toBe(false)
      expect(readFileSync(join(home, '.config/shuvix/keep'), 'utf-8')).toBe('data\n')
      expect(readFileSync(join(home, '.shuvix/keep'), 'utf-8')).toBe('data\n')
      // the user-level files go without root (on a machine that also has the system-wide deb / unit installed,
      // the stub sudo would additionally be asked to remove those — it records, it never runs anything)
      const sudoCalls = (removed.stubCalls ?? []).filter((line) => line.startsWith(`${stubs}/sudo`))
      expect(sudoCalls[0]).toBe(`${stubs}/sudo -v`)
      for (const line of sudoCalls) expect(line).not.toContain(home)
    }, 30_000)

    it('IL-18 — a ~/.local/bin/shuvix without our marker survives the uninstall', () => {
      setUp()
      expectInstalled(realRun(['--version', 'v0.2.12']))
      const mine = '#!/bin/sh\necho my own shuvix\n'
      writeExecutable(join(binDir(), 'shuvix'), mine)

      const removed = realRun(['--uninstall'])
      expect(removed.code, removed.stderr).toBe(0)
      expect(readFileSync(join(binDir(), 'shuvix'), 'utf-8')).toBe(mine)
      expect(existsSync(join(binDir(), 'shuvix-server'))).toBe(false)
      expect(existsSync(appRoot())).toBe(false)
    }, 30_000)
  })

  // ── IL-19 … IL-24 (LAN switch and the access hint) ───────────────────────────────────────────────────────────

  describe('IL-19 … IL-24 access hint', () => {
    it('IL-19 — --lan: helper and unit carry --lan, the risk line is last, no SSH hint', () => {
      const result = runInstaller([
        '--version',
        'v0.2.12',
        '--service',
        '--port',
        '8123',
        '--lan',
        '--dry-run'
      ])
      expect(result.code).toBe(0)
      const { lines } = result
      expect(lines).toContain(
        '| exec "/opt/ShuviX/shuvix" --headless --lan --ozone-platform=headless --disable-gpu "$@"'
      )
      expect(lines).toContain(
        '| ExecStart=/opt/ShuviX/shuvix --headless --lan --port 8123 --ozone-platform=headless --disable-gpu'
      )
      expectEndsWith(lines, LAN_HINT)
      expect(lines[1]).toBe(deprecationNote('--lan'))
      expect(
        lines.filter((line) => line.startsWith('ShuviX only accepts connections'))
      ).toStrictEqual([])
      expect(lines.filter((line) => line.includes('ssh -L'))).toStrictEqual([])
    })

    it('IL-20 — default --service: after "Manage it with" come exactly the five SSH-tunnel lines', () => {
      const result = runInstaller([
        '--version',
        'v0.2.12',
        '--service',
        '--port',
        '8123',
        '--dry-run'
      ])
      expect(result.code).toBe(0)
      const { lines } = result
      const manage = lines.indexOf(
        'Manage it with: sudo systemctl status|restart|stop shuvix · logs: journalctl -u shuvix -f'
      )
      expect(manage).toBeGreaterThan(0)
      expect(lines.slice(manage + 1)).toStrictEqual(sshHint(8123))
      expect(lines).not.toContain(LAN_RISK)
      expect(lines.filter((line) => line.includes('deprecated'))).toStrictEqual([])
      for (const line of flagLines(lines)) expect(line).not.toContain('--lan')
    })

    it('IL-21 — no --service: the five lines follow "rerun this script with --service"', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'])
      expect(result.code).toBe(0)
      const { lines } = result
      const rerun = lines.indexOf('or install it as a service: rerun this script with --service')
      expect(rerun).toBeGreaterThan(0)
      expect(lines[rerun - 1]).toBe(
        'Run ShuviX headless in the foreground with: shuvix-server [--port <n>]'
      )
      expect(lines.slice(rerun + 1)).toStrictEqual(sshHint(7766))
      expect(lines).not.toContain(LAN_RISK)
      for (const line of flagLines(lines)) expect(line).not.toContain('--lan')
    })

    it('IL-21 [W] — --port without --service shows in the hint', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--port', '9000', '--dry-run'])
      expect(result.code).toBe(0)
      expectEndsWith(result.lines, sshHint(9000))
    })

    it('IL-22 — AppImage + --lan: the helper gets --lan, the launcher does not', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--lan', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: 'appimage' }
      })
      expect(result.code).toBe(0)
      const { lines } = result
      expect(lines).toContain(
        '| exec "/home/alice/.local/bin/shuvix" --headless --lan --ozone-platform=headless --disable-gpu "$@"'
      )
      expect(lines).toContain(
        '| exec "/home/alice/.local/share/shuvix/app/shuvix" --no-sandbox "$@"'
      )
      expectEndsWith(lines, LAN_HINT)
      expect(lines.filter((line) => line.includes('ssh -L'))).toStrictEqual([])
    })

    it('IL-23 — --lan=1 is an unknown option', () => {
      expectArgumentError(runInstaller(['--lan=1']), 'unknown option: --lan=1')
    })

    it('IL-23 [W] — --uninstall --lan prints the same as --uninstall', () => {
      const plain = runInstaller(['--uninstall', '--dry-run'])
      const withLan = runInstaller(['--uninstall', '--lan', '--dry-run'])
      expect(withLan.code).toBe(0)
      expect(withLan.stdout).toBe(plain.stdout)
      expect(withLan.stderr).toBe(plain.stderr)
    })

    it('IL-24 [W] — the SSH hint names SHUVIX_INSTALL_USER', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--dry-run'], {
        env: { SHUVIX_INSTALL_USER: 'bob' }
      })
      expect(result.code).toBe(0)
      expect(result.lines[0]).toBe('dry run: nothing is changed (deb, x86_64, user bob)')
      expect(result.lines).toContain("  ssh -L 7766:127.0.0.1:7766 bob@<this machine's address>")
      expectEndsWith(result.lines, sshHint(7766, 'bob'))
    })
  })

  // ── IL-26 … IL-30 (one network: --bind) ────────────────────────────────────────────────────────────────────

  describe('IL-26 … IL-30 --bind', () => {
    const BIND_FLAG_LINES = [
      '| exec "/opt/ShuviX/shuvix" --headless --bind eth1 --ozone-platform=headless --disable-gpu "$@"',
      '| ExecStart=/opt/ShuviX/shuvix --headless --bind eth1 --port 8123 --ozone-platform=headless --disable-gpu'
    ]
    const MANAGE =
      'Manage it with: sudo systemctl status|restart|stop shuvix · logs: journalctl -u shuvix -f'
    const bindError = (value: string): string =>
      `--bind takes a network interface name or an address (got "${value}")`

    it.each([
      [['--bind', 'eth1']],
      [['--bind=eth1']],
      [['--lan', '--bind', 'eth1']],
      [['--bind', 'eth1', '--lan']]
    ])(
      'IL-26 — %j: helper and unit carry --bind, the one-network lines close the output',
      (bind) => {
        const result = runInstaller([
          '--version',
          'v0.2.12',
          '--service',
          '--port',
          '8123',
          ...bind,
          '--dry-run'
        ])
        expect(result.code, result.stderr).toBe(0)
        expect(result.stderr).toBe('')
        const { lines } = result
        expect(flagLines(lines)).toStrictEqual(BIND_FLAG_LINES)
        for (const line of flagLines(lines)) expect(line).not.toContain('--lan')
        const manage = lines.indexOf(MANAGE)
        expect(manage).toBeGreaterThan(0)
        expect(lines.slice(manage + 1)).toStrictEqual(bindHint('eth1'))
        expect(lines[1]).toBe(deprecationNote('--bind eth1'))
        expect(lines.filter((line) => line.includes('ssh -L'))).toStrictEqual([])
        expect(lines).not.toContain(LAN_RISK)
        expect(result.stubCalls).toBeNull()
      }
    )

    it.each([
      ['a b'],
      ['a;b'],
      ['$(id)'],
      ['a`b'],
      ['a"b'],
      ["a'b"],
      ['a|b'],
      ['a&b'],
      ['a>b'],
      ['a/b'],
      ['a\\b'],
      ['a\tb'],
      ['eth1\nExecStartPre=/bin/x'],
      ['a'.repeat(65)],
      ['-x'],
      ['fe80::1%eth0'],
      ['ÉTH']
    ])('IL-27 — --bind %j is refused', (value) => {
      const result = runInstaller([
        '--version',
        'v0.2.12',
        '--service',
        '--bind',
        value,
        '--dry-run'
      ])
      expectArgumentError(result, bindError(value))
      expect(result.stubCalls).toBeNull()
      expect(result.stdout).not.toContain('ExecStart=')
    })

    it('IL-27 — an empty value and a following option are refused too (not taken as the name)', () => {
      for (const args of [['--bind', ''], ['--bind=']]) {
        const result = runInstaller(['--version', 'v0.2.12', '--service', ...args, '--dry-run'])
        expectArgumentError(result, bindError(''))
        expect(result.stubCalls, JSON.stringify(args)).toBeNull()
      }
      const lan = runInstaller([
        '--version',
        'v0.2.12',
        '--service',
        '--bind',
        '--lan',
        '--dry-run'
      ])
      expectArgumentError(lan, bindError('--lan'))
      expect(lan.stubCalls).toBeNull()
    })

    it('IL-27 — a non-ASCII letter is refused under a UTF-8 locale as well', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--bind', 'ÉTH', '--dry-run'], {
        env: { LC_ALL: 'en_US.UTF-8' }
      })
      expectArgumentError(result, bindError('ÉTH'))
      expect(result.stubCalls).toBeNull()
    })

    it.each([['a'.repeat(64)], ['fe80::1'], ['192.168.50.10']])(
      'IL-27 — --bind %s is accepted',
      (value) => {
        const result = runInstaller([
          '--version',
          'v0.2.12',
          '--service',
          '--bind',
          value,
          '--dry-run'
        ])
        expect(result.code, result.stderr).toBe(0)
        expect(result.stderr).toBe('')
        expect(flagLines(result.lines)).toStrictEqual([
          `| exec "/opt/ShuviX/shuvix" --headless --bind ${value} --ozone-platform=headless --disable-gpu "$@"`,
          `| ExecStart=/opt/ShuviX/shuvix --headless --bind ${value} --port 7766 --ozone-platform=headless --disable-gpu`
        ])
        expectEndsWith(result.lines, bindHint(value))
      }
    )

    it('IL-28 — --bind with nothing after it', () => {
      const result = runInstaller(['--bind'])
      expectArgumentError(result, '--bind needs a network interface or an address')
      expect(result.stubCalls).toBeNull()
    })

    it('IL-29 — root + deb + --service --bind: --bind before --port, --no-sandbox last', () => {
      const result = runInstaller(
        ['--version', 'v0.2.12', '--service', '--bind', 'eth1', '--dry-run'],
        { env: { SHUVIX_INSTALL_UID: '0', SHUVIX_INSTALL_USER: 'root', HOME: '/root' } }
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.lines).toContain(
        '| ExecStart=/opt/ShuviX/shuvix --headless --bind eth1 --port 7766 --ozone-platform=headless --disable-gpu --no-sandbox'
      )
      expect(result.lines).toContain(
        '| exec "/opt/ShuviX/shuvix" --headless --bind eth1 --ozone-platform=headless --disable-gpu "$@"'
      )
      expect(result.lines).toContain(
        'Manage it with: systemctl status|restart|stop shuvix · logs: journalctl -u shuvix -f'
      )
      expectEndsWith(result.lines, bindHint('eth1'))
    })

    it('IL-29 — AppImage + --bind: the helper gets it, the launcher does not', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--bind', 'eth1', '--dry-run'], {
        env: { SHUVIX_INSTALL_PKG: 'appimage' }
      })
      expect(result.code).toBe(0)
      const { lines } = result
      expect(lines).toContain(
        '| exec "/home/alice/.local/bin/shuvix" --headless --bind eth1 --ozone-platform=headless --disable-gpu "$@"'
      )
      expect(lines).toContain(
        '| exec "/home/alice/.local/share/shuvix/app/shuvix" --no-sandbox "$@"'
      )
      expect(lines).toContain(HELPER_COMMENT)
      expectEndsWith(lines, bindHint('eth1'))
    })

    it('IL-30 — no --service: the two one-network lines follow "rerun this script with --service"', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--bind', 'eth1', '--dry-run'])
      expect(result.code).toBe(0)
      const { lines } = result
      const rerun = lines.indexOf('or install it as a service: rerun this script with --service')
      expect(rerun).toBeGreaterThan(0)
      expect(lines.slice(rerun + 1)).toStrictEqual(bindHint('eth1'))
      expect(lines).toContain(HELPER_COMMENT)
      expect(lines.filter((line) => line.startsWith('| # Runs ShuviX headless'))).toStrictEqual([
        HELPER_COMMENT
      ])
      expect(lines.filter((line) => line.includes('ssh -L'))).toStrictEqual([])
    })

    it('IL-30 [W] — --uninstall --bind eth1 prints the same as --uninstall', () => {
      const plain = runInstaller(['--uninstall', '--dry-run'])
      const withBind = runInstaller(['--uninstall', '--bind', 'eth1', '--dry-run'])
      expect(withBind.code).toBe(0)
      expect(withBind.stdout).toBe(plain.stdout)
      expect(withBind.stderr).toBe(plain.stderr)
    })
  })

  // ── IL-31 (the deprecation note for --lan / --bind) ───────────────────────────────────────────────────────────

  describe('IL-31 deprecation note', () => {
    const notes = (lines: string[]): string[] => lines.filter((line) => line.includes('deprecated'))

    it.each([
      [['--lan'], '--lan', 'deb'],
      [['--lan'], '--lan', 'appimage'],
      [['--bind', 'eth1'], '--bind eth1', 'deb'],
      [['--bind=192.168.50.10'], '--bind 192.168.50.10', 'deb'],
      [['--lan', '--bind', 'eth1'], '--bind eth1', 'deb'],
      [['--bind', 'eth1', '--lan'], '--bind eth1', 'appimage']
    ])('IL-31 — %j (%s, %s): one note, right after the header', (flags, option, pkg) => {
      for (const service of [[], ['--service']]) {
        const result = runInstaller(['--version', 'v0.2.12', ...service, ...flags, '--dry-run'], {
          env: { SHUVIX_INSTALL_PKG: pkg }
        })
        const label = [...service, ...flags].join(' ')
        expect(result.code, label).toBe(0)
        expect(result.lines[0], label).toBe(
          `dry run: nothing is changed (${pkg}, x86_64, user alice)`
        )
        expect(result.lines[1], label).toBe(deprecationNote(option))
        expect(result.lines[2], label).toBe(
          `ShuviX v0.2.12 (shuvix-0.2.12-${pkg === 'deb' ? 'amd64.deb' : 'x86_64.AppImage'})`
        )
        expect(notes(result.lines), label).toStrictEqual([deprecationNote(option)])
        expect(result.stderr, label).not.toContain('deprecated')
      }
    })

    it('IL-31 — as root the note is the same', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--service', '--lan', '--dry-run'], {
        env: { SHUVIX_INSTALL_UID: '0', SHUVIX_INSTALL_USER: 'root', HOME: '/root' }
      })
      expect(result.code).toBe(0)
      expect(result.lines[1]).toBe(deprecationNote('--lan'))
    })

    it('IL-31 — without --lan / --bind: no note', () => {
      for (const args of [
        ['--version', 'v0.2.12', '--dry-run'],
        ['--version', 'v0.2.12', '--service', '--port', '8123', '--dry-run']
      ]) {
        const result = runInstaller(args)
        expect(result.code, args.join(' ')).toBe(0)
        expect(notes(result.lines), args.join(' ')).toStrictEqual([])
      }
    })

    it('IL-31 [W] — a refused --bind value prints no note (the argument error comes first)', () => {
      const result = runInstaller(['--version', 'v0.2.12', '--bind', 'a b', '--dry-run'])
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
    })
  })

  // ── IL-25 (the headless update command) ──────────────────────────────────────────────────────────────────────

  describe('IL-25 headless update command', () => {
    it('IL-25 — the About page command, piped the same way plus --dry-run: that version, no service, no commands', () => {
      const command = headlessUpdateCommand('0.2.13', 'linux')
      expect(command).not.toBeNull()
      const halves = command!.split(' | ')
      expect(halves.length).toBe(2)
      expect(halves[0]).toBe(
        'curl -fsSL https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.13/install-linux.sh'
      )
      expect(halves[1]).toBe('bash -s -- --version v0.2.13')
      const [shell, ...bashArgs] = halves[1].split(' ')
      expect(shell).toBe('bash')
      expect(bashArgs.slice(0, 2)).toStrictEqual(['-s', '--'])
      const args = bashArgs.slice(2)

      const result = runInstaller([...args, '--dry-run'], { viaStdin: true })
      expect(result.code, result.stderr).toBe(0)
      const { lines } = result
      expect(lines[0]).toBe(HEADER_DEB)
      expect(lines[1]).toBe('ShuviX v0.2.13 (shuvix-0.2.13-amd64.deb)')
      expect(result.stdout).toContain(
        'https://github.com/wangdongdongc/ShuviX/releases/download/v0.2.13/shuvix-0.2.13-amd64.deb'
      )
      expect(result.stdout).not.toContain('would look up the latest release')
      expect(result.stdout).not.toContain('would write /etc/systemd/system/shuvix.service')
      expect(result.stdout).not.toContain('systemctl enable')
      expect(result.stubCalls).toBeNull()
    })
  })
})
