import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { answerPath, copyAnswer, parseClick, targetAt } from '../lib/copy.mjs'
import { buildSession } from '../lib/model.mjs'
import { frame } from '../lib/render.mjs'

const T0 = 1_760_000_000_000

const session = (file, project, ts = T0) =>
  buildSession(
    [{ v: 1, ts, type: 'session_start', sid: file.replace('.jsonl', ''), short: file.slice(0, 4), cwd: `/w/${project}`, project, color: 'BLAU', hex: '#3B82F6' }],
    file,
  )

test('each session row carries a copy button, numbered by its place, shown only with a saved answer', () => {
  const a = session('aaaa-1.jsonl', 'web-store', T0 + 2)
  const b = session('bbbb-2.jsonl', 'order-api', T0 + 1)
  const rows = [a, b].map(s => ({ session: s, problems: [], status: 'bereit' }))
  const { text, targets } = frame(rows, T0 + 3000, { isColor: false, columns: 120, hasAnswer: s => s === b })
  const lines = text.split('\n')

  assert.deepEqual(targets.map(t => [t.n, t.session.project]), [[1, 'web-store'], [2, 'order-api']])
  assert.match(lines[targets[0].line], /^ {3} ● /)
  assert.match(lines[targets[1].line], /^⧉2  ● /)
})

test('a click on a button picks its session, a click anywhere else none', () => {
  const s = session('aaaa-1.jsonl', 'web-store')
  const targets = [{ line: 2, n: 1, session: s }]
  assert.equal(targetAt(targets, 1, 3), s)
  assert.equal(targetAt(targets, 3, 3), s)
  assert.equal(targetAt(targets, 5, 3), undefined)
  assert.equal(targetAt(targets, 1, 4), undefined)
})

test('only a left-button press counts as a click; release, wheel and keys do not', () => {
  assert.deepEqual(parseClick('\x1b[<0;2;5M'), { x: 2, y: 5 })
  assert.equal(parseClick('\x1b[<0;2;5m'), null)
  assert.equal(parseClick('\x1b[<64;2;5M'), null)
  assert.equal(parseClick('1'), null)
})

test('copying hands the saved answer to the clipboard and names the session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overseer-copy-'))
  const s = session('aaaa-1.jsonl', 'web-store')
  mkdirSync(join(dir, 'answers'))
  writeFileSync(answerPath(dir, s), 'Erledigt.\n\n- Punkt eins\n- Punkt zwei')
  let copied = null
  const message = copyAnswer(dir, s, text => {
    copied = text
  })
  assert.equal(copied, 'Erledigt.\n\n- Punkt eins\n- Punkt zwei')
  assert.match(message, /web-store/)
  assert.match(message, /36 Zeichen/)
})

test('without a saved answer nothing is copied and the message says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overseer-copy-'))
  let isCalled = false
  const message = copyAnswer(dir, session('bbbb-2.jsonl', 'order-api'), () => {
    isCalled = true
  })
  assert.equal(isCalled, false)
  assert.match(message, /order-api/)
  assert.match(message, /noch keine Antwort/)
})

test('a failing clipboard is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overseer-copy-'))
  const s = session('aaaa-1.jsonl', 'web-store')
  mkdirSync(join(dir, 'answers'))
  writeFileSync(answerPath(dir, s), 'x')
  const message = copyAnswer(dir, s, () => {
    throw new Error('pbcopy: not found')
  })
  assert.match(message, /nicht kopiert.*pbcopy: not found/)
})

test('the button of an ended session stays readable, only the row behind it is dimmed', () => {
  const s = session('aaaa-1.jsonl', 'web-store')
  const { text } = frame([{ session: s, problems: [], status: 'beendet' }], T0 + 3000, { isColor: true, columns: 120, hasAnswer: () => true })
  const row = text.split('\n').find(l => l.includes('web-store'))
  assert.match(row, /^\x1b\[1m⧉1 \x1b\[22m \x1b\[2m/)
})
