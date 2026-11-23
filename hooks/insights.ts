import { atom, update } from 'claude-code'

import type { Report, ReportAction } from '../types'
import { env, parseJson, projectKey, q, run, terminalWindow, toolSpelling, wait } from './util'
import type { $T } from './util'

export const reportAtom = atom({ plugin: 'mcp-autoboot', key: 'report' } as const, null)
export const REPORT_PANE = 'autoboot-report'

export type Catalog = Record<string, { tools: string[] }>

// ================================================================ store shapes

type ServerUsage = { calls: number; last: number; sessionsOn: number }
type ProjectUsage = { sessions: number; servers: Record<string, ServerUsage> }
type Usage = Record<string, ProjectUsage>
export type Profiles = Record<string, { servers: string[]; note?: string }>

async function getObj<T>($: $T, key: string): Promise<T> {
  const v = await $.store.get(key)

  return (v !== null && typeof v === 'object' ? v : {}) as T
}

export function getProfiles($: $T) {
  return getObj<Profiles>($, 'profiles')
}

function getActive($: $T) {
  return getObj<Record<string, string>>($, 'activeProfile')
}

function getDisabled($: $T) {
  return getObj<Record<string, string[]>>($, 'disabled')
}

// ================================================================ report pane

export async function showReport($: $T, report: Report, open: boolean) {
  await update($, reportAtom, () => report)
  if (open) await $.ui.open({ id: REPORT_PANE, title: `MCP Autoboot · ${report.title}` }).catch(() => undefined)
}

// ================================================================ usage tracking

/** Counts one MCP tool call against the current project. Never throws. */
export async function countCall($: $T, toolName: string, seen: readonly string[]) {
  const match = /^mcp__(.+?)__/.exec(toolName)
  if (match === null || match[1] === 'mcp-autoboot') return
  const spelling = match[1] ?? ''
  const server = seen.find(s => toolSpelling(s) === spelling) ?? spelling
  const project = await projectKey($)
  const usage = await getObj<Usage>($, 'usage')
  const p = (usage[project] ??= { sessions: 0, servers: {} })
  const s = (p.servers[server] ??= { calls: 0, last: 0, sessionsOn: 0 })
  s.calls += 1
  s.last = await $.clock.now()
  await $.store.set('usage', usage)
}

/** At the end of a boot: one more session for the project, one more for each server that was on. */
export async function countSession($: $T, connected: readonly string[]) {
  const project = await projectKey($)
  const usage = await getObj<Usage>($, 'usage')
  const p = (usage[project] ??= { sessions: 0, servers: {} })
  p.sessions += 1
  for (const server of connected) (p.servers[server] ??= { calls: 0, last: 0, sessionsOn: 0 }).sessionsOn += 1
  await $.store.set('usage', usage)
}

async function projectUsage($: $T): Promise<ProjectUsage> {
  return (await getObj<Usage>($, 'usage'))[await projectKey($)] ?? { sessions: 0, servers: {} }
}

/** Servers on in 3+ sessions of this project that were never called. */
export async function unusedHere($: $T): Promise<{ server: string; sessionsOn: number }[]> {
  const p = await projectUsage($)

  return Object.entries(p.servers)
    .filter(([, u]) => u.sessionsOn >= 3 && u.calls === 0)
    .map(([server, u]) => ({ server, sessionsOn: u.sessionsOn }))
}

// ================================================================ token report

export type ServerTokens = { server: string; tools: number; schema: number; loaded: number; listing: number }

/**
 * Per server: its tools' full schemas (what they cost once loaded), what is in
 * the window now, and the name listing each request carries while deferred.
 */
export async function tokensByServer($: $T): Promise<ServerTokens[]> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const by = new Map<string, ServerTokens>()
  for (const t of usage.context.breakdown?.mcpTools ?? []) {
    const row = by.get(t.serverName) ?? { server: t.serverName, tools: 0, schema: 0, loaded: 0, listing: 0 }
    row.tools += 1
    row.schema += t.tokens
    if (t.isLoaded) row.loaded += t.tokens
    else row.listing += Math.ceil(t.name.length / 3)
    by.set(t.serverName, row)
  }

  return [...by.values()].sort((a, b) => b.schema - a.schema)
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export async function tokenReport($: $T, held: readonly string[], catalog: Catalog): Promise<Report> {
  const rows = await tokensByServer($)
  const p = await projectUsage($)
  const total = rows.reduce((a, r) => a + r.loaded + r.listing, 0)
  const full = rows.reduce((a, r) => a + r.schema, 0)
  const lines = [
    `**In context now: ≈${k(total)} tokens** from MCP tools (≈${k(full)} if every schema were loaded). Estimates.`,
    '',
    '| Server | Tools | In context now | All schemas | Calls here |',
    '|---|---:|---:|---:|---:|',
    ...rows.map(r => `| ${r.server} | ${r.tools} | ${k(r.loaded + r.listing)} | ${k(r.schema)} | ${p.servers[r.server]?.calls ?? 0} |`),
    ...held.map(s => `| ${s} *(held)* | ${catalog[s]?.tools.length ?? '?'} | 0 | – | ${p.servers[s]?.calls ?? 0} |`),
    '',
    '*In context now* is what every request carries: full schemas of loaded tools, and only names for tools still behind Tool Search. *All schemas* is the most a server can cost once Claude loads all its tools.',
  ]
  const actions: ReportAction[] = []
  const unused = await unusedHere($)
  if (unused.length > 0) {
    lines.push('', `**Unused in this project** (on in 3+ sessions, never called): ${unused.map(u => u.server).join(', ')}`)
    actions.push({ key: 'disable-unused', label: `Disable ${unused.length} unused here`, command: `disable ${unused.map(u => q(u.server)).join(' ')}` })
  }

  return { title: 'Token report', markdown: lines.join('\n'), isBusy: false, actions }
}

// ================================================================ sign-in

export async function getAuthPending($: $T): Promise<string[]> {
  const pending = await $.store.get('authPending')
  const ignore = await $.store.get('signinIgnore')
  const ignored = Array.isArray(ignore) ? ignore.map(String) : []

  return (Array.isArray(pending) ? pending.map(String) : []).filter(s => !ignored.includes(s))
}

export async function signinReport($: $T): Promise<Report> {
  const pending = await getAuthPending($)
  if (pending.length === 0) {
    return { title: 'Sign-in', markdown: 'Every server you use is signed in. ✔', isBusy: false, actions: [] }
  }
  const markdown = [
    `**${pending.length} server(s) are waiting for you to sign in:**`,
    '',
    ...pending.map(s => `- **${s}**: \`/autoboot signin ${q(s)}\``),
    '',
    'Signing in opens a terminal window that runs `claude mcp login` and then your browser. Once you\'ve signed in, run `/autoboot` (or start a new session).',
    'Don\'t use one of them? `/autoboot signin ignore <server>` stops the reminder, and `/autoboot disable <server>` keeps it off in this project.',
  ].join('\n')
  const actions: ReportAction[] = [
    { key: 'signin-all', label: `Sign in to all ${pending.length}`, command: 'signin all' },
    ...pending.map((s, i) => ({ key: `signin-${i}`, label: `Sign in: ${s}`, command: `signin ${q(s)}` })),
  ]

  return { title: 'Sign-in', markdown, isBusy: false, actions }
}

/** Opens one terminal window that signs in to each server in turn. */
export async function openSignin($: $T, servers: readonly string[]) {
  const list = servers.map(s => `'${s.replace(/'/g, "''")}'`).join(',')
  const script = env.isWindows
    ? `foreach ($s in @(${list})) { Write-Host "Signing in to $s" -ForegroundColor Cyan; claude mcp login $s }; Write-Host 'Done. Back in Claude Code, run /autoboot' -ForegroundColor Cyan`
    : `${servers.map(s => `claude mcp login '${s.replace(/'/g, `'\\''`)}'`).join('; ')}; echo 'Done. Back in Claude Code, run /autoboot'`

  return (await run($, terminalWindow(script))).exitCode === 0
}

// ================================================================ profiles & disabling

/** Why the engine should hold this server at start, or undefined to let it through. */
export async function holdReason($: $T, server: string): Promise<string | undefined> {
  const project = await projectKey($)
  if ((await getDisabled($))[project]?.includes(server)) return 'disabled for this project'
  const active = await getActive($)
  const name = active[project] ?? active['*']
  const profile = name === undefined ? undefined : (await getProfiles($))[name]
  if (profile && !profile.servers.includes(server)) return `not in profile "${name}"`

  return undefined
}

export async function activeProfileName($: $T): Promise<string | undefined> {
  const active = await getActive($)

  return active[await projectKey($)] ?? active['*']
}

export async function saveProfile($: $T, name: string, servers: string[], note?: string) {
  const profiles = await getProfiles($)
  profiles[name] = { servers, note }
  await $.store.set('profiles', profiles)
}

export async function deleteProfile($: $T, name: string) {
  const profiles = await getProfiles($)
  delete profiles[name]
  await $.store.set('profiles', profiles)
  const active = await getActive($)
  for (const [key, value] of Object.entries(active)) if (value === name) delete active[key]
  await $.store.set('activeProfile', active)
}

/** Sets (or clears, with undefined) the profile for this project, or for every project with `global`. */
export async function useProfile($: $T, name: string | undefined, global = false) {
  const active = await getActive($)
  const key = global ? '*' : await projectKey($)
  if (name === undefined) delete active[key]
  else active[key] = name
  await $.store.set('activeProfile', active)
}

export async function setDisabled($: $T, servers: readonly string[], isDisabled: boolean) {
  const all = await getDisabled($)
  const project = await projectKey($)
  const now = new Set(all[project] ?? [])
  for (const s of servers) {
    if (isDisabled) now.add(s)
    else now.delete(s)
  }
  all[project] = [...now]
  await $.store.set('disabled', all)

  return [...now]
}

export async function disabledHere($: $T) {
  return (await getDisabled($))[await projectKey($)] ?? []
}

export async function profilesReport($: $T): Promise<Report> {
  const profiles = await getProfiles($)
  const active = await activeProfileName($)
  const names = Object.keys(profiles)
  const markdown = [
    names.length === 0 ? '*No profiles yet.* `/autoboot suggest` proposes some for this project.' : '**Profiles** (★ = active here):',
    '',
    ...names.map(n => `- ${n === active ? '★ ' : ''}**${n}**: ${profiles[n]?.servers.join(', ')}${profiles[n]?.note ? ` — ${profiles[n]?.note}` : ''}`),
    '',
    'At session start, a profile only lets its own servers connect; the rest wait (`/autoboot on <server>` turns one on anyway).',
    'Commands: `profile use <name> [--global]` · `profile off` · `profile save <name> [servers…]` (no servers = the ones on now) · `profile delete <name>`',
  ].join('\n')
  const actions: ReportAction[] = names
    .filter(n => n !== active)
    .map((n, i) => ({ key: `use-${i}`, label: `Use ${n}`, command: `profile use ${q(n)}` }))
  if (active) actions.push({ key: 'off', label: 'Turn profile off', command: 'profile off' })

  return { title: 'Profiles', markdown, isBusy: false, actions }
}

// ================================================================ suggest

type RegistryHit = { name: string; title: string; description: string; url: string; install: string }

/** The `claude mcp add` line for a registry entry, from its remotes or packages. */
function installLine(server: any): string {
  const short = String(server.name ?? 'server').split('/').pop()?.replace(/[^A-Za-z0-9_-]/g, '-') ?? 'server'
  const remote = server.remotes?.[0]
  if (remote?.url) {
    const transport = remote.type === 'sse' ? 'sse' : 'http'
    const header = remote.headers?.find((h: any) => h.isRequired)
    return `claude mcp add --transport ${transport} ${short} ${remote.url}${header ? ` --header "${header.name}: <your value>"` : ''}`
  }
  const pkg = server.packages?.[0]
  if (pkg?.identifier) {
    if (pkg.registryType === 'npm') return `claude mcp add ${short} -- npx -y ${pkg.identifier}`
    if (pkg.registryType === 'pypi') return `claude mcp add ${short} -- uvx ${pkg.identifier}`
    if (pkg.registryType === 'oci') return `claude mcp add ${short} -- docker run -i --rm ${pkg.identifier}`
    return `see ${pkg.identifier}`
  }

  return ''
}

async function searchRegistry($: $T, keyword: string): Promise<RegistryHit[]> {
  try {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(keyword)}&limit=8`
    const res = await Promise.race([$.http.fetch(url), wait($, 8000).then(() => undefined)])
    if (!res?.ok) return []
    const body = JSON.parse(res.text) as { servers?: { server: any; _meta?: any }[] }

    return (body.servers ?? [])
      .filter(e => e._meta?.['io.modelcontextprotocol.registry/official']?.isLatest !== false)
      .map(({ server }) => ({
        name: String(server.name ?? ''),
        title: String(server.title ?? server.name ?? ''),
        description: String(server.description ?? '').slice(0, 220),
        url: String(server.websiteUrl ?? server.repository?.url ?? ''),
        install: installLine(server),
      }))
      .filter(h => h.install !== '')
  } catch {
    return []
  }
}

async function webSearch($: $T, query: string): Promise<string> {
  try {
    const result = await $.tool.call({ tool: 'WebSearch', query, mode: 'standard' } as never)
    const text = (result as { text?: string }).text

    return typeof text === 'string' ? text.slice(0, 5000) : ''
  } catch {
    return ''
  }
}

/** A short picture of the project: top-level files, README, manifests. */
async function projectSnapshot($: $T): Promise<string> {
  const cwd = await $.session.cwd()
  const parts = [`Folder: ${cwd}`]
  try {
    const entries = await $.fs.list(cwd)
    parts.push(`Top-level: ${entries.slice(0, 60).map(e => (e.kind === 'dir' ? `${e.name}/` : e.name)).join(', ')}`)
    for (const name of ['README.md', 'readme.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'CLAUDE.md']) {
      if (entries.some(e => e.name === name)) {
        const text = await $.fs.read(`${cwd}/${name}`, { length: 1500 }).catch(() => '')
        parts.push(`--- ${name} ---\n${text}`)
      }
    }
  } catch {
    // an unreadable folder still gets suggestions from the focus text
  }

  return parts.join('\n')
}

type Suggestion = {
  summary?: string
  add?: { name: string; why: string; install: string; url?: string }[]
  profiles?: { name: string; servers: string[]; why: string }[]
  groups?: { name: string; servers: string[]; flow: string }[]
  disable?: { server: string; why: string }[]
}

function busy($: $T, markdown: string) {
  return showReport($, { title: 'Suggestions', markdown, isBusy: true, actions: [] }, false)
}

/** Researches MCP servers for this project and fills the report pane. */
export async function suggest($: $T, focus: string, servers: readonly string[], catalog: Catalog) {
  await busy($, 'Looking at your project…')

  const snapshot = await projectSnapshot($)
  const tokens = await tokensByServer($).catch(() => [] as ServerTokens[])
  const usage = await projectUsage($)
  const unused = await unusedHere($)
  const inventory = servers
    .map(s => {
      const t = tokens.find(r => r.server === s)
      const u = usage.servers[s]

      return `- ${s}: tools [${(catalog[s]?.tools ?? []).slice(0, 12).join(', ')}]; ≈${t?.schema ?? '?'} schema tokens; calls in this project: ${u?.calls ?? 0} over ${u?.sessionsOn ?? 0} sessions`
    })
    .join('\n')

  // 1. What to look for.
  await busy($, 'Working out what this project needs…')
  const plan = await $.model.complete({
    model: 'haiku',
    maxTokens: 300,
    prompt:
      `${snapshot}\n\nUser focus: ${focus || '(none given)'}\n\n` +
      'Reply with ONLY JSON: {"projectType": "<3-6 words>", "keywords": ["<2-4 short search phrases for MCP servers that would help this project, e.g. github, postgres, figma>"]}',
  })
  const parsed = plan.isAnswered ? parseJson<{ projectType?: string; keywords?: string[] }>(plan.text) : undefined
  const projectType = parsed?.projectType ?? (focus || 'software project')
  const keywords = (parsed?.keywords ?? (focus ? [focus] : [])).slice(0, 4)

  // 2. Search the official MCP registry and the web.
  await busy($, `Searching the MCP registry and the web for: ${keywords.join(', ')}…`)
  const [hits, web] = await Promise.all([
    Promise.all(keywords.map(kw => searchRegistry($, kw))).then(all => {
      const seen = new Set<string>()

      return all.flat().filter(h => !seen.has(h.name) && seen.add(h.name)).slice(0, 30)
    }),
    webSearch($, `best MCP servers for ${projectType} ${keywords.join(' ')} Claude Code`),
  ])

  // 3. Put it together.
  await busy($, 'Putting the suggestions together…')
  const reply = await $.model.complete({
    model: 'sonnet',
    maxTokens: 2500,
    prompt: [
      `PROJECT\n${snapshot}\nType: ${projectType}\nUser focus: ${focus || '(none)'}`,
      `MCP SERVERS THE USER HAS (exact names)\n${inventory}`,
      `USAGE EVIDENCE: on in 3+ sessions here and never called: ${unused.map(u => u.server).join(', ') || '(none yet; tracking just started)'}`,
      `REGISTRY CANDIDATES (only recommend new servers from here; copy their install line exactly)\n${hits.map(h => `- ${h.title} (${h.name}): ${h.description} | install: ${h.install} | ${h.url}`).join('\n') || '(none found)'}`,
      `WEB RESULTS\n${web || '(none)'}`,
      'Reply with ONLY JSON:\n{"summary": "<2 sentences>",\n "add": [{"name","why","install","url"}] (0-5 new servers that clearly help THIS project; install copied from the candidates),\n "profiles": [{"name": "<one word>", "servers": [<existing exact names>], "why"}] (2-4 presets for kinds of work in this project),\n "groups": [{"name", "servers": [<existing or recommended>], "flow": "<how they work together, e.g. scrape -> summarize -> save to Docs>"}] (1-3),\n "disable": [{"server": "<existing exact name>", "why"}] (servers that look more useless than useful HERE: unrelated to the project or unused; say which reason)}',
    ].join('\n\n'),
  })
  const s = reply.isAnswered ? parseJson<Suggestion>(reply.text) : undefined
  if (s === undefined) {
    await showReport($, { title: 'Suggestions', markdown: `Could not put suggestions together (${reply.isAnswered ? 'unreadable reply' : reply.reason}). Try \`/autoboot suggest\` again.`, isBusy: false, actions: [] }, false)

    return
  }

  const known = new Set(servers)
  const profiles = (s.profiles ?? []).map(p => ({ ...p, servers: p.servers.filter(x => known.has(x)) })).filter(p => p.servers.length > 0)
  const disable = (s.disable ?? []).filter(d => known.has(d.server))
  // Measured schema tokens where the session has them; else ~250 per known tool.
  const saved = (srv: string) => tokens.find(t => t.server === srv)?.schema || (catalog[srv]?.tools.length ?? 0) * 250
  const savedNote = (srv: string) => (saved(srv) > 0 ? ` (≈${k(saved(srv))} tokens once its tools load)` : '')

  const md = [
    s.summary ?? '',
    '',
    '### New MCP servers for this project',
    ...((s.add ?? []).length === 0
      ? ['*Nothing new needed: what you have covers it.*']
      : (s.add ?? []).flatMap(a => [`- **${a.name}**: ${a.why}${a.url ? ` ([link](${a.url}))` : ''}`, `  \`${a.install}\``])),
    '',
    '### Profiles (presets)',
    ...profiles.map(p => `- **${p.name}**: ${p.servers.join(', ')} — ${p.why}`),
    '',
    '### Servers that work together',
    ...(s.groups ?? []).map(g => `- **${g.name}** (${g.servers.join(' → ')}): ${g.flow}`),
    '',
    '### Turn off for this project',
    ...(disable.length === 0
      ? ['*Nothing stands out.*']
      : disable.map(d => `- **${d.server}**: ${d.why}${savedNote(d.server)}`)),
    '',
    '*Installing a new server is your call: copy its line and run it in a terminal. Profiles and disabling only hold servers back, and you can undo them anytime.*',
  ].join('\n')

  const actions: ReportAction[] = [
    ...profiles.map((p, i) => ({ key: `save-${i}`, label: `Save profile ${p.name}`, command: `profile save ${q(p.name)} ${p.servers.map(q).join(' ')}` })),
    ...(disable.length > 0
      ? [{ key: 'disable', label: `Disable ${disable.length} here`, command: `disable ${disable.map(d => q(d.server)).join(' ')}` }]
      : []),
    ...(s.add ?? []).map((a, i) => ({ key: `copy-${i}`, label: `Copy install: ${a.name}`, copy: a.install })),
  ]
  await showReport($, { title: 'Suggestions', markdown: md, isBusy: false, actions }, false)
  $.ui.log(`mcp-autoboot: suggestions ready: ${(s.add ?? []).length} new, ${profiles.length} profiles, ${disable.length} to turn off. /autoboot report shows them.`)
}
