import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RenderSurface } from 'claude-code'

import type { BootLine, BootLineState, BootMode, BootView, ReportAction } from '../types'
import {
  countCall, countSession, deleteProfile, disabledHere, getAuthPending, getProfiles, holdReason, openSignin,
  profilesReport, REPORT_PANE, saveProfile, setDisabled, showReport, signinReport, suggest,
  tokenReport, unusedHere, useProfile, activeProfileName,
} from './insights'
import { detachedStart, env, initEnv, q, readJson, run, splitArgs, toolSpelling, wait } from './util'
import type { $T } from './util'


const BLUE = 'blue'

const viewAtom = atom({ plugin: 'mcp-autoboot', key: 'view' } as const, null)
const heldAtom = atom({ plugin: 'mcp-autoboot', key: 'held' } as const, [])
const seenAtom = atom({ plugin: 'mcp-autoboot', key: 'seen' } as const, [])
const reportAtom = atom({ plugin: 'mcp-autoboot', key: 'report' } as const, null)

// ---------------------------------------------------------------- config

type Spec = {
  name: string
  kind: 'stdio' | 'http' | 'sse' | 'ws' | 'remote'
  command?: string
  args?: string[]
  url?: string
}

type Fix = 'docker' | 'local-http'
type Preflight = { isReady: boolean; fix?: Fix; note: string }

/** Per-server start commands for local servers, kept across sessions. */
type Recipes = Record<string, { start: string[] }>

/** What each server offers, learned from earlier sessions, for goal mode. */
type Catalog = Record<string, { tools: string[] }>

let specsPromise: Promise<Map<string, Spec>> | undefined
const queue = new Map<string, Preflight>()
let running: Promise<string> | undefined


/** Reads server definitions: type, command, args and URL only (never env or headers). */
async function loadSpecs($: $T): Promise<Map<string, Spec>> {
  const specs = new Map<string, Spec>()
  const cwd = await $.session.cwd()
  const add = (servers: any) => {
    if (servers === null || typeof servers !== 'object') return
    for (const [name, raw] of Object.entries<any>(servers)) {
      const url = typeof raw?.url === 'string' ? raw.url : undefined
      const kind = raw?.type ?? (url ? 'http' : 'stdio')
      specs.set(name, {
        name,
        kind: ['stdio', 'http', 'sse', 'ws'].includes(kind) ? kind : 'remote',
        command: typeof raw?.command === 'string' ? raw.command : undefined,
        args: Array.isArray(raw?.args) ? raw.args.map(String) : undefined,
        url,
      })
    }
  }
  const root = await readJson($, `${env.home}/.claude.json`)
  add(root?.mcpServers)
  const projects = root?.projects ?? {}
  add(projects[cwd]?.mcpServers)
  add(projects[cwd.replace(/\\/g, '/')]?.mcpServers)
  add((await readJson($, `${cwd}/.mcp.json`))?.mcpServers)

  return specs
}

function specsOf($: $T): Promise<Map<string, Spec>> {
  specsPromise ??= loadSpecs($)
  return specsPromise
}

// ---------------------------------------------------------------- probes



const isLocalUrl = (url?: string) =>
  url !== undefined && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)

const usesDocker = (spec: Spec) =>
  /(^|[\\/])docker(\.exe)?$/i.test(spec.command ?? '') ||
  (spec.args ?? []).some(a => /^docker(\.exe)?$/i.test(a))

async function dockerIsUp($: $T) {
  return (await run($, ['docker', 'info', '--format', '{{.ServerVersion}}'], 10000)).exitCode === 0
}

/** Any HTTP answer (even 401/404/405) means something listens on the port. */
async function httpIsUp($: $T, url: string) {
  // Probe the server's root: an MCP endpoint itself may hold a GET open as a stream.
  let root = url
  try {
    root = `${new URL(url).origin}/`
  } catch {
    // keep the URL as given
  }
  return (await httpProbe($, root)) === 'up'
}

/** 'up': any answer; 'down': refused; 'hung': connects but does not answer in 3 s. */
async function httpProbe($: $T, url: string): Promise<'up' | 'down' | 'hung'> {
  const probe = $.http.fetch(url, { method: 'GET' }).then(
    () => 'up' as const,
    () => 'down' as const,
  )
  const timeout = wait($, 3000).then(() => 'hung' as const)

  return Promise.race([probe, timeout])
}

async function commandExists($: $T, command: string) {
  if (/[\\/]/.test(command)) return $.fs.exists(command)

  return (await run($, [env.isWindows ? 'where' : 'which', command], 5000)).exitCode === 0
}

async function preflight($: $T, spec: Spec | undefined): Promise<Preflight> {
  if (spec === undefined) return { isReady: true, note: '' }
  if (spec.kind === 'stdio' && spec.command) {
    if (!(await commandExists($, spec.command))) {
      return { isReady: true, note: `command not found: ${spec.command}` }
    }
    if (usesDocker(spec) && !(await dockerIsUp($))) {
      return { isReady: false, fix: 'docker', note: 'Docker engine not running' }
    }
  }
  if (isLocalUrl(spec.url)) {
    const state = await httpProbe($, `${new URL(spec.url!).origin}/`)
    if (state === 'hung') {
      return { isReady: false, fix: 'local-http', note: `its local server accepts connections but does not answer (hung; restart it)` }
    }
    if (state === 'down') return { isReady: false, fix: 'local-http', note: `nothing running at ${spec.url}` }
  }

  return { isReady: true, note: '' }
}

// ---------------------------------------------------------------- view

async function setView($: $T, fn: (v: BootView | null) => BootView | null) {
  await update($, viewAtom, fn)
}

async function setLine($: $T, server: string, state: BootLineState, note = '') {
  await setView($, v => {
    if (v === null) return v
    const line: BootLine = { server, state, note }
    const lines = v.lines.some(l => l.server === server)
      ? v.lines.map(l => (l.server === server ? line : l))
      : [...v.lines, line]

    return { ...v, lines }
  })
}

async function startView($: $T, mode: BootMode, title: string) {
  await setView($, () => ({ phase: 'running', mode, title, lines: [], summary: '', isHidden: false }))
}

// ---------------------------------------------------------------- store

async function getMode($: $T): Promise<BootMode> {
  const mode = await $.store.get('mode')

  return mode === 'manual' || mode === 'lean' ? mode : 'auto'
}

async function getList($: $T, key: string): Promise<string[]> {
  const value = await $.store.get(key)

  return Array.isArray(value) ? value.map(String) : []
}

async function getRecipes($: $T): Promise<Recipes> {
  return ((await $.store.get('recipes')) as Recipes | undefined) ?? {}
}

async function getCatalog($: $T): Promise<Catalog> {
  return ((await $.store.get('catalog')) as Catalog | undefined) ?? {}
}


/** Learns each connected server's tool names, so lean mode can match goals later. */
async function learnCatalog($: $T) {
  const seen = await read($, seenAtom)
  const bySpelling = new Map(seen.map(s => [toolSpelling(s), s] as const))
  const catalog = await getCatalog($)
  const fresh: Record<string, string[]> = {}
  for (const tool of await $.tool.list()) {
    const match = /^mcp__(.+?)__(.+)$/.exec(tool.name)
    if (!tool.mcp || match === null) continue
    const [, spelling = '', name = ''] = match
    const server = bySpelling.get(spelling) ?? spelling
    ;(fresh[server] ??= []).push(name)
  }
  for (const [server, tools] of Object.entries(fresh)) {
    catalog[server] = { tools: tools.slice(0, 40) }
  }
  await $.store.set('catalog', catalog)
}

// ---------------------------------------------------------------- repair

async function startDocker($: $T) {
  if (env.isWindows) {
    const programFiles = (await $.env.get('ProgramFiles')) ?? 'C:\\Program Files'
    const exe = `${programFiles}\\Docker\\Docker\\Docker Desktop.exe`
    if (!(await $.fs.exists(exe))) return false
    await run($, detachedStart([exe]))

    return true
  }
  const mac = await run($, ['open', '-a', 'Docker'])
  if (mac.exitCode === 0) return true

  return (await run($, ['systemctl', '--user', 'start', 'docker-desktop'])).exitCode === 0
}


const LATER = 'Still working (a server is starting up). The result will show in the blue banner and the transcript.'

/**
 * A hook has a 10 s budget and its own waits count against it, so long work
 * answers early and finishes in the background, logging its result.
 */
async function withinBudget($: $T, work: Promise<string>, ms = 8000): Promise<string> {
  const answer = await Promise.race([work, wait($, ms).then(() => LATER)])
  if (answer === LATER) void work.then(text => $.ui.log(`mcp-autoboot: ${text}`))

  return answer
}

async function pollUntil($: $T, check: () => Promise<boolean>, totalMs: number, stepMs: number) {
  for (let spent = 0; spent <= totalMs; spent += stepMs) {
    if (await check()) return true
    await wait($, stepMs)
  }

  return false
}

/** Fixes a held server's prerequisite, then dials it, retrying a few times. */
async function repairAndConnect($: $T, server: string, pf: Preflight) {
  const spec = (await specsOf($)).get(server)
  await setLine($, server, 'repairing', pf.note)

  if (pf.fix === 'docker') {
    if (!(await dockerIsUp($))) {
      const started = await startDocker($)
      await setLine($, server, 'repairing', started ? 'starting Docker Desktop…' : 'waiting for Docker…')
    }
    if (!(await pollUntil($, () => dockerIsUp($), 150_000, 3000))) {
      await setLine($, server, 'failed', 'Docker did not start in 150s; start it, then /autoboot')

      return
    }
  }

  if (pf.fix === 'local-http' && spec?.url) {
    const recipe = (await getRecipes($))[server]
    if (recipe) {
      await setLine($, server, 'repairing', `starting: ${recipe.start.join(' ')}`)
      await run($, detachedStart(recipe.start))
    } else {
      await setLine($, server, 'repairing', `waiting for ${spec.url}…`)
    }
    if (!(await pollUntil($, () => httpIsUp($, spec.url!), recipe ? 90_000 : 45_000, 2000))) {
      await setLine(
        $,
        server,
        'failed',
        recipe
          ? `${pf.note}; its start command did not bring it up`
          : `${pf.note}; to let me start it: /autoboot start ${server} <command>`,
      )

      return
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await $.mcp.connect(server)
    if (result.isConnected) {
      await update($, heldAtom, held => held.filter(s => s !== server))
      await setLine($, server, 'repaired', pf.note ? `fixed: ${pf.note}` : 'connected')

      return
    }
    await setLine($, server, 'repairing', `attempt ${attempt} failed: ${result.message}`)
    await wait($, 3000 * attempt)
  }
  await setLine($, server, 'failed', 'did not connect after 3 tries')
}

/** One plain-language diagnosis for a failure message. */
function diagnose(message: string): { state: BootLineState; note: string; isTransient: boolean; isTimeout: boolean } {
  if (/no url configured|not configured/i.test(message)) {
    return { state: 'held', note: 'not set up (a plugin server you have not configured)', isTransient: false, isTimeout: false }
  }
  if (/auth|sign.?in|login|401|403/i.test(message)) {
    return { state: 'auth', note: 'needs sign-in: /mcp → select it → Authenticate', isTransient: false, isTimeout: false }
  }
  if (/not found|404|ENOTFOUND|check the url/i.test(message)) {
    return { state: 'failed', note: 'config error: the URL is wrong or the service moved', isTransient: false, isTimeout: false }
  }
  if (/ENOENT|not recognized|command not found/i.test(message)) {
    return { state: 'failed', note: 'its command is not installed or not on PATH', isTransient: false, isTimeout: false }
  }
  const isTimeout = /timed out|timeout/i.test(message)

  return { state: 'failed', note: message.slice(0, 120), isTransient: true, isTimeout }
}

async function settingsPath() {
  return `${env.home}/.claude/settings.json`
}

/** Raises MCP_TIMEOUT in user settings (read by the next session). True if changed. */
async function raiseMcpTimeout($: $T, ms: number) {
  const path = await settingsPath()
  const json = (await readJson($, path)) ?? {}
  json.env ??= {}
  if (Number(json.env.MCP_TIMEOUT ?? 0) >= ms) return false
  json.env.MCP_TIMEOUT = String(ms)
  await $.fs.write(path, `${JSON.stringify(json, null, 2)}\n`)

  return true
}

// ---------------------------------------------------------------- the boot

async function allServerNames($: $T) {
  const names = new Set<string>([...(await read($, seenAtom)), ...(await specsOf($)).keys()])

  return [...names]
}

/** Reads one server's state and repairs what can be repaired in this session. */
async function checkOne($: $T, server: string, mode: BootMode, held: Set<string>, flags: { timeoutRaised: boolean }) {
  if (held.has(server)) {
    await setLine($, server, 'held', mode === 'lean' ? 'off until a goal needs it' : 'held')

    return
  }
  await setLine($, server, 'checking')
  // $.mcp.connect on a server that is not held reads its state (waiting while it
  // is still connecting); it never redials one that failed.
  let result = await $.mcp.connect(server)
  if (result.isConnected) return setLine($, server, 'ok')
  if (result.reason === 'disabled') return setLine($, server, 'held', 'disabled in /mcp')
  if (result.reason === 'auth') return setLine($, server, 'auth', 'needs sign-in: /mcp → select it → Authenticate')

  const spec = (await specsOf($)).get(server)
  const d = diagnose(result.message)

  // Remote (http/sse) servers are redialed by any call on them.
  if (d.isTransient && spec?.kind !== 'stdio') {
    await setLine($, server, 'repairing', 'redialing…')
    await $.mcp.call(server, 'autoboot_ping').catch(() => undefined)
    result = await $.mcp.connect(server)
    if (result.isConnected) return setLine($, server, 'repaired', 'reconnected')
  }

  // A stdio server that timed out: Docker may be warming up, or it needs longer.
  if (d.isTimeout && spec?.kind === 'stdio') {
    flags.timeoutRaised = (await raiseMcpTimeout($, 90_000)) || flags.timeoutRaised
    const pf = await preflight($, spec)
    const why = pf.isReady ? 'slow to start' : pf.note

    return setLine($, server, 'failed', `${why}; reconnect now via /mcp (MCP_TIMEOUT is 90s from next session)`)
  }

  return setLine($, server, d.state, d.note)
}

/** Checks every server, repairs what it can, and reports in the blue banner. */
function boot($: $T, trigger: 'start' | 'command'): Promise<string> {
  // A check already under way is joined, not started twice.
  running ??= bootOnce($, trigger).finally(() => {
    running = undefined
  })

  return running
}

async function bootOnce($: $T, trigger: 'start' | 'command'): Promise<string> {
  {
    const mode = await getMode($)
    await startView($, mode, trigger === 'start' ? 'restarting MCP servers…' : 'checking MCP servers…')

    // 1. Servers held at start because a prerequisite was down: fix, then dial.
    //    Every other server is checked at the same time.
    const repairs = [...queue].map(([server, pf]) => repairAndConnect($, server, pf))
    const repairing = new Set(queue.keys())
    queue.clear()
    const held = new Set(await read($, heldAtom))
    const names = (await allServerNames($)).filter(s => !repairing.has(s))
    const flags = { timeoutRaised: false }
    await Promise.all([...repairs, ...names.map(server => checkOne($, server, mode, held, flags))])
    const timeoutRaised = flags.timeoutRaised

    // 3. Skills: every skill folder on disk should be a command now.
    const skillNote = await checkSkills($)

    await learnCatalog($).catch(() => undefined)

    const lines = (await read($, viewAtom))?.lines ?? []
    const count = (s: BootLineState) => lines.filter(l => l.state === s).length
    const profile = await activeProfileName($)

    // Sign-in reminder: remember who waits, and say so once a day.
    const waiting = lines.filter(l => l.state === 'auth').map(l => l.server)
    await $.store.set('authPending', waiting)
    const pending = await getAuthPending($)
    const today = new Date(await $.clock.now()).toDateString()
    if (pending.length > 0 && (await $.store.get('lastSigninReminder')) !== today) {
      await $.store.set('lastSigninReminder', today)
      $.ui.log(`mcp-autoboot: 🔑 ${pending.length} server(s) wait for sign-in (${pending.join(', ')}): /autoboot signin`)
    }

    // Usage: count this session, and point at servers this project never uses.
    if (trigger === 'start') {
      await countSession($, lines.filter(l => l.state === 'ok' || l.state === 'repaired').map(l => l.server))
      const unused = await unusedHere($)
      if (unused.length > 0) {
        $.ui.log(`mcp-autoboot: ${unused.length} server(s) are on in every session here but never used (${unused.map(u => u.server).join(', ')}). /autoboot tokens shows the cost; /autoboot suggest proposes what to turn off.`)
      }
    }

    const parts = [
      profile ? `profile ${profile}` : '',
      `${count('ok') + count('repaired')}/${lines.length} ready`,
      count('repaired') ? `${count('repaired')} repaired` : '',
      count('held') ? `${count('held')} held` : '',
      count('auth') ? `${count('auth')} need sign-in` : '',
      count('failed') ? `${count('failed')} failed` : '',
      skillNote,
      timeoutRaised ? 'MCP_TIMEOUT→90s' : '',
    ].filter(Boolean)
    const summary = parts.join(' · ')
    await setView($, v => v && { ...v, phase: 'done', title: 'MCP servers checked', summary })

    $.ui.log(`mcp-autoboot: ${summary}`, { to: 'debug' })
    const problems = lines.filter(l => l.state === 'failed' || l.state === 'auth')
    for (const l of problems) $.ui.log(`mcp-autoboot: ${l.server}: ${l.note}`)
    if (problems.length === 0) {
      $.clock.after(30_000, () => {
        void setView($, v => v && { ...v, isHidden: true })
      })
    }

    return [summary, ...lines.filter(l => l.state !== 'ok').map(l => `  ${icon(l.state)} ${l.server}: ${l.note}`)].join('\n')
  }
}

async function checkSkills($: $T): Promise<string> {
  try {
    const commands = new Set((await $.command.list()).map(c => c.name))
    const dir = `${env.home}/.claude/skills`
    if (!(await $.fs.exists(dir))) return ''
    const missing: string[] = []
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'dir') continue
      if (!(await $.fs.exists(`${dir}/${entry.name}/SKILL.md`))) continue
      if (![...commands].some(c => c === entry.name || c.endsWith(`:${entry.name}`))) missing.push(entry.name)
    }
    if (missing.length > 0) {
      $.ui.log(`mcp-autoboot: skills on disk but not loaded (check their SKILL.md frontmatter): ${missing.join(', ')}`)

      return `${missing.length} skill(s) not loaded`
    }

    return 'skills ok'
  } catch {
    return ''
  }
}

const icon = (s: BootLineState) =>
  ({ checking: '…', repairing: '⟳', ok: '✔', repaired: '✚', held: '⏸', auth: '🔑', failed: '✘' })[s]

// ---------------------------------------------------------------- goal mode

async function chooseServers($: $T, goal: string): Promise<string[]> {
  const names = await allServerNames($)
  const catalog = await getCatalog($)
  const listing = names
    .map(n => `- ${n}: ${(catalog[n]?.tools ?? []).slice(0, 20).join(', ') || '(tools unknown)'}`)
    .join('\n')
  const reply = await $.model.complete({
    model: 'haiku',
    prompt:
      `A user is about to do this task:\n"${goal}"\n\nThese MCP servers are available, each with its tools:\n${listing}\n\n` +
      'Reply with ONLY a JSON array of the exact server names the task needs (fewest that will do; [] if none).',
    maxTokens: 300,
  })
  if (reply.isAnswered) {
    const match = /\[[\s\S]*\]/.exec(reply.text)
    if (match) {
      try {
        const picked = (JSON.parse(match[0]) as unknown[]).map(String)

        return picked.filter(p => names.includes(p))
      } catch {
        // fall through to keywords
      }
    }
  }
  const words = goal.toLowerCase().split(/\W+/).filter(w => w.length >= 4)

  return names.filter(n => {
    const hay = `${n} ${(catalog[n]?.tools ?? []).join(' ')}`.toLowerCase()

    return words.some(w => hay.includes(w))
  })
}

async function enableServers($: $T, servers: string[]): Promise<string[]> {
  const out: string[] = []
  for (const server of servers) {
    const spec = (await specsOf($)).get(server)
    const pf = await preflight($, spec)
    if (!pf.isReady) {
      await startView($, await getMode($), `turning on ${server}…`)
      await repairAndConnect($, server, pf)
    }
    const result = await $.mcp.connect(server)
    if (result.isConnected) {
      await update($, heldAtom, held => held.filter(s => s !== server))
      out.push(`✔ ${server}`)
    } else {
      out.push(`✘ ${server}: ${result.message}`)
    }
  }

  return out
}

async function runGoal($: $T, goal: string) {
  const picked = await chooseServers($, goal)
  if (picked.length === 0) return 'No MCP server looks needed for that goal.'
  const results = await enableServers($, picked)

  return `For "${goal}" turned on:\n${results.join('\n')}`
}

// ---------------------------------------------------------------- register

const HELP = [
  'Checking',
  '  /autoboot                 check + repair + reconnect every MCP server now',
  '  /autoboot mode <auto|manual|lean>   when checks run (see README)',
  'Saving tokens',
  '  /autoboot tokens          what each server costs in tokens, and its use here',
  '  /autoboot goal <task>     turn on just the servers a task needs',
  '  /autoboot on <server…>    turn servers on now',
  '  /autoboot disable <server…> / enable <server…> / disabled   per project',
  '  /autoboot keep <server…>  servers lean mode always turns on',
  'Profiles (presets)',
  '  /autoboot profile                       list (and switch) profiles',
  '  /autoboot profile save <name> [server…] save one (no servers = those on now)',
  '  /autoboot profile use <name> [--global] use it here (or everywhere) from next start',
  '  /autoboot profile off | delete <name>',
  'Sign-in',
  '  /autoboot signin [all | <server…> | ignore <server…>]',
  'Ideas',
  '  /autoboot suggest [focus] new servers, profiles, groups and what to turn off',
  '  /autoboot report          reopen the last report',
  'Repair',
  '  /autoboot start <server> <command…>  how to start a local server that is down',
  '  /autoboot timeout <ms>    raise MCP_TIMEOUT for slow servers (next session)',
  'Names with spaces go in quotes: /autoboot on "claude.ai Gmail"',
].join('\n')

/** What a report button does: run `/autoboot <command>`, or copy text. */
async function act($: $T, a: ReportAction, surface: RenderSurface) {
  if (a.copy !== undefined) {
    await $.ui.copy({ text: a.copy, surface })
    $.ui.toast('Copied. Paste it into a terminal to install.')

    return
  }
  if (a.command !== undefined) await $.command.run({ command: 'autoboot', args: a.command })
}

async function connectedNow($: $T) {
  return ((await read($, viewAtom))?.lines ?? []).filter(l => l.state === 'ok' || l.state === 'repaired').map(l => l.server)
}

async function profileCommand($: $T, rest: string[]): Promise<string> {
  const [verb = 'list', name, ...servers] = rest
  const isGlobal = servers.includes('--global') || name === '--global'
  const clean = servers.filter(s => s !== '--global')
  switch (verb) {
    case 'list':
      await showReport($, await profilesReport($), true)
      return 'Profiles are in the pane.'
    case 'save': {
      if (!name) return 'Usage: /autoboot profile save <name> [server…]'
      const list = clean.length > 0 ? clean : await connectedNow($)
      await saveProfile($, name, list)
      return `Saved profile "${name}": ${list.join(', ')}.\nUse it with /autoboot profile use ${q(name)}`
    }
    case 'use': {
      const profile = name === undefined ? undefined : (await getProfiles($))[name]
      if (!name || !profile) return `No profile "${name ?? ''}". /autoboot profile lists them.`
      await useProfile($, name, isGlobal)
      const turnedOn = await withinBudget($, enableServers($, profile.servers).then(r => r.join('\n')), 6000)
      return `Profile "${name}" is active ${isGlobal ? 'everywhere' : 'in this project'}. From the next session start only its servers connect.\nTurned on now:\n${turnedOn}`
    }
    case 'off':
      await useProfile($, undefined, isGlobal)
      return `No profile ${isGlobal ? 'by default' : 'in this project'}: every server connects from the next start.`
    case 'delete':
      if (!name) return 'Usage: /autoboot profile delete <name>'
      await deleteProfile($, name)
      return `Deleted profile "${name}".`
    default:
      return HELP
  }
}

async function signinCommand($: $T, rest: string[]): Promise<string> {
  const [first, ...others] = rest
  if (first === undefined) {
    await showReport($, await signinReport($), true)
    return `${(await getAuthPending($)).length} server(s) need sign-in; see the pane.`
  }
  if (first === 'ignore') {
    const now = new Set([...(((await $.store.get('signinIgnore')) as string[] | undefined) ?? []), ...others])
    await $.store.set('signinIgnore', [...now])
    return `No more sign-in reminders for: ${others.join(', ')}`
  }
  const servers = first === 'all' ? await getAuthPending($) : rest
  if (servers.length === 0) return 'Nothing to sign in to.'
  const isOpened = await openSignin($, servers)
  return isOpened
    ? `Opened a terminal window to sign in to: ${servers.join(', ')}. When it says Done, run /autoboot.`
    : `Couldn't open a terminal. Run this yourself: claude mcp login ${q(servers[0] ?? '')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await initEnv($)

    await $.command.register({
      name: 'autoboot',
      description: 'MCP Autoboot: check + reconnect MCP servers · tokens · signin · profile · suggest · goal',
      argumentHint: '[tokens | signin | profile … | suggest [focus] | goal <task> | disable <server> | mode … | help]',
    })
    await $.tool.register({
      name: 'enable_mcp_for_goal',
      description:
        'Turns on the MCP servers a task needs when their tools are not available yet (lean mode, a profile or a ' +
        'per-project disable holds servers back, and a server may have failed at start). Give `goal` (what you are ' +
        'about to do) to let it pick, or `servers` (exact names). Then load the new tools with ToolSearch.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task, in a sentence.' },
          servers: { type: 'array', items: { type: 'string' }, description: 'Exact server names, as /mcp lists them.' },
        },
      },
    })

    await $.tool.register({
      name: 'mcp_suggestions',
      description:
        'Researches MCP servers for the current project (official MCP registry + web search) and proposes new servers ' +
        'to install, profiles (server presets), groups of servers that work together, and servers to turn off to save ' +
        'tokens. Use when the user asks which MCP servers/connectors would help, or how to trim them. It takes about a ' +
        'minute: call with `focus` to start (results also appear in a pane for the user), then call with `read: true` ' +
        'to get the finished report.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Optional: what the user wants help with.' },
          read: { type: 'boolean', description: 'true: return the latest report instead of starting a new one.' },
        },
      },
    })

    const mode = await getMode($)
    if (mode === 'manual') {
      await startView($, mode, 'manual mode: type /autoboot to check MCP servers')
      await setView($, v => v && { ...v, phase: 'done' })
      $.clock.after(20_000, () => void setView($, v => v && { ...v, isHidden: true }))
    } else {
      void boot($, 'start').catch(error => $.ui.log(`mcp-autoboot: boot failed: ${String(error)}`))
    }

    return started
  })

  // Every server the engine joins at start passes here first.
  on('mcp.connect', async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    await update($, seenAtom, seen => (seen.includes(e.server) ? seen : [...seen, e.server]))
    await initEnv($)
    // A plugin's own loopback server (this one's tools among them) is never held.
    if (e.server === 'mcp-autoboot' || e.server === e.provider.plugin) return next(e)

    const hold = async (why: string) => {
      await update($, heldAtom, held => (held.includes(e.server) ? held : [...held, e.server]))

      return { value: { isConnected: false as const, reason: 'disabled' as const, message: `held by mcp-autoboot: ${why}` } }
    }

    // Profiles and per-project disables save tokens in every mode.
    const reason = await holdReason($, e.server)
    if (reason !== undefined) return hold(reason)

    const mode = await getMode($)
    if (mode === 'manual') return next(e)
    if (mode === 'lean' && !(await getList($, 'alwaysOn')).includes(e.server)) return hold('lean mode')

    const pf = await preflight($, (await specsOf($)).get(e.server))
    if (!pf.isReady && pf.fix) {
      queue.set(e.server, pf)

      return hold(pf.note)
    }

    return next(e)
  })

  // Usage: which servers this project really calls.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith('mcp__')) {
      void read($, seenAtom)
        .then(seen => countCall($, tool, seen))
        .catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'autoboot' }, async ($, e) => {
    await initEnv($)
    const [sub = '', ...rest] = splitArgs(e.args)
    const arg = rest.join(' ')
    switch (sub.toLowerCase()) {
      case '':
      case 'run':
      case 'retry': {
        const held = await read($, heldAtom)
        if ((await getMode($)) !== 'lean') {
          for (const server of held) {
            if ((await holdReason($, server)) === undefined) queue.set(server, await preflight($, (await specsOf($)).get(server)))
          }
        }
        return { text: await withinBudget($, boot($, 'command')) }
      }
      case 'status':
        return { text: await withinBudget($, boot($, 'command')) }
      case 'tokens': {
        const report = await tokenReport($, await read($, heldAtom), await getCatalog($))
        await showReport($, report, true)
        return { text: report.markdown.split('\n')[0]?.replace(/\*\*/g, '') ?? 'Token report is in the pane.' }
      }
      case 'signin':
      case 'login':
        return { text: await signinCommand($, rest) }
      case 'profile':
      case 'profiles':
        return { text: await profileCommand($, rest) }
      case 'disable': {
        if (rest.length === 0) return { text: 'Usage: /autoboot disable <server…>' }
        const now = await setDisabled($, rest, true)
        return { text: `Off in this project from the next session start: ${rest.join(', ')}.\n(Disabled here: ${now.join(', ')}. Undo: /autoboot enable <server>.)` }
      }
      case 'enable': {
        if (rest.length === 0) return { text: 'Usage: /autoboot enable <server…>' }
        await setDisabled($, rest, false)
        const turnedOn = await withinBudget($, enableServers($, rest).then(r => r.join('\n')), 6000)
        return { text: `Enabled again in this project:\n${turnedOn}` }
      }
      case 'disabled':
        return { text: `Disabled in this project: ${(await disabledHere($)).join(', ') || '(none)'}` }
      case 'suggest': {
        await showReport($, { title: 'Suggestions', markdown: 'Starting…', isBusy: true, actions: [] }, true)
        void suggest($, arg, await allServerNames($), await getCatalog($)).catch(error =>
          showReport($, { title: 'Suggestions', markdown: `Failed: ${String(error)}`, isBusy: false, actions: [] }, false),
        )
        return { text: 'Researching MCP servers for this project (about a minute). Results appear in the pane.' }
      }
      case 'report': {
        const report = await read($, reportAtom)
        if (report === null) return { text: 'No report yet. Try /autoboot tokens or /autoboot suggest.' }
        await showReport($, report, true)
        return { text: `Showing: ${report.title}` }
      }
      case 'mode': {
        if (!['auto', 'manual', 'lean'].includes(arg)) return { text: `Mode is ${await getMode($)}.\n${HELP}` }
        await $.store.set('mode', arg)
        return { text: `Mode set to ${arg}; it applies from the next session start.` }
      }
      case 'goal':
        if (!arg) return { text: 'Usage: /autoboot goal <what you are about to do>' }
        return { text: await withinBudget($, runGoal($, arg)) }
      case 'on':
        if (rest.length === 0) return { text: 'Name at least one server.' }
        return { text: await withinBudget($, enableServers($, rest).then(r => r.join('\n'))) }
      case 'keep':
        await $.store.set('alwaysOn', rest)
        return { text: `Lean mode will always turn on: ${rest.join(', ') || '(none)'}` }
      case 'start': {
        const [server, ...command] = rest
        if (!server || command.length === 0) return { text: 'Usage: /autoboot start <server> <command…>' }
        await $.store.set('recipes', { ...(await getRecipes($)), [server]: { start: command } })
        return { text: `Saved: when ${server} is down at start, run \`${command.join(' ')}\` and wait for it.` }
      }
      case 'timeout': {
        const ms = Number(arg)
        if (!Number.isFinite(ms) || ms < 5000) return { text: 'Usage: /autoboot timeout <milliseconds, e.g. 90000>' }
        const changed = await raiseMcpTimeout($, ms)
        return { text: changed ? `MCP_TIMEOUT set to ${ms} ms in ~/.claude/settings.json (next session).` : 'MCP_TIMEOUT is already at least that.' }
      }
      default:
        return { text: HELP }
    }
  })

  on('tool.run', { tool: 'mcp__mcp-autoboot__enable_mcp_for_goal' }, async ($, e) => {
    await initEnv($)
    const input = e as unknown as { goal?: string; servers?: string[] }
    if (Array.isArray(input.servers) && input.servers.length > 0) {
      const work = enableServers($, input.servers.map(String)).then(r => r.join('\n'))
      return { result: await withinBudget($, work) }
    }
    if (typeof input.goal === 'string' && input.goal.trim()) {
      return { result: await withinBudget($, runGoal($, input.goal.trim())) }
    }
    return { result: 'Give a goal or a list of servers.' }
  })

  on('tool.run', { tool: 'mcp__mcp-autoboot__mcp_suggestions' }, async ($, e) => {
    await initEnv($)
    const input = e as unknown as { focus?: string; read?: boolean }
    if (input.read === true) {
      const report = await read($, reportAtom)
      if (report === null || report.title !== 'Suggestions') return { result: 'No suggestions yet: call without read to start.' }
      if (report.isBusy) return { result: `Still working: ${report.markdown}. Call again in ~20 s.` }
      return { result: report.markdown }
    }
    await showReport($, { title: 'Suggestions', markdown: 'Starting…', isBusy: true, actions: [] }, false)
    void suggest($, typeof input.focus === 'string' ? input.focus : '', await allServerNames($), await getCatalog($)).catch(error =>
      showReport($, { title: 'Suggestions', markdown: `Failed: ${String(error)}`, isBusy: false, actions: [] }, false),
    )
    return { result: 'Started. Call again with read: true in about a minute for the report (the user can also run /autoboot report).' }
  })

  // The blue banner above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, viewAtom)
    if (view === null || view.isHidden) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const lines = view.lines
    const ready = lines.filter(l => l.state === 'ok' || l.state === 'repaired').length
    const busy = lines.find(l => l.state === 'repairing')
    const needSignin = lines.filter(l => l.state === 'auth').length
    const text =
      view.phase === 'running'
        ? `⟳ MCP Autoboot (${view.mode}): ${view.title} ${lines.length ? `${ready}/${lines.length} ready` : ''}${busy ? ` · ${busy.server}: ${busy.note}` : ''}`
        : `● MCP Autoboot (${view.mode}): ${view.summary || view.title}`

    return (
      <Box>
        <Text color={BLUE} bold wrap="truncate-end">
          {text}{' '}
        </Text>
        {view.phase === 'done' && needSignin > 0 && (
          <Button key="signin" label={`Sign in (${needSignin})`} onPress={() => act($, { key: 'signin', label: '', command: 'signin' }, e.surface)} />
        )}
        <Button key="hide" label="Hide" onPress={() => update($, viewAtom, v => v && { ...v, isHidden: true })} />
      </Box>
    )
  })

  // The report pane: token report, sign-in list, profiles, suggestions.
  on('ui.render', { component: 'Pane', requestId: REPORT_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const report = await read($, reportAtom)
    if (report === null) return <Text dimColor>Nothing to show yet.</Text>

    return (
      <Box flexDirection="column">
        <Text color={BLUE} bold>
          {report.isBusy ? '⟳ ' : ''}
          {report.title}
        </Text>
        <Markdown text={report.markdown} />
        {report.actions.map(a => (
          <Button key={a.key} label={a.label} onPress={() => act($, a, e.surface)} />
        ))}
      </Box>
    )
  })
}
