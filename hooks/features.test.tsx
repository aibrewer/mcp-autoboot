import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const cmd = (args: string) => ({ command: 'autoboot', args, origin: { kind: 'composer' }, presentation: {} }) as never

function world(on: On, store: Record<string, unknown> = {}) {
  mock.store(on, store)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\test' })
  mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/Proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'autoboot' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__mcp-autoboot__enable_mcp_for_goal' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('mcp.connect', (_, e) => ({ value: { isConnected: true as const, server: e.server } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200000,
        breakdown: {
          mcpTools: [
            { name: 'mcp__claude_ai_Gmail__send', serverName: 'claude.ai Gmail', tokens: 900, isLoaded: true },
            { name: 'mcp__claude_ai_Gmail__search', serverName: 'claude.ai Gmail', tokens: 700, isLoaded: false },
            { name: 'mcp__ScraplingServer__fetch', serverName: 'ScraplingServer', tokens: 400, isLoaded: false },
          ],
        },
      },
    },
  }) as never)
}

test('profiles save, list and activate per project', async ($, on) => {
  world(on, { mode: 'manual' })
  await $.session.start({ cwd: 'C:/Proj', surface: 'terminal', isInteractive: true })
  const saved = (await $.command.run(cmd('profile save research ScraplingServer "claude.ai Google Docs"'))).text ?? ''
  expect(saved).toContain('ScraplingServer, claude.ai Google Docs')
  const used = (await $.command.run(cmd('profile use research'))).text ?? ''
  expect(used).toContain('active in this project')
  await $.command.run(cmd('profile'))
  const pane = await $.ui.mount({ plugin: 'mcp-autoboot', surface: 'terminal', component: 'Pane', requestId: 'autoboot-report', props: {} as never } as never)
  const md = await pane.find({ type: 'Markdown' } as never)
  expect(String((md as { props?: { text?: string } } | undefined)?.props?.text)).toContain('★ **research**')
  await pane.unmount()
  expect((await $.command.run(cmd('profile off'))).text).toContain('every server connects')
})

test('disable and enable are per project and accept quoted names', async ($, on) => {
  world(on, { mode: 'manual' })
  await $.session.start({ cwd: 'C:/Proj', surface: 'terminal', isInteractive: true })
  await $.command.run(cmd('disable "claude.ai Indeed" freellmapi'))
  expect((await $.command.run(cmd('disabled'))).text).toBe('Disabled in this project: claude.ai Indeed, freellmapi')
  await $.command.run(cmd('enable freellmapi'))
  expect((await $.command.run(cmd('disabled'))).text).toBe('Disabled in this project: claude.ai Indeed')
})

test('sign-in list leaves out ignored servers', async ($, on) => {
  world(on, { mode: 'manual', authPending: ['claude.ai Atlassian MCP', 'plugin:data:hex'], signinIgnore: ['plugin:data:hex'] })
  await $.session.start({ cwd: 'C:/Proj', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(cmd('signin'))).text).toContain('1 server(s) need sign-in')
})

test('token report adds up loaded schemas and deferred names per server', async ($, on) => {
  world(on, { mode: 'manual' })
  await $.session.start({ cwd: 'C:/Proj', surface: 'terminal', isInteractive: true })
  const text = (await $.command.run(cmd('tokens'))).text ?? ''
  // Gmail: 900 loaded + ceil(28/3)=10 listed; Scrapling: ceil(27/3)=9 listed -> 919 in context; 2000 schemas in all.
  expect(text).toContain('≈919 tokens')
  expect(text).toContain('≈2.0k if every schema')
})
