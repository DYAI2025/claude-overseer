// A concrete fix and a next step for each problem. Rules on the error text
// come first (most specific first); each problem kind has its own fallback.
// "next" is what the person at the overseer does: often a sentence to paste.

import { firstLine } from './analyze.mjs'

const RULES = [
  {
    match: /(command not found|not found):?\s*g?timeout|g?timeout: (command )?not found/i,
    fix: 'macOS hat kein `timeout` (coreutils fehlt). Die Session soll perl-alarm nutzen: `perl -e \'alarm shift; exec @ARGV or do { print STDERR "exec failed: $!\\n"; exit 127 }\' 60 <cmd>`.',
    next: 'Schreib der Session: "Kein `timeout` auf diesem Mac – nimm den perl-alarm-Wrapper aus dem Vorschlag."',
  },
  {
    match: /String to replace not found|old_string.*not found|not unique in the file/i,
    fix: 'Edit trifft den Dateiinhalt nicht (Datei hat sich geändert oder Einrückung weicht ab). Datei neu lesen, dann gezielt ersetzen.',
    next: 'Schreib der Session: "Lies die Datei neu und kopiere old_string exakt aus dem Read-Output."',
  },
  {
    match: /has not been read yet|must read .* before|File has been modified since read/i,
    fix: 'Edit/Write ohne aktuellen Read. Die Session muss die Datei erst (erneut) lesen.',
    next: 'Schreib der Session: "Erst Read auf die Datei, dann editieren."',
  },
  {
    match: /EADDRINUSE|address already in use|port .* (is )?(already )?in use/i,
    fix: 'Port ist belegt – meist ein alter Dev-Server aus einem früheren Lauf.',
    next: 'Prüfe selbst: `lsof -nP -iTCP -sTCP:LISTEN | grep <port>`, alten Prozess beenden oder der Session einen anderen Port nennen.',
  },
  {
    match: /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package/i,
    fix: 'Abhängigkeit fehlt oder falsche Umgebung (venv/node_modules nicht aktiv).',
    next: 'Schreib der Session: "Prüf, welche Umgebung aktiv ist (uv/venv, node_modules) und installiere die fehlende Abhängigkeit, statt erneut zu starten."',
  },
  {
    match: /command not found|: not found\b|No such file or directory.*(bin|exec)|ENOENT.*spawn/i,
    fix: 'Programm fehlt im PATH dieser Session oder ist nicht installiert.',
    next: 'Schreib der Session: "Prüf mit `command -v <tool>`, ob es installiert ist; nutze den absoluten Pfad oder installiere es."',
  },
  {
    match: /No such file or directory|ENOENT|does not exist|cannot access/i,
    fix: 'Pfad existiert nicht – falsches Arbeitsverzeichnis oder Tippfehler im Pfad.',
    next: 'Schreib der Session: "Zeig `pwd` und `ls` vom Elternordner, dann korrigiere den Pfad."',
  },
  {
    match: /Permission denied|EACCES|Operation not permitted|EPERM/i,
    fix: 'Rechte fehlen (Datei-Rechte, macOS-Sandbox/TCC oder ein Hook blockiert).',
    next: 'Prüf, ob ein Hook/Permission-Regel das blockiert; sonst Rechte mit `ls -l` prüfen – nicht mit sudo umgehen lassen.',
  },
  {
    match: /error TS\d{4}|SyntaxError|ParseError|IndentationError|Unexpected token/i,
    fix: 'Syntax- oder Typfehler im Code. Erneutes Ausführen hilft nicht, die gemeldete Stelle muss korrigiert werden.',
    next: 'Schreib der Session: "Lies die gemeldete Datei an der Fehlerzeile und behebe genau diesen Fehler, bevor du erneut startest."',
  },
  {
    match: /rate.?limit|\b429\b|overloaded|\b529\b|quota/i,
    fix: 'API-Limit oder Überlast. Kein Fehler im Code.',
    next: 'Ein paar Minuten warten, dann in der Session "weiter" schreiben; bei Dauer-Limit `/model` auf ein anderes Modell.',
  },
  {
    match: /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|getaddrinfo|network/i,
    fix: 'Netzwerk/Timeout: Ziel nicht erreichbar oder Dienst läuft nicht.',
    next: 'Prüf selbst, ob der Dienst läuft (`curl -sS -o /dev/null -w "%{http_code}" <url>`), bevor die Session weiter probiert.',
  },
  {
    match: /CONFLICT|merge conflict|non-fast-forward|rejected.*fetch first|diverged/i,
    fix: 'Git-Konflikt bzw. Branch weicht vom Remote ab.',
    next: 'Selbst entscheiden: Schreib der Session "Stopp – zeig `git status` und den Konflikt, kein force-push."',
  },
  {
    match: /not a git repository/i,
    fix: 'Session arbeitet in einem Ordner ohne Git-Repo.',
    next: 'Schreib der Session den richtigen Repo-Pfad oder prüf `git worktree list`.',
  },
]

// How to run one failing test alone, per runner.
const ISOLATE = [
  [/\bnode\s+--test\b/, 'node --test --test-name-pattern "<name>" <datei>'],
  [/\bvitest\b/, 'npx vitest run -t "<name>"'],
  [/\bjest\b/, 'npx jest -t "<name>"'],
  [/\b(pytest|py\.test)\b|-m\s+pytest/, 'pytest -x -k "<name>"'],
  [/\bgo\s+test\b/, 'go test -run "<Name>" ./<pkg>'],
  [/\bcargo\s+(nextest\s+run|test)\b/, 'cargo test <name> -- --nocapture'],
  [/\bbun\s+test\b/, 'bun test -t "<name>"'],
  [/\bplaywright\b/, 'npx playwright test -g "<name>"'],
  [/\brspec\b/, 'rspec <datei>:<zeile>'],
  [/\b(npm|pnpm|yarn)\s+(run\s+)?test\b/, 'npm test -- -t "<name>" (je nach Runner)'],
]

const BY_KIND = {
  TESTS_FAILING: p => {
    const cmd = p.outcome?.cmd ?? ''
    const isolate = ISOLATE.find(([re]) => re.test(cmd))?.[1] ?? 'nur den ersten fehlschlagenden Test'
    return {
      fix: `Die Session startet dieselbe Testsuite immer wieder, ohne die Ursache zu beheben. Erst den ersten fehlschlagenden Test isoliert laufen lassen (\`${isolate}\`) und dessen Meldung vollständig lesen.`,
      next: `Schreib der Session: "Stopp. Führ nur den ersten fehlschlagenden Test aus (\`${isolate}\`), lies die komplette Meldung und nenne die Root Cause, bevor du erneut testest oder etwas änderst."`,
    }
  },
  SAME_ERROR: () => ({
    fix: 'Die Session wiederholt denselben Ansatz. Ein weiterer Versuch derselben Art bringt nichts – Strategie wechseln.',
    next: 'Wechsle in die Session, drück Esc und schreib: "Du hast 3x denselben Fehler. Stopp, analysiere die Ursache und schlag einen anderen Ansatz vor."',
  }),
  REPEATED_ERRORS: () => ({
    fix: 'Viele Tool-Fehler in kurzer Zeit: die Session tastet sich vermutlich blind vor.',
    next: 'Schau in die Session; wenn sie rät, schreib: "Kurz innehalten: fasse zusammen, was fehlschlägt und warum, bevor du weitermachst."',
  }),
  STALLED: (p, s) => ({
    fix: 'Keine Tool-Aufrufe und keine Antwort seit über 10 Minuten. Möglich: hängender Befehl (Server im Vordergrund, interaktives Programm, wartet auf stdin) oder ein langer Lauf.',
    next: `Wechsle in den Tab${s.iterm ? ` (iTerm ${s.iterm})` : ''}: läuft ein Befehl? Wenn er hängt, Esc drücken und schreiben "Der Befehl hängt – starte ihn im Hintergrund oder mit Timeout."`,
  }),
  WAITING_INPUT: (p, s) => ({
    fix: 'Die Session hat dir eine Frage gestellt und wartet auf deine Antwort.',
    next: `Wechsle in den Tab${s.iterm ? ` (iTerm ${s.iterm})` : ''} und beantworte die Frage.`,
  }),
  WAITING_PERMISSION: (p, s) => ({
    fix: 'Die Session wartet auf eine Freigabe von dir (Permission-Dialog).',
    next: `Wechsle in den Tab${s.iterm ? ` (iTerm ${s.iterm})` : ''} und beantworte den Dialog.`,
  }),
  API_ERROR: () => ({
    fix: 'Die Antwort wurde von einem API-Fehler beendet (Limit, Überlast oder Kontext zu lang).',
    next: 'Bei "prompt too long": in der Session `/compact`; sonst kurz warten und "weiter" schreiben.',
  }),
  REFUSAL: () => ({
    fix: 'Das Modell hat die Anfrage abgelehnt.',
    next: 'Anfrage in der Session umformulieren und den legitimen Zweck nennen.',
  }),
  NO_SIGNAL: (p, s) => ({
    fix: 'Die Session sendet keine Heartbeats mehr, ohne sauber beendet worden zu sein.',
    next: `Prüf, ob das Terminal${s.iterm ? ` (iTerm ${s.iterm})` : ''} noch offen ist; sonst mit \`claude --resume ${s.id}\` fortsetzen.`,
  }),
}

export function suggest(problem, session) {
  // Only what the tool said counts, never the command or a test file's name:
  // test_rate_limit.py failing an assert is no rate limit. For a test run,
  // only its telling line, since a test's output can say anything.
  const error = problem.outcome?.error ?? problem.outcome?.out ?? problem.error ?? ''
  const said = problem.kind === 'TESTS_FAILING' ? firstLine(error) : error
  // paths and test ids name things, they do not say what went wrong
  const text = said.replace(/\S*(?:\/|::|\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|swift|php))\S*/g, ' ')
  const kindFallback = BY_KIND[problem.kind]?.(problem, session) ?? {
    fix: 'Unbekanntes Muster – Session ansehen.',
    next: 'Wechsle in die Session und lies die letzte Fehlermeldung.',
  }
  // The kind's own advice wins where the kind says more than the text can
  // (waiting for permission, no signal); elsewhere the error text decides.
  if (['WAITING_PERMISSION', 'WAITING_INPUT', 'NO_SIGNAL', 'STALLED'].includes(problem.kind)) return kindFallback
  const rule = RULES.find(r => r.match.test(text))
  return rule ? { fix: rule.fix, next: rule.next } : kindFallback
}
