import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { describeTool } from './lib/describe'
import { PALETTE, fnv1a, pickIndex, tint } from './lib/palette'
import { clip, clipEnds, redact, scrub, stripControl } from './lib/redact'

// Reporter: every session writes what it does as JSON Lines to
// ~/.claude/overseer/sessions/<session-id>.jsonl for the overseer terminal.
// Nothing here may block or slow Claude Code: writes are buffered and
// flushed on a timer, and every failure goes to the debug log, never up.

type Dollar = EngineInterface

const SCHEMA = 1
const HEARTBEAT_MS = 30_000
const FLUSH_MS = 750
const MAX_LINES = 1500
const ACTIVE_MS = 5 * 60_000
// The longest answer kept for the overseer's copy button, the rest cut:
// masking 64 KB of the worst text takes about 40 ms, of prose a few.
const MAX_ANSWER = 64_000
// Lines the overseer judges by: written at once, not on the timer, so a
// reload that drops the timer cannot lose them.
const URGENT = new Set(['tool_error', 'error', 'turn_end', 'attention', 'session_end'])
// How a denial reads when it comes back as an errored result (the permission
// dialog, a PreToolUse hook, Esc): the person's or a hook's decision, not a
// failing tool.
// A Bash command that may run tests: its output's end goes into tool_ok too,
// since `npm test | tail` exits 0 and only the runner's verdict tells.
const TESTISH = /\b(?:test|tests|spec|check|pytest|jest|vitest|mocha|rspec|phpunit|t)\b/
const DENIED = /The user doesn't want to proceed with this tool use|The tool use was rejected|PreToolUse:\w+ hook error|^\[Request interrupted by user/

const meta = atom({ plugin: 'overseer', key: 'meta' } as const, null, { shape: 'meta-1' })

type Session = {
  id?: string
  file?: string
  dir?: string
  cwd?: string
  colorIndex?: number
  branch?: string | null
  lines: string[]
  queued: string[]
  ready?: Promise<void>
  writing?: Promise<void>
  heartbeat?: Timer
  flushTimer?: Timer
  /** After a /clear or /resume: the id that ended, why, until the new one starts. */
  handover?: { id: string; reason: string }
  isDirty: boolean
  isIterm: boolean
  isTinted: boolean
  isInteractive: boolean
}

// A reload runs this module afresh, so this starts over with it; the file on
// disk is read back in start().
const S: Session = {
  lines: [],
  queued: [],
  isDirty: false,
  isIterm: false,
  isTinted: false,
  isInteractive: true,
}

function debug($: Dollar, what: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err)
    $.ui.log(`overseer: ${what}: ${message}`, { to: 'debug' })
  } catch {
    // nothing left to tell
  }
}

function line(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ v: SCHEMA, ts: Date.now(), type, ...data })
}

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').at(-1) || path
}

function base64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function lastStart(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const one = lines[i]
    if (one === undefined || !one.includes('"type":"session_start"')) continue
    try {
      return JSON.parse(one) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---------- writing ----------

function record($: Dollar, type: string, data: Record<string, unknown> = {}): void {
  try {
    const text = line(type, data)
    if (S.file === undefined) {
      S.queued.push(text)
      if (S.queued.length > MAX_LINES) S.queued.splice(0, S.queued.length - MAX_LINES)
      // after a /clear or /resume the surface is the one already known
      void ensureStarted($, S.id === undefined ? undefined : S.isInteractive)
      return
    }
    const last = S.lines.at(-1)
    if (type === 'heartbeat' && last !== undefined && last.includes('"type":"heartbeat"')) {
      S.lines[S.lines.length - 1] = text
    } else {
      S.lines.push(text)
    }
    if (S.lines.length > MAX_LINES) {
      const head = S.lines[0] ?? ''
      S.lines = [head, ...S.lines.slice(-(MAX_LINES - 1))]
    }
    if (URGENT.has(type)) void flush($)
    else scheduleFlush($)
  } catch (err) {
    debug($, `record ${type}`, err)
  }
}

function scheduleFlush($: Dollar): void {
  if (S.flushTimer !== undefined) return
  S.flushTimer = $.clock.after(FLUSH_MS, () => {
    S.flushTimer = undefined
    void flush($)
  })
}

/** Writes the file; while a write runs, the running loop takes the new lines too. */
function flush($: Dollar): Promise<void> {
  if (S.file === undefined) return Promise.resolve()
  S.isDirty = true
  S.writing ??= writeLoop($, S.file)
  return S.writing
}

async function writeLoop($: Dollar, file: string): Promise<void> {
  try {
    while (S.isDirty && S.file === file) {
      S.isDirty = false
      await $.fs.write(file, `${S.lines.join('\n')}\n`)
    }
  } catch (err) {
    debug($, 'write', err)
  } finally {
    S.writing = undefined
  }
}

/**
 * Keeps the turn's last answer whole, beside the session's file, for the
 * overseer's copy button: masked like every line, written without waiting.
 */
function keepAnswer($: Dollar, answer: string): void {
  if (S.file === undefined || answer.trim() === '') return
  const file = S.file.replace(/([^/]+)\.jsonl$/, 'answers/$1.md')
  const whole =
    answer.length > MAX_ANSWER
      ? `${answer.slice(0, MAX_ANSWER)}\n\n[… gekürzt: ${answer.length - MAX_ANSWER} Zeichen fehlen]`
      : answer
  $.fs.write(file, stripControl(redact(whole))).catch((err: unknown) => debug($, 'answer', err))
}

// ---------- session facts ----------

async function gitBranch($: Dollar, cwd: string): Promise<string | null> {
  try {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 3000 })
    if (head.exitCode !== 0) return null
    const name = head.stdout.trim()
    if (name !== 'HEAD') return name
    const sha = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 3000 })
    return sha.exitCode === 0 ? `(${sha.stdout.trim()})` : 'HEAD'
  } catch {
    return null
  }
}

/** The last session_start of a file, unless a session_end follows it. */
function liveStart(text: string): Record<string, unknown> | undefined {
  const start = lastStart(text)
  if (start === undefined) return undefined
  const after = text.slice(text.lastIndexOf('"type":"session_start"'))
  return after.includes('"type":"session_end"') ? undefined : start
}

/** Colours held right now by running sessions of other projects. */
async function takenColors($: Dollar, dir: string, key: string, id: string): Promise<Set<number>> {
  const taken = new Set<number>()
  try {
    if (!(await $.fs.exists(dir))) return taken
    const now = Date.now()
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
      if (entry.name === `${id}.jsonl` || now - entry.mtimeMs > ACTIVE_MS) continue
      const start = liveStart(await $.fs.read(`${dir}/${entry.name}`))
      if (start === undefined || start.pkey === key || typeof start.colorIndex !== 'number') continue
      taken.add(start.colorIndex)
    }
  } catch (err) {
    debug($, 'reading other sessions', err)
  }
  return taken
}

/**
 * The colour this project got at its first session, unless a running session
 * of another project holds it now; then the next free one, for this session
 * only. One store key per project, so sessions starting together never
 * overwrite each other, and the key is a hash, so no path lands in the store.
 */
async function chooseColor($: Dollar, dir: string, key: string, cwd: string, id: string): Promise<number> {
  const storeKey = `color:${key}`
  let kept: unknown = null
  try {
    kept = await $.store.get(storeKey)
  } catch (err) {
    debug($, 'store read', err)
  }
  const taken = await takenColors($, dir, key, id)
  const isKept = typeof kept === 'number' && kept >= 0 && kept < PALETTE.length
  if (isKept && !taken.has(kept as number)) return kept as number
  const index = pickIndex(cwd, taken)
  if (!isKept) {
    try {
      await $.store.set(storeKey, index)
    } catch (err) {
      debug($, 'store write', err)
    }
  }
  return index
}

// ---------- iTerm2 ----------

// The plugin API has no way to write to the terminal, so a child process
// writes the escape sequences to the controlling terminal, /dev/tty.
async function toTty($: Dollar, sequence: string, timeoutMs = 2000): Promise<void> {
  if (!S.isIterm) return
  try {
    const ran = await $.process.run(['/bin/sh', '-c', 'printf "%s" "$1" > /dev/tty', 'overseer', sequence], {
      timeoutMs,
    })
    if (ran.exitCode !== 0) debug($, 'tty write', ran.stderr.trim())
  } catch (err) {
    debug($, 'tty write', err)
  }
}

function paintTab($: Dollar, colorIndex: number, project: string, background: string | undefined): void {
  const color = PALETTE[colorIndex]
  if (color === undefined) return
  const [r, g, b] = color.rgb
  void toTty(
    $,
    `\x1b]6;1;bg;red;brightness;${r}\x07` +
      `\x1b]6;1;bg;green;brightness;${g}\x07` +
      `\x1b]6;1;bg;blue;brightness;${b}\x07` +
      `\x1b]1;● ${project}\x07` +
      `\x1b]1337;SetUserVar=overseer_project=${base64(project)}\x07` +
      `\x1b]1337;SetUserVar=overseer_color=${base64(color.name)}\x07` +
      (background === undefined
        ? ''
        : `\x1b]11;${background}\x07\x1b]1337;SetBadgeFormat=${base64(`● ${project}`)}\x07`),
  )
}

// Bounded below session.end's own 1.5 s, which covers this wait.
function resetTab($: Dollar): Promise<void> {
  return toTty(
    $,
    '\x1b]6;1;bg;*;default\x07\x1b]1337;SetUserVar=overseer_project=\x07\x1b]1337;SetUserVar=overseer_color=\x07' +
      (S.isTinted ? '\x1b]111\x07\x1b]1337;SetBadgeFormat=\x07' : ''),
    1000,
  )
}

// ---------- lifecycle ----------

async function start($: Dollar, known: boolean | undefined): Promise<void> {
  const id = await $.session.id()
  const handover = S.handover
  // the ending id is still current for a moment after a /clear: try again later
  if (handover !== undefined && handover.id === id) throw new Error('waiting for the new session id')
  const isInteractive = known ?? (await $.session.surface()) !== null
  const home = (await $.env.get('HOME')) ?? ''
  const dir = (await $.env.get('OVERSEER_DIR')) || `${home}/.claude/overseer/sessions`
  const cwd = await $.session.cwd()
  const key = fnv1a(cwd).toString(16)
  const file = `${dir}/${id}.jsonl`

  let restored: string[] = []
  try {
    if (await $.fs.exists(file)) {
      restored = (await $.fs.read(file)).split('\n').filter(one => one.trim() !== '')
    }
  } catch (err) {
    debug($, 'restore', err)
  }

  const branch = await gitBranch($, cwd)
  const colorIndex =
    S.colorIndex !== undefined && S.cwd === cwd ? S.colorIndex : await chooseColor($, dir, key, cwd, id)
  const color = PALETTE[colorIndex] ?? PALETTE[0]!
  const project = scrub(basename(cwd))
  const short = id.slice(0, 4)
  const termProgram = await $.env.get('TERM_PROGRAM')
  const lcTerminal = await $.env.get('LC_TERMINAL')
  const tmux = await $.env.get('TMUX')
  const itermSession = await $.env.get('ITERM_SESSION_ID')
  const version = await $.session.version()

  S.isIterm =
    isInteractive && tmux === undefined && (termProgram === 'iTerm.app' || lcTerminal === 'iTerm2')
  Object.assign(S, { id, file, dir, cwd, colorIndex, branch, isInteractive, handover: undefined })
  S.lines = [
    ...restored,
    line('session_start', {
      sid: id,
      short,
      cwd: scrub(cwd),
      pkey: key,
      project,
      branch: branch === null ? null : scrub(branch),
      colorIndex,
      color: color.name,
      hex: color.hex,
      source:
        handover?.reason ??
        (restored.length === 0 ? 'startup' : restored.at(-1)!.includes('"type":"session_end"') ? 'resume' : 'reload'),
      previous: handover?.id.slice(0, 4),
      interactive: isInteractive,
      terminal: termProgram ?? lcTerminal ?? null,
      iterm: itermSession?.split(':')[0] ?? null,
      version: version.version,
    }),
    ...S.queued,
  ]
  S.queued = []
  await flush($)

  try {
    await update($, meta, () => ({
      project,
      branch: branch === null ? null : scrub(branch),
      colorName: color.name,
      hex: color.hex,
      short,
    }))
  } catch (err) {
    debug($, 'state', err)
  }
  // OVERSEER_TINT=off keeps the window as the profile has it
  S.isTinted = S.isIterm && (await $.env.get('OVERSEER_TINT')) !== 'off'
  paintTab($, colorIndex, project, S.isTinted ? tint(color.rgb, await $.env.get('COLORFGBG')) : undefined)

  S.heartbeat?.cancel()
  S.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
}

/** Starts the file once; a failed start is tried again by the next event. */
function ensureStarted($: Dollar, isInteractive: boolean | undefined): Promise<void> {
  S.ready ??= start($, isInteractive).catch(err => {
    S.ready = undefined
    debug($, 'start', err)
  })
  return S.ready
}

async function beat($: Dollar): Promise<void> {
  try {
    if (S.cwd !== undefined) {
      const branch = await gitBranch($, S.cwd)
      if (branch !== S.branch) {
        S.branch = branch
        const shown = branch === null ? null : scrub(branch)
        record($, 'meta', { branch: shown })
        await update($, meta, old => (old === null ? old : { ...old, branch: shown }))
      }
    }
    // the branch rides along, so a file cut to its newest lines still has it
    record($, 'heartbeat', { branch: S.branch === undefined || S.branch === null ? S.branch : scrub(S.branch) })
  } catch (err) {
    debug($, 'heartbeat', err)
  }
}

// ---------- hooks ----------

export const register: Register = on => {
  // Nothing here is awaited: git, the store and the first write run beside
  // the session, and events recorded meanwhile wait in the queue.
  on('session.start', ($, e, next) => {
    void ensureStarted($, e.isInteractive)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    try {
      if (e.isMeta !== true) record($, 'user_prompt', { text: clip(e.text, 300), command: e.command?.name })
    } catch (err) {
      debug($, 'prompt.submit', err)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const agent = e.agentId?.slice(0, 8)
    try {
      const input = e as unknown as Record<string, unknown>
      record($, 'tool_call', {
        id,
        tool: e.tool,
        desc: describeTool(String(e.tool), input),
        cmd: e.tool === 'Bash' ? clip(String(input.command ?? ''), 300) : undefined,
        agent,
      })
    } catch (err) {
      debug($, 'tool.call', err)
    }

    const ran = await next(e)

    try {
      if (ran.deny !== undefined) {
        record($, 'tool_error', { id, tool: e.tool, denied: true, error: clip(ran.deny, 300), agent })
      } else if (ran.isError === true) {
        const text = ran.text ?? ''
        const denied = DENIED.test(text) ? true : undefined
        record($, 'tool_error', { id, tool: e.tool, denied, error: clipEnds(text, 400), agent })
      } else {
        const command = e.tool === 'Bash' ? String((e as unknown as Record<string, unknown>).command ?? '') : ''
        const out = TESTISH.test(command) ? clipEnds(ran.text ?? '', 300) : undefined
        record($, 'tool_ok', { id, tool: e.tool, out, agent })
      }
    } catch (err) {
      debug($, 'tool.call result', err)
    }
    return ran
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) record($, 'turn_start')
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        record($, 'turn_end', { reason: e.reason, ms: e.durationMs })
        if (e.reason === 'answer') {
          keepAnswer($, e.answer)
        } else if (e.reason === 'error') {
          record($, 'error', { kind: 'api_error', error: clip(e.answer, 300) })
        } else if (e.reason === 'refusal') {
          record($, 'error', {
            kind: 'refusal',
            error: clip(e.refusal.explanation ?? e.refusal.category ?? '', 300),
          })
        }
      }
    } catch (err) {
      debug($, 'turn.complete', err)
    }
    return next(e)
  })

  on('classic.Notification', ($, e, next) => {
    record($, 'attention', { kind: e.notification_type, text: clip(e.message, 200) })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      record($, 'session_end', { reason: e.reason })
      S.flushTimer?.cancel()
      S.flushTimer = undefined
      await flush($)
      if (e.reason === 'clear' || e.reason === 'resume') {
        // the process goes on under another id: the next event opens its file
        S.handover = { id: e.sessionId, reason: e.reason }
        S.file = undefined
        S.lines = []
        S.ready = undefined
      } else {
        S.heartbeat?.cancel()
        await resetTab($)
      }
    } catch (err) {
      debug($, 'session.end', err)
    }
    return next(e)
  })

  // A coloured line above the prompt (project, branch, colour, short id) so
  // the colour in the overseer can be matched to this terminal.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, meta)
    if (e.props.hasSurvey || shown === null) return next(e)
    if ((await $.env.get('OVERSEER_BAND')) === '0') return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color={shown.hex} bold>
          ● {shown.project}
        </Text>
        <Text dimColor>
          {' '}
          · {shown.branch ?? 'kein git'} · {shown.colorName} · {shown.short}
        </Text>
      </Box>
    )
  })
}
