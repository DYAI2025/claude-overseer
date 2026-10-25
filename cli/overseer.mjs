#!/usr/bin/env node
// The overseer terminal: watches ~/.claude/overseer/sessions and shows every
// Claude Code session, its problems and a fix for each. Read only: it never
// writes into a session, stops one or touches its files.
//
//   node cli/overseer.mjs            live view, refreshes every 2 s (q quits)
//   node cli/overseer.mjs --once     print one snapshot and exit
//   options: --dir <path>  --all  --no-color  --quiet (no bell on new problems)
//            --no-mouse (keep the terminal's own text selection; keys 1–9 still copy)
//
// A click on a row's ⧉ button, or its number key, copies that session's last
// answer to the clipboard.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { problems, status } from './lib/analyze.mjs'
import { buildSession, parseLines } from './lib/model.mjs'
import { answerPath, copyAnswer, parseClick, targetAt } from './lib/copy.mjs'
import { frame, render } from './lib/render.mjs'

const HIDE_ENDED_MS = 10 * 60_000
const HIDE_INACTIVE_MS = 60 * 60_000
const NOTICE_MS = 4_000
// Mouse reports as SGR (ESC [ < b ; x ; y M), presses only matter
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l'

function options(argv) {
  const has = flag => argv.includes(flag)
  const value = flag => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    dir: value('--dir') ?? process.env.OVERSEER_DIR ?? join(homedir(), '.claude', 'overseer', 'sessions'),
    once: has('--once'),
    all: has('--all'),
    color: !has('--no-color') && (has('--color') || (process.stdout.isTTY && !process.env.NO_COLOR)),
    quiet: has('--quiet'),
    mouse: !has('--no-mouse'),
    now: value('--now') ? Number(value('--now')) : undefined,
  }
}

const cache = new Map() // file -> { mtimeMs, size, session }

export function scan(dir) {
  let names = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const sessions = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const st = statSync(path)
      const hit = cache.get(path)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        sessions.push(hit.session)
        continue
      }
      const session = buildSession(parseLines(readFileSync(path, 'utf8')), name)
      cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, session })
      sessions.push(session)
    } catch {
      // vanished between readdir and read
    }
  }
  return sessions
}

export function snapshot(dir, now, all = false) {
  return scan(dir)
    .map(session => {
      const found = problems(session, now)
      return { session, problems: found, status: status(session, now, found) }
    })
    .filter(r => {
      if (all) return true
      const age = now - r.session.lastSeen
      if (r.status === 'beendet') return age <= HIDE_ENDED_MS
      if (r.status === 'inaktiv') return age <= HIDE_INACTIVE_MS
      return true
    })
}

/**
 * Rings for a problem that is new, or whose count went up; never for one that
 * was already there (a sliding window moving, or problems found at start).
 */
export function bellKeeper() {
  let last = null
  return rows => {
    const now = new Map()
    for (const r of rows) for (const p of r.problems) now.set(`${r.session.id}:${p.kind}`, p.count ?? 1)
    const isFirst = last === null
    const rings = !isFirst && [...now].some(([key, count]) => !last.has(key) || count > last.get(key))
    last = now
    return rings
  }
}

function main() {
  const opt = options(process.argv.slice(2))
  const draw = () =>
    render(snapshot(opt.dir, opt.now ?? Date.now(), opt.all), opt.now ?? Date.now(), {
      isColor: opt.color,
      columns: process.stdout.columns || 120,
      dir: opt.dir,
    })

  if (opt.once) {
    process.stdout.write(`${draw()}\n`)
    return
  }

  const out = process.stdout
  const bell = bellKeeper()
  let targets = []
  let notice = { text: '', until: 0 }
  const tick = () => {
    const now = Date.now()
    const rows = snapshot(opt.dir, now, opt.all)
    const view = frame(rows, now, {
      isColor: opt.color,
      columns: out.columns || 120,
      lines: out.rows || Infinity,
      dir: opt.dir,
      hasAnswer: s => existsSync(answerPath(opt.dir, s)),
      notice: now < notice.until ? notice.text : '',
    })
    targets = view.targets
    // Overwrite in place: home, each line cleared to its end, then the rest
    // below. A full clear (2J) would push every frame into iTerm2's scrollback.
    out.write(`\x1b[H${view.text.split('\n').join('\x1b[K\n')}\x1b[K\x1b[J`)
    if (bell(rows) && !opt.quiet) out.write('\x07')
  }
  const copy = session => {
    if (session === undefined) return
    const text = copyAnswer(opt.dir, session, answer => execFileSync('pbcopy', { input: answer, timeout: 3000 }))
    notice = { text, until: Date.now() + NOTICE_MS }
    tick()
  }

  out.write(`\x1b[?1049h\x1b[?25l\x1b]1;OVERSEER\x07${opt.mouse ? MOUSE_ON : ''}`)
  // The terminal gets its mouse and cursor back however the process ends.
  process.on('exit', () => out.write(`${MOUSE_OFF}\x1b[?25h\x1b[?1049l`))
  const restore = () => process.exit(0)
  process.on('SIGINT', restore)
  process.on('SIGTERM', restore)
  process.on('SIGHUP', restore)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', data => {
      // one read can hold several keys or mouse reports
      for (const k of data.toString().match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[^a-zA-Z]*[a-zA-Z]|[\s\S]/g) ?? []) {
        if (k === 'q' || k === '\x03') restore()
        const click = parseClick(k)
        if (click !== null) copy(targetAt(targets, click.x, click.y))
        else if (/^[1-9]$/.test(k)) copy(targets.find(t => t.n === Number(k))?.session)
      }
    })
  }

  let pending = false
  const soon = () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      tick()
    }, 150)
  }
  try {
    watch(opt.dir, soon)
  } catch {
    // the folder appears with the first session; the interval covers it
  }
  setInterval(tick, 2000)
  out.on('resize', tick)
  tick()
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('overseer.mjs')) main()
