// Reads the reporter's JSON Lines into one model per session.

// JSON turns \u001b back into a raw byte: anything taken from a session file
// is cleaned before it can reach the terminal as an escape sequence.
export function clean(value) {
  if (value === undefined || value === null) return value ?? null
  return String(value)
    .replace(/\x1b\[[0-9;?]{0,32}[ -/]{0,4}[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]{0,512}(?:\x07|\x1b\\)?/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

const HEX = /^#[0-9A-Fa-f]{6}$/

// How a denial reads when it arrived as an errored result (permission
// dialog, PreToolUse hook, Esc); older files did not mark these.
const DENIED = /The user doesn't want to proceed with this tool use|The tool use was rejected|PreToolUse:\w+ hook error|^\[Request interrupted by user/

export function parseLines(text) {
  const events = []
  for (const raw of text.split('\n')) {
    const one = raw.trim()
    if (one === '') continue
    try {
      const event = JSON.parse(one)
      if (event && typeof event === 'object' && typeof event.type === 'string' && typeof event.ts === 'number') {
        events.push(event)
      }
    } catch {
      // a line cut by a write in progress: the next read has it whole
    }
  }
  return events
}

export function buildSession(events, file) {
  const s = {
    file,
    id: file.replace(/\.jsonl$/, ''),
    short: clean(file.slice(0, 4)),
    project: '?',
    cwd: '?',
    branch: null,
    color: 'GRAU',
    hex: '#94A3B8',
    iterm: null,
    startedAt: null,
    lastSeen: 0,
    lastBeat: 0,
    lastProgress: 0,
    lastAnswerAt: 0,
    lastOkAt: 0,
    ended: false,
    endReason: null,
    turnActive: false,
    turnStartedAt: null,
    prompts: [],
    outcomes: [],
    errors: [],
    attention: null,
    lastCall: null,
    openCalls: new Map(),
  }
  const calls = new Map()

  for (const e of events) {
    s.lastSeen = Math.max(s.lastSeen, e.ts)
    switch (e.type) {
      case 'session_start':
        Object.assign(s, {
          id: clean(e.sid) ?? s.id,
          short: clean(e.short) ?? s.short,
          project: clean(e.project) ?? s.project,
          cwd: clean(e.cwd) ?? s.cwd,
          branch: clean(e.branch),
          color: clean(e.color) ?? s.color,
          hex: HEX.test(String(e.hex)) ? e.hex : s.hex,
          iterm: clean(e.iterm),
          ended: false,
          endReason: null,
          attention: null,
        })
        s.startedAt ??= e.ts
        break
      case 'meta':
        if ('branch' in e) s.branch = clean(e.branch)
        break
      case 'heartbeat':
        s.lastBeat = e.ts
        if (e.branch !== undefined) s.branch = clean(e.branch)
        break
      case 'user_prompt':
        s.prompts.push({ ts: e.ts, text: clean(e.text) ?? '', command: clean(e.command) })
        s.lastProgress = e.ts
        s.attention = null
        break
      case 'tool_call': {
        const call = {
          ts: e.ts,
          id: e.id,
          tool: clean(e.tool),
          desc: clean(e.desc) ?? '',
          cmd: clean(e.cmd),
          agent: clean(e.agent),
        }
        if (e.id) {
          calls.set(e.id, call)
          s.openCalls.set(e.id, call)
        }
        s.lastCall = call
        s.lastProgress = e.ts
        s.attention = null
        break
      }
      case 'tool_ok':
      case 'tool_error': {
        const call = (e.id && calls.get(e.id)) || (s.lastCall?.tool === e.tool ? s.lastCall : null)
        const error = e.type === 'tool_error' ? (clean(e.error) ?? '') : null
        s.outcomes.push({
          ts: e.ts,
          id: e.id,
          tool: clean(e.tool),
          ok: e.type === 'tool_ok',
          denied: e.denied === true || (error !== null && DENIED.test(error)),
          error,
          out: clean(e.out),
          cmd: call?.cmd ?? null,
          desc: call?.desc ?? '',
          agent: clean(e.agent) ?? call?.agent ?? null,
        })
        if (e.id) s.openCalls.delete(e.id)
        if (e.type === 'tool_ok') s.lastOkAt = e.ts
        s.lastProgress = e.ts
        s.attention = null
        break
      }
      case 'turn_start':
        s.turnActive = true
        s.turnStartedAt = e.ts
        s.lastProgress = e.ts
        s.attention = null
        break
      case 'turn_end':
        s.turnActive = false
        s.lastProgress = e.ts
        s.lastTurnEnd = { ts: e.ts, reason: e.reason }
        if (e.reason === 'answer') s.lastAnswerAt = e.ts
        s.attention = null
        s.openCalls.clear()
        break
      case 'error':
        s.errors.push({ ts: e.ts, kind: clean(e.kind), error: clean(e.error) ?? '' })
        break
      case 'attention':
        s.attention = { ts: e.ts, kind: clean(e.kind), text: clean(e.text) ?? '' }
        break
      case 'session_end':
        s.ended = true
        s.endReason = clean(e.reason)
        s.turnActive = false
        s.attention = null
        s.openCalls.clear()
        break
      default:
        break
    }
  }
  return s
}

// Words that only confirm or steer; a prompt made of nothing else is no task.
const CONFIRM = new Set(
  'ja nein ok okay okey weiter mach mache macht bitte danke passt gut genau klar los super prima jo jep nö yes no yep nope go ahead continue proceed thanks thank you sure fine good great do it that this with please y n und and'.split(
    ' ',
  ),
)

function isTrivial(text) {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return words.length === 0 || words.every(w => CONFIRM.has(w) || /^\d+$/.test(w))
}

/** The task: the newest prompt that is neither a slash command nor a mere "ok, weiter". */
export function currentTask(s) {
  for (let i = s.prompts.length - 1; i >= 0; i--) {
    const p = s.prompts[i]
    const text = p.text.trim()
    // a slash command, its expansion or a harness notice (`<task-notification>`)
    if (p.command || text.startsWith('/') || /^<[a-z][\w-]*>/.test(text)) continue
    if (text.length >= 3 && !isTrivial(text)) return text
  }
  const last = s.prompts.at(-1)
  return last ? last.text.trim() : ''
}
