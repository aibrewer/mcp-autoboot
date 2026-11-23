import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const cmd = (args: string) => ({ command: 'autoboot', args, origin: { kind: 'composer' }, presentation: {} }) as never

function world(on: On, store: Record<string, unknown> = {}) {
  mock.store(on, store)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\test' })
  mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'autoboot' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__mcp-autoboot__enable_mcp_for_goal' } }))
  on('mcp.connect', (_, e) =>
    e.server === 'good'
      ? { value: { isConnected: true as const, server: 'good' } }
      : { value: { isConnected: false as const, reason: 'auth' as const, message: 'needs auth' } },
  )
}

test('mode switches and persists in the store', async ($, on) => {
  world(on)
  expect((await $.command.run(cmd('mode lean'))).text).toContain('lean')
  expect((await $.command.run(cmd('mode'))).text).toContain('Mode is lean')
})

test('turning servers on reports each one', async ($, on) => {
  world(on, { mode: 'manual' })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const out = (await $.command.run(cmd('on good other'))).text ?? ''
  expect(out).toContain('✔ good')
  expect(out).toContain('✘ other: needs auth')
})

test('the start banner is blue and hides on press', async ($, on) => {
  world(on, { mode: 'manual' })
  await $.session.start({ cwd: 'C:/proj', surface: 'terminal', isInteractive: true })
  const props = {
    hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120,
    scroll: {}, view: {},
  } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mcp-autoboot', surface, component: 'AbovePrompt', props })
    const line = await ui.find({ type: 'Text', text: /MCP Autoboot/ })
    expect(line).toBeDefined()
    expect((line as { props?: { color?: string } } | undefined)?.props?.color).toBe('blue')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'mcp-autoboot', surface: 'terminal', component: 'AbovePrompt', props })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /MCP Autoboot/ })).toBeUndefined()
  await ui.unmount()
})
