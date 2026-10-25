// Eight colours that stay apart on a dark terminal and in an iTerm2 tab.
// Red is left out on purpose: the overseer uses it for errors.

export type PaletteColor = { name: string; hex: string; rgb: [number, number, number] }

export const PALETTE: readonly PaletteColor[] = [
  { name: 'BLAU', hex: '#3B82F6', rgb: [59, 130, 246] },
  { name: 'ORANGE', hex: '#F97316', rgb: [249, 115, 22] },
  { name: 'GRÜN', hex: '#22C55E', rgb: [34, 197, 94] },
  { name: 'LILA', hex: '#A855F7', rgb: [168, 85, 247] },
  { name: 'GELB', hex: '#EAB308', rgb: [234, 179, 8] },
  { name: 'TÜRKIS', hex: '#14B8A6', rgb: [20, 184, 166] },
  { name: 'PINK', hex: '#EC4899', rgb: [236, 72, 153] },
  { name: 'BRAUN', hex: '#B45309', rgb: [180, 83, 9] },
]

/** FNV-1a, 32 bit: stable across runs, machines and engine versions. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function hashIndex(projectPath: string): number {
  return fnv1a(projectPath) % PALETTE.length
}

/**
 * The hash's colour, unless a project that is active right now already holds
 * it: then the next free one. With every colour taken the hash wins.
 */
export function pickIndex(projectPath: string, takenByOthers: ReadonlySet<number>): number {
  const start = hashIndex(projectPath)
  for (let step = 0; step < PALETTE.length; step++) {
    const index = (start + step) % PALETTE.length
    if (!takenByOthers.has(index)) return index
  }
  return start
}

/**
 * The window background, tinted with the project colour: a little of it mixed
 * into white on a light profile, into near-black on a dark one. iTerm2 says
 * which in COLORFGBG ("fg;bg", bg 7 or 15 is light).
 */
export function tint(rgb: readonly [number, number, number], colorFgBg: string | undefined): string {
  const last = colorFgBg?.split(';').at(-1)?.trim()
  const bg = last ? Number(last) : Number.NaN
  const isDark = Number.isInteger(bg) && bg !== 7 && bg !== 15
  const [base, share] = isDark ? [30, 0.18] : [255, 0.12]
  const hex = (channel: number) =>
    Math.round(base + (channel - base) * share)
      .toString(16)
      .padStart(2, '0')
  return `rgb:${hex(rgb[0])}/${hex(rgb[1])}/${hex(rgb[2])}`
}
