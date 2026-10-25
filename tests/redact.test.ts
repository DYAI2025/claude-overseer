import { describe, expect, test } from 'claude-code/testing'

import { clip, redact, stripControl } from '../hooks/lib/redact'

// Token-shaped test values are put together at run time, so no scanner
// takes them for real keys.
const GH = `${'ghp'}_abcdefghijklmnopqrstuvwxyz0123456789`
const GL = `${'glpat'}-abcdefghijklmnopqrstu`
const XAPP = `${'xapp'}-1-A0-123-abcdef`

// Each case: input, then the secret part that must not survive.
const LEAKS: readonly [string, string][] = [
  ['export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv123', 'abcdefghijklmnopqrstuv123'],
  [`GITHUB_TOKEN=${GH}`, GH.slice(0, 10)],
  ['DB_PASSWORD="Xy7&kL9!zz"', 'Xy7&kL9!zz'],
  ['{"password": "a,very;secret"}', 'a,very;secret'],
  ['{"password": "correct horse battery"}', 'correct horse battery'],
  ["export DB_PASSWORD='p@ss w0rd!'", 'p@ss w0rd!'],
  ['password: correct horse battery staple', 'horse battery staple'],
  ['Mein Passwort: Sommer2026!', 'Sommer2026'],
  ['--password "my pass phrase"', 'pass phrase'],
  ['--client-secret abc123def456', 'abc123def456'],
  ['curl -u admin:hunter2 https://x.example', 'hunter2'],
  ['mysql -u root -pS3cretPW db', 'S3cretPW'],
  ['echo hunter2 | sudo -S ls', 'hunter2'],
  ["ALTER USER bob IDENTIFIED BY 'Tr0ub4dor';", 'Tr0ub4dor'],
  ['psql postgres://app:Sup3rSecret@db:5432/app', 'Sup3rSecret'],
  ['curl -H "Authorization: Bearer abcdefghijklmnop1234" x', 'abcdefghijklmnop1234'],
  ['curl https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX', 'XXXXXXXXXXXX'],
  ['https://discord.com/api/webhooks/123/abcDEFsecret', 'abcDEFsecret'],
  ['https://api.telegram.org/bot123456:ABC-DEFsecret/sendMessage', 'ABC-DEFsecret'],
  ['https://b.s3.amazonaws.com/f?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIDX', 'deadbeefcafe'],
  ['https://maps.example.com/api?key=AbCdEf123456', 'AbCdEf123456'],
  ['huggingface-cli login --token hf_abcdefghijklmnopqrstuvwxyz12345678', 'hf_abcdefghij'],
  [GL, GL.slice(0, 16)],
  ['SG.abcdefghijklmnopqr.abcdefghijklmnopqrstuvwx', 'SG.abcdefghij'],
  [XAPP, XAPP],
  ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF secretbody\n-----END PGP PRIVATE KEY BLOCK-----', 'secretbody'],
  ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA', 'b3BlbnNzaC1rZXktdjEAAAA'],
  ['contact jane.doe@example.com now', 'jane.doe@example.com'],
  ['/Users/b/Library/CloudStorage/GoogleDrive-alex@example.org/proj', 'alex@example.org'],
]

// Text the overseer needs: must come through unchanged.
const KEEP: readonly string[] = [
  'Exit code 1 ⏎ FAILED tests/test_auth.py::test_redirect - AssertionError',
  'ls: /nope: No such file or directory',
  'author: Alex',
  'tokens: 1234',
  'npm test -- --watch=false',
]

describe('redact', () => {
  test('every known secret format is masked', () => {
    for (const [input, secret] of LEAKS) {
      const out = clip(input, 400)
      expect({ input, leaked: out.includes(secret) }).toEqual({ input, leaked: false })
    }
  })

  test('the text the overseer reads is left alone', () => {
    for (const text of KEEP) expect(redact(text)).toBe(text)
  })

  test('a long unbroken string is redacted quickly', () => {
    const blob = 'A'.repeat(50_000)
    const dashes = 'a-'.repeat(25_000)
    const started = Date.now()
    clip(blob, 400)
    clip(dashes, 400)
    clip(`x=${'b'.repeat(40_000)}@`, 400)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('control bytes cannot reach a terminal', () => {
    const evil = 'evil\x07\x1b]52;c;aGk=\x07\x1b[2Jname'
    expect(stripControl(evil)).toBe('evilname')
    expect(clip(evil, 100)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  })
})
