import type { EngineInterface } from 'claude-code'

export type $T = EngineInterface

export const env = { isWindows: false, home: '' }

export async function initEnv($: $T) {
  if (env.home !== '') return
  env.isWindows = (await $.env.get('OS')) === 'Windows_NT'
  env.home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
}

export async function readJson($: $T, path: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

export async function run($: $T, argv: string[], timeoutMs = 8000) {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
}

export function wait($: $T, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, () => resolve())
  })
}

/** The project a usage record, profile or disable list belongs to. */
export async function projectKey($: $T): Promise<string> {
  return (await $.session.cwd()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The tool-name spelling of a server name: `claude.ai Gmail` -> `claude_ai_Gmail`. */
export const toolSpelling = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, '_')

/** Splits command arguments, keeping "double quoted" or 'single quoted' runs whole. */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')

  return out
}

/** Quotes a server name for a command line when it holds spaces. */
export const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s)

/** Launches a command that keeps running after this call returns. */
export function detachedStart(command: string[]): string[] {
  const [file = '', ...args] = command
  if (env.isWindows) {
    const pq = (s: string) => `'${s.replace(/'/g, "''")}'`
    const argList = args.length > 0 ? ` -ArgumentList ${args.map(pq).join(',')}` : ''

    return ['powershell', '-NoProfile', '-Command', `Start-Process -WindowStyle Hidden -FilePath ${pq(file)}${argList}`]
  }
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

  return ['sh', '-c', `nohup ${command.map(sq).join(' ')} >/dev/null 2>&1 &`]
}

/** Opens a visible terminal window running a PowerShell / shell script. */
export function terminalWindow(script: string): string[] {
  if (env.isWindows) {
    // -EncodedCommand takes UTF-16LE base64, so no quoting can break the script.
    let bin = ''
    for (let i = 0; i < script.length; i++) {
      const c = script.charCodeAt(i)
      bin += String.fromCharCode(c & 0xff, c >> 8)
    }
    const b64 = btoa(bin)

    return ['powershell', '-NoProfile', '-Command', `Start-Process powershell -ArgumentList '-NoExit','-EncodedCommand','${b64}'`]
  }
  const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  return ['osascript', '-e', `tell application "Terminal" to do script "${escaped}"`]
}

/** Pulls the first JSON object or array out of a model reply. */
export function parseJson<T>(text: string): T | undefined {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return undefined
  }
}
