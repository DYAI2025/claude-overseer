import { clip } from './redact'

const pick = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** One short, redacted line saying what a tool call does. */
export function describeTool(tool: string, input: Record<string, unknown>): string {
  const text =
    (tool === 'Bash' && (pick(input, 'description') ?? pick(input, 'command'))) ||
    pick(input, 'file_path') ||
    pick(input, 'notebook_path') ||
    pick(input, 'pattern') ||
    pick(input, 'url') ||
    pick(input, 'query') ||
    pick(input, 'description') ||
    pick(input, 'skill') ||
    pick(input, 'prompt') ||
    Object.values(input).find((v): v is string => typeof v === 'string' && v.trim() !== '') ||
    ''

  return clip(text, 120)
}
