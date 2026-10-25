export type OverseerMeta = {
  project: string
  branch: string | null
  colorName: string
  hex: string
  short: string
}

declare module 'claude-code' {
  interface PluginState {
    overseer: { meta: Shaped<OverseerMeta | null> }
  }
}
