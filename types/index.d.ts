/** auto: check + repair at start. manual: only when /autoboot runs. lean: hold servers until a goal needs them. */
export type BootMode = 'auto' | 'manual' | 'lean'

export type BootLineState =
  | 'checking'
  | 'repairing'
  | 'ok'
  | 'repaired'
  | 'held'
  | 'auth'
  | 'failed'

export type BootLine = { server: string; state: BootLineState; note: string }

export type BootView = {
  phase: 'running' | 'done'
  mode: BootMode
  title: string
  lines: BootLine[]
  summary: string
  isHidden: boolean
}

/** A button under a report: runs `/autoboot <command>`, or copies `copy`. */
export type ReportAction = { key: string; label: string; command?: string; copy?: string }

/** What the report pane shows: token report, sign-in list, profiles, suggestions. */
export type Report = { title: string; markdown: string; isBusy: boolean; actions: ReportAction[] }

declare module 'claude-code' {
  interface PluginState {
    'mcp-autoboot': {
      view: BootView | null
      /** Servers this mod is holding back (preflight not ready, lean mode, a profile, or disabled). */
      held: string[]
      /** Every server name the engine raised at start, as /mcp lists it. */
      seen: string[]
      report: Report | null
    }
  }
}
