import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PALETTE, fnv1a, hashIndex, tint } from '../hooks/lib/palette'

// Token-shaped test values are put together at run time, so no scanner
// takes them for real keys.
const GH = `${'ghp'}_abcdefghijklmnopqrstuvwxyz0123456789`

const DIR = '/home/test/.claude/overseer/sessions'
const ID = 'a3f2c0de-1111-2222-3333-444455556666'
const ID2 = 'b7e9d0aa-1111-2222-3333-444455556666'

type Clock = { sleep: (ms: number) => Promise<void> }
type World = {
  files: Map<string, string>
  ttyWrites: string[]
  store: Map<string, unknown>
  ids: { current: string }
  slow: { write: number; git: number }
}

type Options = { env?: Record<string, string>; failWrites?: boolean; clock?: Clock }

// Everything beneath the mod: a file system in memory, git, the tty writer.
function world(on: On, cwd: string, { env = {}, failWrites = false, clock }: Options = {}): World {
  const files = new Map<string, string>()
  const ttyWrites: string[] = []
  const store = new Map<string, unknown>()
  const ids = { current: ID }
  const slow = { write: 0, git: 0 }
  mock.env(on, { HOME: '/home/test', ...env })
  on('store.get', ($, e) => ({ value: store.get(e.key) ?? null }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: ids.current }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.version', () => ({ value: { version: '2.1.310', base: '2.1.310', builtAt: '' } }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', async ($, e) => {
    if (failWrites) throw new Error('disk full')
    if (slow.write > 0 && clock) await clock.sleep(slow.write)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(k => k.startsWith(`${e.path}/`))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: Date.now(), isLink: false })),
  }))
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'git') {
      if (slow.git > 0 && clock) await clock.sleep(slow.git)
      return { value: { exitCode: 0, stdout: 'feature/x\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    ttyWrites.push(String(e.argv[4] ?? ''))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { files, ttyWrites, store, ids, slow }
}

function events(w: World, id = ID): Record<string, unknown>[] {
  const text = w.files.get(`${DIR}/${id}.jsonl`) ?? ''
  return text
    .split('\n')
    .filter(Boolean)
    .map(one => JSON.parse(one) as Record<string, unknown>)
}

const types = (w: World, id = ID) => events(w, id).map(one => one.type)

const START = { cwd: '/work/web-store', surface: 'terminal' as const, isInteractive: true }
const PROMPT = (text: string) => ({ wait: true, origin: { kind: 'composer' as const }, text })
const ANSWER = (answer: string) => ({ reason: 'answer' as const, answer, durationMs: 10, isAborted: false, turnId: 't1' })
const END = (reason: 'clear' | 'resume' | 'prompt_input_exit', sessionId = ID) => ({
  reason,
  sessionId,
  resume: { id: sessionId },
})

describe('register', () => {
  test('session start writes project, branch and a palette colour', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')

    await $.session.start(START)
    await clock.settle()

    const [start] = events(w)
    expect(start?.type).toBe('session_start')
    expect(start?.project).toBe('web-store')
    expect(start?.branch).toBe('feature/x')
    expect(start?.short).toBe('a3f2')
    expect(typeof start?.colorIndex).toBe('number')
    expect(String(start?.hex)).toMatch(/^#[0-9A-F]{6}$/)
  })

  test('a failing tool call is recorded as tool_error, secrets masked', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')
    on('tool.call', () => ({
      result: {},
      isError: true,
      text: 'Exit code 1\nauth failed for jane.doe@example.com with sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    }))

    await $.session.start(START)
    await $.prompt.submit(PROMPT(`deploy with GITHUB_TOKEN=${GH}`))
    await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" x' })
    await clock.advance(1_000)

    const all = events(w)
    const text = JSON.stringify(all)
    expect(text).not.toContain('sk-ant-api03')
    expect(text).not.toContain(GH.slice(0, 10))
    expect(text).not.toContain('jane.doe@')
    expect(text).not.toContain('abcdefghijklmnop1234')

    const prompt = all.find(one => one.type === 'user_prompt')
    expect(String(prompt?.text)).toContain('[REDACTED]')
    const error = all.find(one => one.type === 'tool_error')
    expect(error?.tool).toBe('Bash')
    expect(error?.denied).toBeUndefined()
    expect(String(error?.error)).toContain('[EMAIL]')
  })

  test('a denial from the permission dialog or a hook is not a tool error', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')
    on('tool.call', () => ({
      result: {},
      isError: true,
      text: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    }))

    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await clock.advance(1_000)

    expect(events(w).find(one => one.type === 'tool_error')?.denied).toBe(true)
  })

  test('a passing-looking test run keeps the end of its output, other calls do not', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')
    on('tool.call', () => ({ result: {}, text: 'lots of output\nTests: 1 failed, 4 passed' }))

    await $.session.start(START)
    await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -20' })
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    await clock.advance(1_000)

    const oks = events(w).filter(one => one.type === 'tool_ok')
    expect(String(oks[0]?.out)).toContain('1 failed')
    expect(oks[1]?.out).toBeUndefined()
  })

  test('heartbeats are written every 30 s, carry the branch and collapse into one line', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')

    await $.session.start(START)
    await clock.advance(95_000)

    const beats = events(w).filter(one => one.type === 'heartbeat')
    expect(beats.length).toBe(1)
    expect(beats[0]?.branch).toBe('feature/x')
  })

  test('session start does not wait for git, the store or the disk', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { clock })
    w.slow.git = 2_900

    let isReturned = false
    const started = $.session.start(START).then(() => {
      isReturned = true
    })
    await clock.advance(10)
    expect(isReturned).toBe(true)
    await started

    await $.prompt.submit(PROMPT('erste Aufgabe'))
    await clock.advance(5_000)
    expect(types(w).slice(0, 2)).toEqual(['session_start', 'user_prompt'])
  })

  test('/resume and /clear continue in a new file under the new id', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')

    await $.session.start(START)
    await $.prompt.submit(PROMPT('alte Aufgabe'))
    await clock.advance(1_000)
    await $.session.end(END('resume'))
    // an event while the old id is still current waits for the new one
    await $.prompt.submit(PROMPT('noch die alte id'))
    await clock.advance(100)
    w.ids.current = ID2
    await $.prompt.submit(PROMPT('neue Aufgabe'))
    await clock.advance(40_000)

    expect(types(w, ID)).toEqual(['session_start', 'user_prompt', 'session_end'])
    const next = events(w, ID2)
    expect(next[0]?.type).toBe('session_start')
    expect(next[0]?.source).toBe('resume')
    expect(next[0]?.previous).toBe('a3f2')
    expect(next.filter(one => one.type === 'user_prompt').map(one => one.text)).toEqual([
      'noch die alte id',
      'neue Aufgabe',
    ])
    expect(next.some(one => one.type === 'heartbeat')).toBe(true)
  })

  test('session end waits for a write already in flight', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { clock })
    on('tool.call', () => ({ result: {}, text: 'ok' }))

    await $.session.start(START)
    await clock.settle()
    w.slow.write = 500
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(800) // the timer's write is in flight now

    let onDisk: unknown[] = []
    const ended = $.session.end(END('prompt_input_exit')).then(() => {
      onDisk = types(w)
    })
    await clock.advance(2_000)
    await ended

    expect(onDisk.at(-1)).toBe('session_end')
  })

  test('an ended session frees its colour, and a colour taken for a clash is not kept', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const cwd = '/work/web-store'
    const own = hashIndex(cwd)
    const w = world(on, cwd)
    const other = (name: string, ended: boolean) =>
      w.files.set(
        `${DIR}/${name}.jsonl`,
        [
          JSON.stringify({ v: 1, ts: 1, type: 'session_start', cwd: '/work/beta', pkey: 'beta', colorIndex: own }),
          ...(ended ? [JSON.stringify({ v: 1, ts: 2, type: 'session_end', reason: 'prompt_input_exit' })] : []),
        ].join('\n'),
      )

    other('ended', true)
    await $.session.start(START)
    await clock.settle()
    expect(events(w)[0]?.colorIndex).toBe(own)
  })

  test('a clash gives the next free colour for this session only', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const cwd = '/work/web-store'
    const own = hashIndex(cwd)
    const w = world(on, cwd)
    w.files.set(
      `${DIR}/running.jsonl`,
      JSON.stringify({ v: 1, ts: 1, type: 'session_start', cwd: '/work/beta', pkey: 'beta', colorIndex: own }),
    )
    // the project already has its colour from an earlier session
    w.store.set(`color:${fnv1a(cwd).toString(16)}`, own)

    await $.session.start(START)
    await clock.settle()

    expect(events(w)[0]?.colorIndex).not.toBe(own)
    expect(w.store.get(`color:${fnv1a(cwd).toString(16)}`)).toBe(own)
  })

  test('outside iTerm2 nothing is written to the terminal', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { env: { TERM_PROGRAM: 'Apple_Terminal' } })

    await $.session.start(START)
    await clock.settle()

    expect(w.ttyWrites.length).toBe(0)
  })

  test('in iTerm2 the tab is painted, and reset with its variables on exit', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { env: { TERM_PROGRAM: 'iTerm.app' } })

    await $.session.start(START)
    await clock.settle()
    expect(w.ttyWrites.length).toBe(1)
    expect(w.ttyWrites[0]).toContain('\x1b]6;1;bg;red;brightness;')

    await $.session.end(END('prompt_input_exit'))
    expect(w.ttyWrites.length).toBe(2)
    expect(w.ttyWrites[1]).toContain('\x1b]6;1;bg;*;default\x07')
    expect(w.ttyWrites[1]).toContain('SetUserVar=overseer_project=\x07')
    expect(w.ttyWrites[1]).toContain('\x1b]111\x07')
    expect(w.ttyWrites[1]).toContain('SetBadgeFormat=\x07')
  })

  test('in iTerm2 the window is tinted with the project colour and badged with its name', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { env: { TERM_PROGRAM: 'iTerm.app', COLORFGBG: '0;15' } })

    await $.session.start(START)
    await clock.settle()

    const color = PALETTE[hashIndex('/work/web-store')]!
    expect(w.ttyWrites[0]).toContain(`\x1b]11;${tint(color.rgb, '0;15')}\x07`)
    expect(w.ttyWrites[0]).toContain(`SetBadgeFormat=${btoa(unescape(encodeURIComponent('● web-store')))}`)
  })

  test('OVERSEER_TINT=off leaves the window background alone', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { env: { TERM_PROGRAM: 'iTerm.app', OVERSEER_TINT: 'off' } })

    await $.session.start(START)
    await clock.settle()
    await $.session.end(END('prompt_input_exit'))

    expect(w.ttyWrites.join('')).not.toContain('\x1b]11;')
    expect(w.ttyWrites.join('')).not.toContain('\x1b]111')
  })

  test('the tint is light on a light profile, dark on a dark one', () => {
    expect(tint([59, 130, 246], '0;15')).toBe('rgb:e7/f0/fe')
    expect(tint([59, 130, 246], '15;0')).toBe('rgb:23/30/45')
    expect(tint([59, 130, 246], undefined)).toBe('rgb:e7/f0/fe')
    expect(tint([59, 130, 246], '')).toBe('rgb:e7/f0/fe')
  })

  test('a folder name cannot smuggle escape sequences into the tab title', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/evil\x07\x1b]52;c;aGk=\x07\x1b[2Jname', { env: { TERM_PROGRAM: 'iTerm.app' } })

    await $.session.start(START)
    await clock.settle()

    expect(w.ttyWrites[0]).toContain('\x1b]1;● evilname\x07')
    expect(events(w)[0]?.project).toBe('evilname')
  })

  test('a write that fails never reaches the session', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    world(on, '/work/web-store', { failWrites: true })
    on('tool.call', () => ({ result: {}, text: 'ok' }))

    await $.session.start(START)
    const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(1_000)

    expect(ran.deny).toBeUndefined()
  })

  test('the last main-loop answer is kept whole for the overseer, secrets masked', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(START)
    await clock.settle()

    await $.turn.complete(ANSWER(`Fertig.\n\n- Tests grün\n- GITHUB_TOKEN=${GH}`))
    await clock.settle()
    const first = w.files.get(`${DIR}/answers/${ID}.md`) ?? ''
    expect(first).toContain('Fertig.\n\n- Tests grün\n')
    expect(first).not.toContain(GH.slice(0, 10))

    await $.turn.complete(ANSWER('Zweite Antwort.\n\nZeile zwei'))
    await clock.settle()
    expect(w.files.get(`${DIR}/answers/${ID}.md`)).toBe('Zweite Antwort.\n\nZeile zwei')
  })

  test('a subagent report or an interrupted turn leaves the kept answer alone', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store')
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(START)
    await clock.settle()

    await $.turn.complete(ANSWER('Hauptantwort'))
    await $.turn.complete({ ...ANSWER('Bericht des Subagenten'), agentId: 'agent-1' })
    await $.turn.complete({ reason: 'aborted', answer: 'halb', durationMs: 5, isAborted: true, turnId: 't2' })
    await clock.settle()

    expect(w.files.get(`${DIR}/answers/${ID}.md`)).toBe('Hauptantwort')
  })

  test('keeping an answer never holds up the end of a turn', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const w = world(on, '/work/web-store', { clock })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(START)
    await clock.settle()
    w.slow.write = 5_000

    let isReturned = false
    const ended = $.turn.complete(ANSWER('lange Antwort')).then(() => {
      isReturned = true
    })
    await clock.advance(10)
    expect(isReturned).toBe(true)
    await ended
    await clock.advance(6_000)
    expect(w.files.get(`${DIR}/answers/${ID}.md`)).toBe('lange Antwort')
  })
})
