import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isTestCommand, problems, signature, status } from '../lib/analyze.mjs'
import { buildSession, currentTask, parseLines } from '../lib/model.mjs'
import { cells, render, wrap } from '../lib/render.mjs'
import { bellKeeper, snapshot } from '../overseer.mjs'

const T0 = 1_760_000_000_000
const MIN = 60_000

const start = (over = {}) => ({
  v: 1, ts: T0, type: 'session_start', sid: 'a3f2c0de-0000', short: 'a3f2', cwd: '/w/web-store',
  project: 'web-store', branch: 'main', colorIndex: 0, color: 'BLAU', hex: '#3B82F6', ...over,
})
const call = (ts, id, cmd) => ({ v: 1, ts, type: 'tool_call', id, tool: 'Bash', desc: cmd, cmd })
const fail = (ts, id, error) => ({ v: 1, ts, type: 'tool_error', id, tool: 'Bash', error })
const ok = (ts, id) => ({ v: 1, ts, type: 'tool_ok', id, tool: 'Bash' })
const beat = ts => ({ v: 1, ts, type: 'heartbeat' })

const session = events => buildSession(events, 'a3f2c0de-0000.jsonl')

test('three failing test runs are one TESTS_FAILING error with a next step', () => {
  const s = session([
    start(),
    { v: 1, ts: T0 + 1, type: 'user_prompt', text: 'Fix the login redirect bug in auth' },
    { v: 1, ts: T0 + 2, type: 'turn_start' },
    call(T0 + 10, 't1', 'uv run pytest tests/test_auth.py'),
    fail(T0 + 20, 't1', 'Exit code 1 ⏎ FAILED tests/test_auth.py::test_redirect - AssertionError'),
    call(T0 + 30, 't2', 'uv run pytest tests/test_auth.py'),
    fail(T0 + 40, 't2', 'Exit code 1 ⏎ FAILED tests/test_auth.py::test_redirect - AssertionError'),
    call(T0 + 50, 't3', 'uv run pytest tests/test_auth.py'),
    fail(T0 + 60, 't3', 'Exit code 1 ⏎ FAILED tests/test_auth.py::test_redirect - AssertionError'),
  ])
  const found = problems(s, T0 + MIN)
  assert.deepEqual(found.map(p => p.kind), ['TESTS_FAILING'])
  assert.equal(found[0].title, 'Tests schlagen 3x fehl')
  assert.equal(found[0].severity, 'error')
  assert.match(found[0].next, /ersten fehlschlagenden Test/)
  assert.equal(status(s, T0 + MIN, found), 'Fehler')
})

test('a passing run clears the failing tests', () => {
  const s = session([
    start(),
    call(T0 + 10, 't1', 'npm test'), fail(T0 + 20, 't1', 'Exit code 1 ⏎ 1 failing'),
    call(T0 + 30, 't2', 'npm test'), fail(T0 + 40, 't2', 'Exit code 1 ⏎ 1 failing'),
    call(T0 + 50, 't3', 'npm test'), ok(T0 + 60, 't3'),
  ])
  assert.deepEqual(problems(s, T0 + MIN), [])
})

test('the same non-test error three times is SAME_ERROR with a matching rule', () => {
  const s = session([
    start(),
    call(T0 + 10, 'a', 'ls /nope'), fail(T0 + 20, 'a', 'Exit code 1 ⏎ ls: /nope: No such file or directory'),
    call(T0 + 30, 'b', 'ls /nope'), fail(T0 + 40, 'b', 'Exit code 1 ⏎ ls: /nope: No such file or directory'),
    call(T0 + 50, 'c', 'ls /nope'), fail(T0 + 60, 'c', 'Exit code 1 ⏎ ls: /nope: No such file or directory'),
  ])
  const found = problems(s, T0 + MIN)
  assert.deepEqual(found.map(p => p.kind), ['SAME_ERROR'])
  assert.equal(found[0].title, 'Gleicher Fehler 3x hintereinander (Bash)')
  assert.match(found[0].fix, /Pfad existiert nicht/)
})

test('two of the same error are not yet a problem; denials never count', () => {
  const s = session([
    start(),
    call(T0 + 10, 'a', 'ls /nope'), fail(T0 + 20, 'a', 'No such file or directory'),
    call(T0 + 30, 'b', 'ls /nope'), fail(T0 + 40, 'b', 'No such file or directory'),
    call(T0 + 50, 'c', 'rm -rf x'), { ...fail(T0 + 60, 'c', 'The user denied this'), denied: true },
  ])
  assert.deepEqual(problems(s, T0 + MIN), [])
})

test('five different errors in ten minutes are REPEATED_ERRORS', () => {
  const events = [start()]
  for (let i = 0; i < 5; i++) events.push(call(T0 + i * 10, `x${i}`, `cmd${i}`), fail(T0 + i * 10 + 5, `x${i}`, `error number ${'abcde'[i]}x`))
  const found = problems(session(events), T0 + MIN)
  assert.deepEqual(found.map(p => p.kind), ['REPEATED_ERRORS'])
})

test('a turn without progress for over ten minutes hangs; with heartbeats it is alive', () => {
  const events = [start(), { v: 1, ts: T0 + 1, type: 'turn_start' }, call(T0 + 2, 'a', 'npm run dev')]
  for (let t = 30_000; t <= 11 * MIN; t += 30_000) events.push(beat(T0 + t))
  const s = session(events)
  const now = T0 + 11 * MIN
  const found = problems(s, now)
  assert.deepEqual(found.map(p => p.kind), ['STALLED'])
  assert.match(found[0].title, /Seit 11 min kein Fortschritt/)
  assert.equal(status(s, now, found), 'hängt')
})

test('waiting on a permission dialog is told apart from hanging', () => {
  const events = [
    start(), { v: 1, ts: T0 + 1, type: 'turn_start' }, call(T0 + 2, 'a', 'git push'),
    { v: 1, ts: T0 + 3, type: 'attention', kind: 'permission_prompt', text: 'Claude needs your permission to use Bash' },
  ]
  for (let t = 30_000; t <= 12 * MIN; t += 30_000) events.push(beat(T0 + t))
  const s = session(events)
  const found = problems(s, T0 + 12 * MIN)
  assert.deepEqual(found.map(p => p.kind), ['WAITING_PERMISSION'])
  assert.equal(status(s, T0 + 12 * MIN, found), 'wartet')
})

test('five minutes without a heartbeat is inactive', () => {
  const s = session([start(), beat(T0 + 30_000)])
  assert.equal(status(s, T0 + 30_000 + 5 * MIN + 1, []), 'inaktiv')
  assert.equal(status(s, T0 + 30_000 + 5 * MIN - 1, []), 'bereit')
})

test('an API error is reported until an answer goes through', () => {
  const s = session([
    start(), { v: 1, ts: T0 + 1, type: 'turn_start' },
    { v: 1, ts: T0 + 2, type: 'turn_end', reason: 'error' },
    { v: 1, ts: T0 + 2, type: 'error', kind: 'api_error', error: 'API Error: 529 overloaded' },
  ])
  const found = problems(s, T0 + MIN)
  assert.deepEqual(found.map(p => p.kind), ['API_ERROR'])
  assert.match(found[0].fix, /Limit oder Überlast/)
  const healed = session([...s.outcomes, start(), { v: 1, ts: T0 + 2, type: 'error', kind: 'api_error', error: 'x' }, { v: 1, ts: T0 + 3, type: 'turn_end', reason: 'answer' }])
  assert.deepEqual(problems(healed, T0 + MIN), [])
})

test('the task is the newest prompt that says something', () => {
  const s = session([
    start(),
    { v: 1, ts: T0 + 1, type: 'user_prompt', text: 'Migrate the billing API to Stripe v2' },
    { v: 1, ts: T0 + 2, type: 'user_prompt', text: 'ok' },
    { v: 1, ts: T0 + 3, type: 'user_prompt', text: 'weiter' },
  ])
  assert.equal(currentTask(s), 'Migrate the billing API to Stripe v2')
})

test('test commands are recognised, others are not', () => {
  for (const cmd of ['pytest -x', 'uv run pytest tests', 'npm test', 'npm run test -- --watch=false', 'pnpm test', 'npx vitest run', 'go test ./...', 'cargo test', 'bun test', 'python3 -m pytest', 'node --test cli/test', 'claude plugin test .']) {
    assert.ok(isTestCommand(cmd), cmd)
  }
  for (const cmd of ['ls tests', 'cat test.txt', 'git commit -m "test"', 'echo latest']) {
    assert.ok(!isTestCommand(cmd), cmd)
  }
})

test('signatures fold numbers so a moving line number is the same error', () => {
  const a = { tool: 'Bash', error: 'Exit code 1 ⏎ file.ts(12,3): error TS2322 x' }
  const b = { tool: 'Bash', error: 'Exit code 1 ⏎ file.ts(14,9): error TS2322 x' }
  assert.equal(signature(a), signature(b))
})

test('a cut last line is skipped, not fatal', () => {
  const events = parseLines(`${JSON.stringify(start())}\n{"v":1,"ts":`)
  assert.equal(events.length, 1)
})

test('render shows colour, project, short id and problem lines, no raw JSON', () => {
  const s = session([
    start(),
    call(T0 + 10, 'a', 'ls /nope'), fail(T0 + 20, 'a', 'No such file or directory'),
    call(T0 + 30, 'b', 'ls /nope'), fail(T0 + 40, 'b', 'No such file or directory'),
    call(T0 + 50, 'c', 'ls /nope'), fail(T0 + 60, 'c', 'No such file or directory'),
  ])
  const found = problems(s, T0 + MIN)
  const text = render([{ session: s, problems: found, status: status(s, T0 + MIN, found) }], T0 + MIN, { isColor: false, columns: 120 })
  assert.match(text, /\[BLAU \| web-store \| a3f2\] Gleicher Fehler 3x hintereinander/)
  assert.match(text, /Vorschlag:/)
  assert.match(text, /Nächster Schritt:/)
  assert.doesNotMatch(text, /"type"|\{"v"/)
})

test('snapshot reads a folder of sessions and hides long-ended ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overseer-'))
  writeFileSync(join(dir, 'aaaa.jsonl'), `${JSON.stringify(start({ sid: 'aaaa', short: 'aaaa' }))}\n`)
  writeFileSync(
    join(dir, 'bbbb.jsonl'),
    `${JSON.stringify(start({ sid: 'bbbb', short: 'bbbb', project: 'other', color: 'ORANGE', hex: '#F97316' }))}\n${JSON.stringify({ v: 1, ts: T0 + 5, type: 'session_end', reason: 'other' })}\n`,
  )
  const rows = snapshot(dir, T0 + MIN)
  assert.deepEqual(rows.map(r => r.status).sort(), ['beendet', 'bereit'])
  assert.equal(snapshot(dir, T0 + 20 * MIN).filter(r => r.status === 'beendet').length, 0)
})

// ---------- review findings, 2026-10-25 ----------

const prompt = (ts, text, extra = {}) => ({ v: 1, ts, type: 'user_prompt', text, ...extra })
const turn = (ts, kind, reason) => ({ v: 1, ts, type: kind, ...(reason ? { reason } : {}) })
const okOut = (ts, id, out) => ({ ...ok(ts, id), out })
const beats = (from, to) => {
  const list = []
  for (let t = from; t <= to; t += 30_000) list.push(beat(T0 + t))
  return list
}
const kinds = (s, now) => problems(s, now).map(p => p.kind)

test('an answered permission prompt no longer reads as waiting', () => {
  const s = session([
    start(), turn(T0 + 1, 'turn_start'), call(T0 + 2, 'a', 'git push'),
    { v: 1, ts: T0 + 3, type: 'attention', kind: 'permission_prompt', text: 'needs permission' },
    ok(T0 + 4, 'a'), turn(T0 + 5, 'turn_end', 'answer'), ...beats(30_000, 20 * MIN),
  ])
  assert.equal(status(s, T0 + 20 * MIN, problems(s, T0 + 20 * MIN)), 'bereit')
})

test('failing tests stop being a problem once the session moved on or they are old', () => {
  const failing = [
    start(), prompt(T0 + 1, 'Fix the login redirect bug'),
    call(T0 + 10, 't1', 'npm test'), fail(T0 + 20, 't1', '1 failing'),
    call(T0 + 30, 't2', 'npm test'), fail(T0 + 40, 't2', '1 failing'),
    call(T0 + 50, 't3', 'npm test'), fail(T0 + 60, 't3', '1 failing'),
  ]
  const movedOn = session([...failing, prompt(T0 + 70, 'forget the tests, write the README'), turn(T0 + 80, 'turn_end', 'answer'), ...beats(30_000, 2 * MIN)])
  assert.deepEqual(kinds(movedOn, T0 + 2 * MIN), [])
  const old = session([...failing, ...beats(30_000, 3 * 60 * MIN)])
  assert.deepEqual(kinds(old, T0 + 3 * 60 * MIN), [])
})

test('more runners are tests; installing, grepping or committing a runner is not', () => {
  for (const cmd of ['./gradlew test', './mvnw test', 'pnpm --filter web test', 'npm -w api test', 'npm t', 'python manage.py test', 'xcodebuild -scheme App test', 'npx turbo run test', 'bundle exec rake test', 'php artisan test', 'cd api && FOO=1 uv run pytest -q']) {
    assert.ok(isTestCommand(cmd), cmd)
  }
  for (const cmd of ['pip install pytest', 'uv add --dev pytest', 'which pytest', 'grep -n vitest package.json', 'cat pytest.ini', 'git commit -m "wip: pytest fixtures"']) {
    assert.ok(!isTestCommand(cmd), cmd)
  }
})

test('the runner verdict counts, not the exit status of a compound command', () => {
  const piped = session([
    start(),
    call(T0 + 10, 't1', 'npm test 2>&1 | tail -20'), okOut(T0 + 20, 't1', 'Tests: 1 failed, 4 passed'),
    call(T0 + 30, 't2', 'npm test 2>&1 | tail -20'), okOut(T0 + 40, 't2', 'Tests: 1 failed, 4 passed'),
    call(T0 + 50, 't3', 'npm test 2>&1 | tail -20'), okOut(T0 + 60, 't3', 'Tests: 1 failed, 4 passed'),
  ])
  assert.deepEqual(kinds(piped, T0 + MIN), ['TESTS_FAILING'])
  const commit = session([
    start(),
    call(T0 + 10, 'c1', 'npm test && git commit -am wip'), fail(T0 + 20, 'c1', 'nothing to commit, working tree clean'),
    call(T0 + 30, 'c2', 'npm test && git commit -am wip'), fail(T0 + 40, 'c2', 'nothing to commit, working tree clean'),
  ])
  assert.ok(!kinds(commit, T0 + MIN).includes('TESTS_FAILING'))
})

test('different Python exceptions are different errors', () => {
  const tb = err => `Exit code 1 ⏎ Traceback (most recent call last): ⏎ File "x.py", line 3 ⏎ ${err}`
  const s = session([
    start(),
    call(T0 + 10, 'a', 'python a.py'), fail(T0 + 20, 'a', tb("ModuleNotFoundError: No module named 'yaml'")),
    call(T0 + 30, 'b', 'python b.py'), fail(T0 + 40, 'b', tb("KeyError: 'id'")),
    call(T0 + 50, 'c', 'python c.py'), fail(T0 + 60, 'c', tb('ValueError: bad')),
  ])
  assert.ok(!kinds(s, T0 + MIN).includes('SAME_ERROR'))
  assert.equal(signature(s.outcomes[1]).includes('keyerror'), true)
})

test('the advice comes from the error, not from the test file name', () => {
  const events = [start()]
  for (let i = 0; i < 3; i++) events.push(call(T0 + i * 10, `r${i}`, 'uv run pytest tests/test_rate_limit.py'), fail(T0 + i * 10 + 5, `r${i}`, 'FAILED tests/test_rate_limit.py::test_x - assert 1 == 2'))
  const [found] = problems(session(events), T0 + MIN)
  assert.equal(found.kind, 'TESTS_FAILING')
  assert.doesNotMatch(found.fix, /API-Limit/)
  assert.match(found.fix, /pytest -x -k/)
})

test('five failing test runs are one problem, not two', () => {
  const events = [start()]
  for (let i = 0; i < 5; i++) events.push(call(T0 + i * 10, `t${i}`, 'npm test'), fail(T0 + i * 10 + 5, `t${i}`, '1 failing'))
  assert.deepEqual(kinds(session(events), T0 + MIN), ['TESTS_FAILING'])
})

test('a question to the person waits, it does not hang', () => {
  const s = session([
    start(), turn(T0 + 1, 'turn_start'),
    { v: 1, ts: T0 + 2, type: 'tool_call', id: 'q', tool: 'AskUserQuestion', desc: 'Which database?' },
    ...beats(30_000, 12 * MIN),
  ])
  const found = problems(s, T0 + 12 * MIN)
  assert.deepEqual(found.map(p => p.kind), ['WAITING_INPUT'])
  assert.equal(status(s, T0 + 12 * MIN, found), 'wartet')
  assert.doesNotMatch(found[0].next, /hängt/)
})

test('confirmations and slash commands are no task; short real prompts are', () => {
  const s = session([
    start(),
    prompt(T0 + 1, 'Migrate the billing API to Stripe v2'),
    prompt(T0 + 2, 'ja, mach weiter bitte'),
    prompt(T0 + 3, '/reload-plugins', { command: 'reload-plugins' }),
    prompt(T0 + 4, 'yes, go ahead with that'),
  ])
  assert.equal(currentTask(s), 'Migrate the billing API to Stripe v2')
  const short = session([start(), prompt(T0 + 1, 'Migrate the billing API'), prompt(T0 + 2, 'Fix CI now')])
  assert.equal(currentTask(short), 'Fix CI now')
})

test('an API error clears once the next turn works, and stays cleared after an abort', () => {
  const apiError = [
    start(), turn(T0 + 1, 'turn_start'), turn(T0 + 2, 'turn_end', 'error'),
    { v: 1, ts: T0 + 2, type: 'error', kind: 'api_error', error: 'API Error: 529 overloaded' },
  ]
  const working = session([...apiError, prompt(T0 + 3, 'weiter'), turn(T0 + 4, 'turn_start'), call(T0 + 5, 'r', 'ls'), ok(T0 + 6, 'r')])
  assert.deepEqual(kinds(working, T0 + MIN), [])
  const aborted = session([...apiError, turn(T0 + 3, 'turn_start'), turn(T0 + 4, 'turn_end', 'answer'), turn(T0 + 5, 'turn_start'), turn(T0 + 6, 'turn_end', 'aborted')])
  assert.deepEqual(kinds(aborted, T0 + MIN), [])
})

test('the same error with successes in between is not three in a row', () => {
  const s = session([
    start(),
    { v: 1, ts: T0 + 10, type: 'tool_call', id: 'a', tool: 'Read', desc: 'a.ts' }, { v: 1, ts: T0 + 11, type: 'tool_error', id: 'a', tool: 'Read', error: 'File does not exist.' },
    call(T0 + 12, 'x', 'ls'), ok(T0 + 13, 'x'),
    { v: 1, ts: T0 + 20, type: 'tool_call', id: 'b', tool: 'Read', desc: 'b.ts' }, { v: 1, ts: T0 + 21, type: 'tool_error', id: 'b', tool: 'Read', error: 'File does not exist.' },
    call(T0 + 22, 'y', 'ls'), ok(T0 + 23, 'y'),
    { v: 1, ts: T0 + 30, type: 'tool_call', id: 'c', tool: 'Read', desc: 'c.ts' }, { v: 1, ts: T0 + 31, type: 'tool_error', id: 'c', tool: 'Read', error: 'File does not exist.' },
  ])
  assert.deepEqual(kinds(s, T0 + MIN), [])
})

test('denials from the dialog or a hook never count, even when not marked', () => {
  const events = [start()]
  for (let i = 0; i < 3; i++) events.push(call(T0 + i * 10, `d${i}`, 'npm test'), fail(T0 + i * 10 + 5, `d${i}`, "The user doesn't want to proceed with this tool use. The tool use was rejected."))
  assert.deepEqual(kinds(session(events), T0 + MIN), [])
})

test('control bytes from a session file never reach the terminal', () => {
  const s = session([start({ project: 'evil\x07\x1b]0;FAKE TITLE\x07\x1b[2Jname', branch: 'b\x1b[31mx' }), ...beats(1000, 1000)])
  const text = render([{ session: s, problems: [], status: 'bereit' }], T0 + 2000, { isColor: false, columns: 120 })
  assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  assert.match(text, /evilname/)
})

test('wide project names keep the columns aligned', () => {
  const rows = ['日本語プロジェクト', 'plain'].map((project, i) => {
    const s = session([start({ project, sid: `s${i}`, short: `s${i}00` }), beat(T0 + 1000)])
    return { session: s, problems: [], status: 'bereit' }
  })
  const lines = render(rows, T0 + 2000, { isColor: false, columns: 120 }).split('\n').filter(l => l.includes('BLAU'))
  const at = line => cells(line.slice(0, line.indexOf('main')))
  assert.equal(at(lines[0]), at(lines[1]))
})

test('the live frame fits the terminal and keeps header and sessions', () => {
  const rows = []
  for (let i = 0; i < 4; i++) {
    const events = [start({ sid: `p${i}`, short: `p${i}00` })]
    for (let k = 0; k < 3; k++) events.push(call(T0 + k * 10, `t${i}${k}`, 'npm test'), fail(T0 + k * 10 + 5, `t${i}${k}`, '1 failing'))
    const s = session(events)
    const found = problems(s, T0 + MIN)
    rows.push({ session: s, problems: found, status: status(s, T0 + MIN, found) })
  }
  const frame = render(rows, T0 + MIN, { isColor: false, columns: 80, lines: 24 }).split('\n')
  assert.ok(frame.length <= 24, `${frame.length} lines`)
  assert.ok(frame.every(l => cells(l) <= 80), 'a line is wider than 80')
  assert.match(frame[0], /OVERSEER/)
  assert.match(frame.join('\n'), /\+ \d+ weitere/)
})

test('the bell rings for a new problem only, not at start or when its window moves', () => {
  const bell = bellKeeper()
  const rows = (...problems) => [{ session: { id: 'x' }, problems }]
  const burst = (since, count) => ({ kind: 'REPEATED_ERRORS', since, count })
  assert.equal(bell(rows(burst(1, 6))), false, 'problems already there at start')
  assert.equal(bell(rows(burst(2, 5))), false, 'the window moved, nothing new')
  assert.equal(bell(rows(burst(2, 6))), true, 'one more error')
  assert.equal(bell(rows(burst(2, 6), { kind: 'SAME_ERROR', since: 3, count: 3 })), true, 'a new kind')
})

test('fix and next step are wrapped, never cut: the sentence to paste stays whole', () => {
  const events = [start()]
  for (let k = 0; k < 3; k++) events.push(call(T0 + k * 10, `t${k}`, 'node --test login.test.mjs'), fail(T0 + k * 10 + 5, `t${k}`, 'not ok 1 - login'))
  const s = session(events)
  const found = problems(s, T0 + MIN)
  const text = render([{ session: s, problems: found, status: 'Fehler' }], T0 + MIN, { isColor: false, columns: 80 })
  const flat = text.replace(/\n\s+/g, ' ')
  assert.ok(flat.includes(found[0].next), 'next step is shown in full')
  assert.ok(text.split('\n').every(l => cells(l) <= 80))
  assert.deepEqual(wrap('aa bb cc', 5), ['aa bb', 'cc'])
})

test('an expanded slash command or a task notification is not shown as the task', () => {
  const s = session([
    start(),
    { v: 1, ts: T0 + 1, type: 'user_prompt', text: 'Baue den Login-Redirect' },
    { v: 1, ts: T0 + 2, type: 'user_prompt', text: '<create-pr-command> ⏎ ## Overview ⏎ Create a pull request' },
    { v: 1, ts: T0 + 3, type: 'user_prompt', text: '<task-notification> ⏎ <task-id>wzym</task-id>' },
  ])
  assert.equal(currentTask(s), 'Baue den Login-Redirect')
})

test('the last call line names a tool once when its description is just the name', () => {
  const s = session([start(), { v: 1, ts: T0 + 1, type: 'tool_call', id: 'q1', tool: 'AskUserQuestion', desc: 'AskUserQuestion' }])
  const text = render([{ session: s, problems: [], status: 'wartet' }], T0 + 2000, { isColor: false, columns: 120 })
  assert.match(text, /↳ AskUserQuestion\s*$/m)
})
