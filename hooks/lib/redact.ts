// Masks secrets before anything is written to disk. Order matters: whole
// blocks and specific token formats first, then credentials in URLs and on
// command lines, then key=value assignments, then e-mails.
//
// Every quantifier that can restart at each position is bounded, and the
// input is capped before it gets here (clip), so redaction stays linear and
// cannot stall a hook on a long unbroken string.

const MASK = '[REDACTED]'
const CAP = 8_000

// A secret-sounding name, ending the key: GITHUB_TOKEN, db.password, "api-key".
const NAME =
  '[A-Za-z0-9_.-]{0,40}?(?:password|passwd|passwort|kennwort|pwd|pass|pw|secret|geheimnis|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|credentials?|cookie|session[_-]?secret|client[_-]?secret|signing[_-]?key|webhook[_-]?url)'
// A value: quoted up to its closing quote, or bare up to whitespace.
const VALUE = `(?:"[^"\\n]{1,512}"|'[^'\\n]{1,512}'|[^\\s"'\\n]{1,512})`

const PATTERNS: readonly [RegExp, string][] = [
  // PEM and PGP private keys, whole block (cut blocks too)
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, MASK],
  // Anthropic / OpenAI style keys
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, MASK],
  // GitHub, GitLab, Hugging Face, Slack, npm, SendGrid tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{30,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, MASK],
  // AWS access key ids, Google API keys, Stripe keys
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Webhook and bot URLs whose path is the secret
  [/(hooks\.slack\.com\/services\/)[^\s"'<>]+/gi, `$1${MASK}`],
  [/(discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>]+/gi, `$1${MASK}`],
  [/(api\.telegram\.org\/bot)[^/\s"'<>]+/gi, `$1${MASK}`],
  // Signed URLs and keys in query strings
  [/([?&](?:sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|key|api_key|apikey|token|access_token|auth|code|secret|password)=)[^&\s"'<>#]+/gi, `$1${MASK}`],
  // Authorization headers
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${MASK}`],
  // URLs with inline credentials: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,128}:)[^\s@/]{1,256}@/gi, `$1${MASK}@`],
  // curl -u user:pass, --user user:pass
  [/(\s(?:-u|--user)\s+["']?[^\s:"']{1,128}:)[^\s"']{1,256}/g, `$1${MASK}`],
  // mysql -pSECRET / -p SECRET, sshpass -p SECRET
  [/(\b(?:mysql|mysqladmin|mysqldump|mariadb|sshpass)\b[^\n|;&]{0,200}?\s-p\s?)[^\s-][^\s]{0,255}/g, `$1${MASK}`],
  // echo SECRET | sudo -S
  [/(\becho\s+)["']?[^\s|]{1,256}["']?(\s*\|\s*sudo\s+-S)/g, `$1${MASK}$2`],
  // SQL: PASSWORD 'x', IDENTIFIED BY 'x'
  [/(\b(?:PASSWORD|IDENTIFIED\s+BY)\s+)'[^'\n]{0,256}'/gi, `$1'${MASK}'`],
  // CLI flags: --password x, --client-secret=x, --auth-token "x"
  [new RegExp(`(--[a-z0-9-]{0,30}(?:password|passwd|secret|token|api-key|apikey|auth|credentials?)(?:=|\\s+))${VALUE}`, 'gi'), `$1${MASK}`],
  // key=value and "key": "value" with a secret-sounding name
  [new RegExp(`(["']?\\b${NAME}["']?\\s{0,4}=\\s{0,4})${VALUE}`, 'gi'), `$1${MASK}`],
  [new RegExp(`(["']?\\b${NAME}["']?\\s{0,4}:\\s{0,4})(?:"[^"\\n]{1,512}"|'[^'\\n]{1,512}')`, 'gi'), `$1${MASK}`],
  // key: value in prose or YAML: the value may hold spaces, mask to the line end
  [new RegExp(`(\\b${NAME}\\s{0,4}:[^\\S\\n]{0,4})(?!\\[REDACTED)[^\\s"'][^\\n]{0,200}`, 'gi'), `$1${MASK}`],
  // e-mail addresses
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g, '[EMAIL]'],
]

// Control bytes would reach a terminal as live escape sequences (the band,
// the tab title, the overseer): ANSI sequences first, then the rest of C0/C1.
export function stripControl(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]{0,32}[ -/]{0,4}[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]{0,512}(?:\x07|\x1b\\)?/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/** Head and tail of a long text, so redaction never runs over megabytes. */
function cap(text: string): string {
  if (text.length <= 2 * CAP) return text
  // cut at whitespace, so no secret is split into halves that match nothing
  const headEnd = Math.max(text.lastIndexOf(' ', CAP), text.lastIndexOf('\n', CAP), CAP / 2)
  const from = text.length - CAP
  const spaces = [text.indexOf(' ', from), text.indexOf('\n', from)].filter(i => i >= 0)
  const tailStart = spaces.length > 0 ? Math.min(...spaces) : from
  return `${text.slice(0, headEnd)}\n…\n${text.slice(tailStart)}`
}

/** Redacts first, then cuts, so a cut never leaves half a secret behind. */
export function clip(text: string, max: number): string {
  const clean = stripControl(redact(cap(text)))
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .replace(/[^\S\n]+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Like clip, but keeps the head and the tail: a test run's verdict is at its end. */
export function clipEnds(text: string, max: number): string {
  const clean = clip(text, Number.MAX_SAFE_INTEGER)
  if (clean.length <= max) return clean
  const tail = Math.floor(max * 0.4)
  return `${clean.slice(0, max - tail - 3)} … ${clean.slice(-tail)}`
}

/** Redacted and free of control bytes, but otherwise unchanged (paths, branch names). */
export function scrub(text: string): string {
  return stripControl(redact(cap(text)))
}
