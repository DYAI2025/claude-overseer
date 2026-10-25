// Human-readable, coloured terminal output. No raw JSON.

import { currentTask } from './model.mjs'

const ESC = '\x1b['

export function painter(isColor) {
  const wrap = (open, close) => text => (isColor ? `${ESC}${open}m${text}${ESC}${close}m` : String(text))
  const rgb = hex => {
    const n = Number.parseInt(String(hex).replace('#', ''), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    red: wrap('31', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    orange: wrap('38;5;208', '39'),
    hex: (hex, text) => {
      if (!isColor) return String(text)
      const [r, g, b] = rgb(hex)
      return `${ESC}38;2;${r};${g};${b}m${text}${ESC}39m`
    },
    badge: (hex, text) => {
      if (!isColor) return `[${text}]`
      const [r, g, b] = rgb(hex)
      return `${ESC}48;2;${r};${g};${b}m${ESC}38;2;0;0;0m ${text} ${ESC}49m${ESC}39m`
    },
  }
}

// Width in terminal cells: CJK and emoji take two, combining marks none.
const visible = text => String(text).replace(/\x1b\[[0-9;]*m/g, '')
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{1F680}-\u{1F6FF}\u{20000}-\u{3FFFD}]|\uFE0F/u
const segmenter = new Intl.Segmenter()
const graphemes = text => [...segmenter.segment(String(text))].map(one => one.segment)
const cellsOf = grapheme => (WIDE.test(grapheme) ? 2 : /^\p{M}+$/u.test(grapheme) ? 0 : 1)
export const cells = text => graphemes(visible(text)).reduce((sum, g) => sum + cellsOf(g), 0)
const pad = (text, width) => {
  const len = cells(text)
  return len >= width ? text : `${text}${' '.repeat(width - len)}`
}
/** Cut plain text (no escape codes) to at most `width` cells. */
export const cut = (text, width) => {
  if (cells(text) <= width) return String(text)
  let out = ''
  let used = 0
  for (const g of graphemes(text)) {
    const w = cellsOf(g)
    if (used + w > width - 1) break
    out += g
    used += w
  }
  return `${out}…`
}

/** Plain text broken at spaces into lines of at most `width` cells. */
export function wrap(text, width) {
  const lines = []
  let current = ''
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = current === '' ? word : `${current} ${word}`
    if (cells(next) <= width) {
      current = next
      continue
    }
    if (current !== '') lines.push(current)
    current = cells(word) <= width ? word : cut(word, width)
  }
  if (current !== '') lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/** A labelled field: the text wrapped, continuation lines under its first word. */
function field(label, text, columns, paint = t => t) {
  const lead = `    ${label} `
  const width = Math.max(20, columns - cells(lead))
  return wrap(text, width).map((one, i) => (i === 0 ? lead : ' '.repeat(cells(lead))) + paint(one))
}

export function ago(ms) {
  if (ms < 0) ms = 0
  const s = Math.round(ms / 1000)
  if (s < 60) return `vor ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `vor ${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} d`
}

const STATUS_ORDER = { Fehler: 0, hängt: 1, wartet: 2, läuft: 3, bereit: 4, inaktiv: 5, beendet: 6 }

export function paintStatus(p, status) {
  const label = pad(status, 7)
  switch (status) {
    case 'Fehler':
      return p.bold(p.red(label))
    case 'hängt':
      return p.bold(p.orange(label))
    case 'wartet':
      return p.yellow(label)
    case 'läuft':
      return p.green(label)
    case 'bereit':
      return label
    default:
      return p.dim(label)
  }
}

export function tag(p, s) {
  return p.hex(s.hex, `[${s.color} | ${s.project} | ${s.short}]`)
}

/** rows: [{ session, status, problems }]; `lines` limits the height (live view). */
export function render(rows, now, options = {}) {
  return frame(rows, now, options).text
}

/**
 * The view and, for each session row, where its copy button sits:
 * `targets` holds `{ line, n, session }`, `line` counted from 0, `n` the
 * number key. `hasAnswer(session)` says whether a button is shown; `notice`
 * is a line for the person (what was copied).
 */
export function frame(
  rows,
  now,
  { isColor = true, columns = 120, lines = Infinity, dir = '', hasAnswer = () => false, notice = '' } = {},
) {
  const p = painter(isColor)
  const out = []
  const targets = []
  const clock = new Date(now).toLocaleTimeString('de-DE')
  const live = rows.filter(r => r.status !== 'inaktiv' && r.status !== 'beendet').length
  const issues = rows.flatMap(r => r.problems.map(problem => ({ ...problem, session: r.session })))

  out.push(
    `${p.bold('OVERSEER')}  ${p.dim('·')} ${live} aktiv / ${rows.length} Sessions ${p.dim('·')} ${issues.length === 0 ? p.green('keine Probleme') : p.bold(p.red(`${issues.length} Problem${issues.length === 1 ? '' : 'e'}`))}  ${p.dim(clock)}`,
  )
  out.push(p.dim('─'.repeat(Math.min(columns, 120))))

  if (rows.length === 0) {
    out.push(p.dim(`Noch keine Sessions in ${dir || '~/.claude/overseer/sessions'}.`))
    out.push(p.dim('Starte Claude Code mit installiertem overseer-Plugin, dann erscheinen sie hier.'))
    return { text: out.join('\n'), targets }
  }

  const sorted = [...rows].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.session.lastSeen - a.session.lastSeen,
  )
  // Before the task: button, dot, colour, project, branch, id, status and age,
  // 59 cells and the branch; a narrow window gives up part of the branch.
  const branchWidth = columns >= 100 ? 16 : 12
  const taskWidth = Math.max(8, columns - 60 - branchWidth)
  for (const [i, { session: s, status }] of sorted.entries()) {
    const n = i + 1
    const button = hasAnswer(s) ? pad(`⧉${n}`, 3) : '   '
    const isQuiet = status === 'inaktiv' || status === 'beendet'
    const dot = p.hex(s.hex, '●')
    const name = p.hex(s.hex, pad(cut(s.color, 7), 7))
    const project = pad(p.bold(cut(s.project, 18)), 18)
    const branch = pad(cut(s.branch ?? '–', branchWidth), branchWidth)
    const task = cut(currentTask(s) || '(noch kein Prompt)', taskWidth)
    const activity = pad(ago(now - s.lastSeen), 10)
    const rest = `${dot} ${name} ${project} ${p.dim(branch)} ${s.short}  ${paintStatus(p, status)} ${p.dim(activity)} ${isQuiet ? p.dim(task) : task}`
    targets.push({ line: out.length, n, session: s })
    out.push(`${p.bold(button)} ${isQuiet ? p.dim(visible(rest)) : rest}`)
    if (!isQuiet && s.lastCall && now - s.lastCall.ts < 120_000) {
      const desc = s.lastCall.desc === s.lastCall.tool ? '' : ` ${s.lastCall.desc}`
      out.push(p.dim(cut(`    ↳ ${s.lastCall.tool}${desc}`, columns)))
    }
  }

  const footer = [
    '',
    ...(notice ? [p.green(cut(notice, columns))] : []),
    p.dim(cut('q beenden · ⧉ oder Zahl kopiert die letzte Antwort · Vorschläge erscheinen nur hier, nichts geht in die Sessions', columns)),
  ]
  if (issues.length > 0) {
    // Header and sessions always stay; problems fill what is left, the
    // worst first, and the rest is counted instead of scrolling the screen.
    const room = lines - out.length - footer.length - 2
    out.push('')
    out.push(p.bold(p.red(`PROBLEME (${issues.length})`)))
    const sortedIssues = issues.sort((a, b) => (a.severity === b.severity ? b.since - a.since : a.severity === 'error' ? -1 : 1))
    let used = 0
    for (let i = 0; i < sortedIssues.length; i++) {
      const issue = sortedIssues[i]
      const mark = issue.severity === 'error' ? p.red('✖') : p.yellow('▲')
      const since = `(seit ${ago(now - issue.since).replace('vor ', '')})`
      const titleRoom = Math.max(10, columns - cells(`✖ [${issue.session.color} | ${issue.session.project} | ${issue.session.short}] `) - since.length - 1)
      const block = [
        `${mark} ${tag(p, issue.session)} ${p.bold(cut(issue.title, titleRoom))} ${p.dim(since)}`,
        ...(issue.detail ? [`    ${p.dim('Befund:')}   ${cut(issue.detail, Math.max(20, columns - 15))}`] : []),
        ...field('Vorschlag:', issue.fix, columns).map(one => one.replace('Vorschlag:', p.dim('Vorschlag:'))),
        ...field('Nächster Schritt:', issue.next, columns, p.bold).map(one =>
          one.replace('Nächster Schritt:', p.dim('Nächster Schritt:')),
        ),
      ]
      const rest = sortedIssues.length - i
      if (used + block.length > room - (rest > 1 ? 1 : 0)) {
        out.push(p.dim(`+ ${rest} weitere – Fenster größer ziehen oder --once nutzen`))
        break
      }
      out.push(...block)
      used += block.length
    }
  }

  out.push(...footer)
  return { text: out.join('\n'), targets }
}
