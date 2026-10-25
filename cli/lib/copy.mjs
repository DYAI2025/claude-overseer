// The copy button: a session's last answer, as the reporter kept it beside
// the session's file, onto the clipboard. Nothing goes back into a session.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Cells a row's button takes: "⧉" and up to two digits.
const BUTTON_CELLS = 3

export function answerPath(dir, session) {
  return join(dir, 'answers', session.file.replace(/\.jsonl$/, '.md'))
}

/** An SGR mouse report (ESC [ < b ; x ; y M) of a left-button press, else null. */
export function parseClick(data) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(data)
  if (m === null || Number(m[1]) !== 0) return null
  return { x: Number(m[2]), y: Number(m[3]) }
}

/** The session whose button sits at the 1-based screen cell x, y. */
export function targetAt(targets, x, y) {
  if (x > BUTTON_CELLS) return undefined
  return targets.find(t => t.line === y - 1)?.session
}

/** Copies the session's last answer with `toClipboard`; returns what to tell the person. */
export function copyAnswer(dir, session, toClipboard) {
  let text
  try {
    text = readFileSync(answerPath(dir, session), 'utf8')
  } catch {
    return `${session.project}: noch keine Antwort zum Kopieren`
  }
  try {
    toClipboard(text)
  } catch (err) {
    return `${session.project}: nicht kopiert (${err instanceof Error ? err.message : String(err)})`
  }
  return `Letzte Antwort von ${session.project} kopiert (${text.length.toLocaleString('de-DE')} Zeichen)`
}
