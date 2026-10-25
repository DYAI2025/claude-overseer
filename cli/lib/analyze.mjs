// Status and problems of one session, judged from its events alone.

import { suggest } from './suggest.mjs'

export const INACTIVE_MS = 5 * 60_000
export const STALL_MS = 10 * 60_000
export const RECENT_MS = 15 * 60_000
export const BURST_MS = 10 * 60_000

// ---------- test runs ----------

// A test runner at the head of one segment of a command line. The head is
// what is left after env assignments and wrappers (uv run, npx, …).
const RUNNER =
  /^(?:pytest|py\.test|jest|vitest|mocha|rspec|phpunit|ctest|tox|nox|ava|tap|karma)\b|^playwright\s+test\b|^(?:go|cargo|bun|deno|swift|dotnet|mix|zig\s+build)\s+(?:nextest\s+run|test)\b|^(?:\.\/)?(?:mvnw?|gradlew?)\b.*\btest\b|^make\s+(?:test|check)\b|^(?:npm|pnpm|yarn)\b(?:\s+(?:-w|--workspace|--filter|-F|--prefix|-C)\s+\S+|\s+workspace\s+\S+)*\s+(?:run\s+)?(?:t|test|tests|test:\S+)\b|^python[\d.]*\s+(?:-m\s+(?:pytest|unittest)\b|manage\.py\s+test\b)|^node\s+--test\b|^xcodebuild\b.*\btest\b|^(?:turbo|nx)\s+(?:run\s+)?test\b|^rake\s+test\b|^php\s+artisan\s+test\b|^claude\s+plugin\s+test\b/
const WRAPPER =
  /^(?:\w+=\S*\s+|env\s+|time\s+|command\s+|uv\s+run\s+(?:--\S+\s+)*|npx\s+(?:-y\s+)?|bunx\s+|pnpm\s+exec\s+|pnpm\s+dlx\s+|yarn\s+dlx\s+|bundle\s+exec\s+|poetry\s+run\s+|pipenv\s+run\s+|hatch\s+run\s+|pdm\s+run\s+|dotenv\s+(?:-\S+\s+)*--\s+)/

const blankQuotes = cmd => String(cmd).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')

function head(segment) {
  let text = segment.trim().replace(/^[({\s]+/, '')
  for (let i = 0; i < 8; i++) {
    const next = text.replace(WRAPPER, '')
    if (next === text) break
    text = next
  }
  return text
}

/**
 * Where the tests run in a command line, quoted strings blanked so
 * `git commit -m "jest"` is no test: whether that part is the last of an
 * `&&`/`;` chain (its exit status is the command's) and whether it is piped
 * into another program (which then sets the status).
 */
function testPosition(cmd) {
  if (typeof cmd !== 'string') return null
  const chains = blankQuotes(cmd).split(/&&|\|\||;|\n/)
  for (let c = 0; c < chains.length; c++) {
    const pipes = chains[c].split('|')
    const p = pipes.findIndex(part => RUNNER.test(head(part)))
    if (p >= 0) return { isLast: c === chains.length - 1, isPiped: p < pipes.length - 1 }
  }
  return null
}

export function isTestCommand(cmd) {
  return testPosition(cmd) !== null
}

// What runners print when tests fail, and when they all pass.
const FAIL_VERDICT =
  /\b[1-9]\d* (?:failed|failing|failures?|errors?)\b|^\s*FAIL(?:ED)?\b|\bnot ok \d+|# fail [1-9]|Tests?:\s+[1-9]\d* failed|test result: FAILED|\bFAILURES!|\bBUILD FAILED\b|^\s*✖ \d+|\(fail\)/im
const PASS_VERDICT =
  /\b0 failed\b|# fail 0\b|test result: ok\b|\b\d+ passed\b|Tests?:\s+\d+ passed|^OK(?: \(|$)|\b\d+ pass\b|BUILD SUCCESSFUL|\b0 fail\b/im

/**
 * Whether a test run failed: the runner's own verdict decides where the
 * output shows one; else the exit status, but only when the test segment's
 * status is the command's (a later `&& git commit` fails on its own, a
 * `| tail` hides the runner's code).
 */
export function testVerdict(o) {
  const at = testPosition(o.cmd)
  if (at === null) return null
  const text = String(o.error ?? o.out ?? '').replace(/ ⏎ /g, '\n')
  if (FAIL_VERDICT.test(text)) return 'fail'
  if (PASS_VERDICT.test(text)) return 'pass'
  const isOwnStatus = at.isLast && !at.isPiped
  if (!isOwnStatus) return null
  return o.ok ? 'pass' : 'fail'
}

// ---------- signatures ----------

/** The error's first telling line, with numbers, hex and paths' tails folded. */
export function signature(outcome) {
  const folded = firstLine(outcome.error)
    .toLowerCase()
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
  return `${outcome.tool}:${folded}`
}

const target = o => (o.tool === 'Bash' ? (o.cmd ?? o.desc) : o.desc)

// ---------- problems ----------

const USER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

export function problems(s, now) {
  const found = []
  const alive = now - s.lastSeen <= INACTIVE_MS
  if (s.ended) return found

  if (!alive) {
    if (s.turnActive) {
      found.push({
        kind: 'NO_SIGNAL',
        severity: 'warn',
        since: s.lastSeen,
        title: `Kein Lebenszeichen seit ${minutes(now - s.lastSeen)} – mitten in einer Antwort`,
        detail: 'Kein Heartbeat mehr, kein session_end: Terminal geschlossen, Prozess abgestürzt oder Mac im Ruhezustand.',
      })
    }
    return withSuggestions(found, s)
  }

  const counted = s.outcomes.filter(o => !o.denied)

  // Test runs failing in a row since the last passing one, while they are
  // recent and the session has not moved on to something else.
  const runs = counted.map(o => ({ o, verdict: testVerdict(o) })).filter(r => r.verdict !== null)
  let failing = 0
  for (let i = runs.length - 1; i >= 0 && runs[i].verdict === 'fail'; i--) failing++
  const lastRun = runs.at(-1)?.o
  // Failed test runs are judged here alone, never again as plain tool errors.
  const testFailures = new Set(runs.filter(r => r.verdict === 'fail').map(r => r.o))
  if (failing >= 2 && now - lastRun.ts <= RECENT_MS && !hasMovedOn(s, lastRun.ts)) {
    const failed = runs.slice(-failing).map(r => r.o)
    found.push({
      kind: 'TESTS_FAILING',
      severity: failing >= 3 ? 'error' : 'warn',
      since: failed[0].ts,
      count: failing,
      title: `Tests schlagen ${failing}x fehl`,
      detail: `${lastRun.cmd ?? lastRun.desc} → ${firstLine(lastRun.error ?? lastRun.out)}`,
      outcome: lastRun,
    })
  }

  // The same error three times in a row: the newest outcomes of that agent,
  // stopped by the first success or a different error.
  const last = counted.at(-1)
  if (last !== undefined && !last.ok && now - last.ts <= RECENT_MS && !testFailures.has(last) && !hasMovedOn(s, last.ts)) {
    const mine = counted.filter(o => o.agent === last.agent)
    const sig = signature(last)
    let run = 0
    for (let i = mine.length - 1; i >= 0 && !mine[i].ok && signature(mine[i]) === sig; i--) run++
    if (run >= 3) {
      const first = mine[mine.length - run]
      found.push({
        kind: 'SAME_ERROR',
        severity: 'error',
        since: first.ts,
        count: run,
        title: `Gleicher Fehler ${run}x hintereinander (${last.tool})`,
        detail: `${target(last) || last.tool} → ${firstLine(last.error)}`,
        outcome: last,
      })
    }
  }

  // Many tool errors in a short time, of whatever kind, beyond those above.
  const burst = counted.filter(o => !o.ok && now - o.ts <= BURST_MS && !testFailures.has(o))
  if (burst.length >= 5 && !found.some(p => p.kind === 'SAME_ERROR')) {
    const latest = burst.at(-1)
    found.push({
      kind: 'REPEATED_ERRORS',
      severity: 'warn',
      since: burst[0].ts,
      count: burst.length,
      title: `Wiederholte Tool-Fehler: ${burst.length} in ${minutes(BURST_MS)}`,
      detail: `zuletzt ${latest.tool}: ${target(latest) || ''} → ${firstLine(latest.error)}`,
      outcome: latest,
    })
  }

  // A turn that has not moved for ten minutes: waiting for the person, or hanging.
  if (s.turnActive && now - s.lastProgress > STALL_MS) {
    const asks = [...(s.openCalls?.values() ?? [])].find(c => USER_TOOLS.has(c.tool))
    const waitsForPermission = s.attention?.kind === 'permission_prompt'
    const waits = s.attention !== null && s.attention !== undefined
    const idle = minutes(now - s.lastProgress)
    if (waitsForPermission || asks || waits) {
      found.push({
        kind: waitsForPermission ? 'WAITING_PERMISSION' : 'WAITING_INPUT',
        severity: 'warn',
        since: s.lastProgress,
        title: waitsForPermission ? `Wartet seit ${idle} auf deine Freigabe` : `Wartet seit ${idle} auf deine Antwort`,
        detail: s.attention?.text || (asks ? `offene Frage (${asks.tool})` : ''),
      })
    } else {
      found.push({
        kind: 'STALLED',
        severity: 'warn',
        since: s.lastProgress,
        title: `Seit ${idle} kein Fortschritt`,
        detail: s.lastCall ? `letzter Schritt: ${s.lastCall.tool} ${s.lastCall.desc}` : 'noch kein Tool-Aufruf in dieser Antwort',
      })
    }
  }

  // API errors and refusals since the last answer that went through, or
  // since the running turn visibly got going again.
  const isMoving = s.turnActive && s.lastOkAt > (s.turnStartedAt ?? Infinity)
  const okSince = Math.max(s.lastAnswerAt ?? 0, isMoving ? s.turnStartedAt : 0)
  const apiErrors = s.errors.filter(e => e.ts > okSince && now - e.ts <= RECENT_MS)
  if (apiErrors.length > 0) {
    const latest = apiErrors.at(-1)
    found.push({
      kind: latest.kind === 'refusal' ? 'REFUSAL' : 'API_ERROR',
      severity: 'error',
      since: apiErrors[0].ts,
      count: apiErrors.length,
      title: latest.kind === 'refusal' ? 'Modell hat die Antwort verweigert' : `API-Fehler beendet die Antwort${apiErrors.length > 1 ? ` (${apiErrors.length}x)` : ''}`,
      detail: firstLine(latest.error) || latest.kind,
      error: latest.error,
    })
  }

  return withSuggestions(found, s)
}

/** A newer prompt was answered: the session works on something else now. */
function hasMovedOn(s, ts) {
  return s.lastAnswerAt > ts && s.prompts.some(p => p.ts > ts)
}

function withSuggestions(found, s) {
  return found.map(p => ({ ...p, ...suggest(p, s) }))
}

export function status(s, now, found) {
  if (s.ended) return 'beendet'
  if (now - s.lastSeen > INACTIVE_MS) return 'inaktiv'
  if (found.some(p => p.severity === 'error')) return 'Fehler'
  if (found.some(p => p.kind === 'WAITING_PERMISSION' || p.kind === 'WAITING_INPUT')) return 'wartet'
  if (found.some(p => p.kind === 'STALLED')) return 'hängt'
  if (s.turnActive && s.attention?.kind === 'permission_prompt') return 'wartet'
  if (s.turnActive) return 'läuft'
  return 'bereit'
}

// ---------- the telling line ----------

const TELLING =
  /\bnot ok\b|\bFAIL(ED)?\b|\b\w*Error\b|\berror\b|✖|✗|\bassert|\bexpected\b|\bpanic|\bexception\b|No such file|not found|denied/i
// A Python traceback says what went wrong in its last line, not its header.
const TRACEBACK = /Traceback \(most recent call last\)/
const EXCEPTION_LINE = /^[\w.]*(?:Error|Exception|Exit|Interrupt|Warning)\b/

/** The line that says what went wrong; else the first one. */
export function firstLine(text) {
  const raw = String(text ?? '')
  const lines = raw
    .split(/\s*(?:\n|⏎)\s*/)
    .map(l => l.replace(/^exit code \d+\s*/i, '').trim())
    .filter(l => l !== '' && l !== '…' && !TRACEBACK.test(l))
  if (TRACEBACK.test(raw)) {
    const exception = lines.findLast(l => EXCEPTION_LINE.test(l))
    if (exception !== undefined) return exception.slice(0, 160)
  }
  return (lines.find(l => TELLING.test(l)) ?? lines[0] ?? '').slice(0, 160)
}

export function minutes(ms) {
  const m = Math.round(ms / 60_000)
  return m < 1 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${m} min`
}
