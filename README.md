# mcp-autoboot

Makes MCP servers come up on their own when a Claude Code session starts, so you don't have to reconnect them by hand.

At session start a **blue banner** above the prompt shows `⟳ MCP Autoboot: restarting MCP servers…`, then a summary such as `● 14/22 ready · 1 repaired · 5 need sign-in · 2 failed`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mcp-autoboot --marketplace aibrewer/mcp-autoboot
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session). From a shell:

```
claude plugin install mcp-autoboot --marketplace aibrewer/mcp-autoboot
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins → Add marketplace** with `aibrewer/mcp-autoboot`, then **Add plugin**.

Then start a new session: the blue banner appears above the prompt. `/autoboot help` lists every command.

## What it does

1. **Checks before connecting.** Every server Claude Code is about to connect is checked first. If something it needs is down (Docker isn't running, or nothing answers on a local server's port), the server is held back instead of being allowed to fail and stay dead.
2. **Repairs, then connects.** Held servers get fixed and then connected: Docker Desktop is started and waited for, and a local server is started with the command you taught it (`/autoboot start …`) and waited for. Each connect is tried 3 times.
3. **Diagnoses the rest.** Remote servers that dropped are redialed. Every failure gets a plain-language cause: needs sign-in, wrong URL, command not installed, slow to start, or hung. A stdio server that timed out raises `MCP_TIMEOUT` to 90 s in `~/.claude/settings.json` for the next session.
4. **Checks skills.** Any skill folder in `~/.claude/skills` that didn't load is named, which usually means a bad `SKILL.md` frontmatter.

## Modes (`/autoboot mode …`)

| Mode | At session start |
| --- | --- |
| `auto` (default) | check, repair and reconnect everything |
| `manual` | nothing. Run `/autoboot` when you want a check |
| `lean` | hold every server except `/autoboot keep …` ones; turn on only what a task needs |

## Goal mode

`/autoboot goal <task>` asks Haiku which servers the task needs (from what each server's tools are), then turns on only those. Claude can do the same itself with the `enable_mcp_for_goal` tool when it notices that a tool it needs is missing. In `lean` mode this keeps unused servers from starting at all.

## Token report — `/autoboot tokens`

Opens a pane with a table, one row per server: its tool count, the tokens it adds to every request right now, what its full schemas would cost once loaded, and how often this project has called it. Every MCP tool call is counted per project, so servers that are on in 3 or more sessions but never called get flagged, with a one-click **Disable … here** button.

## Sign-in reminder — `/autoboot signin`

Servers waiting for sign-in show as a **Sign in (N)** button on the banner, plus one transcript reminder a day. Signing in opens a terminal window that runs `claude mcp login` for each one in turn. `signin ignore <server>` stops the reminder for a server you don't use.

## Profiles — `/autoboot profile`

Presets of servers. `profile save research ScraplingServer "claude.ai Google Docs"` saves one (leave the servers off to save whatever is on now). `profile use research` makes it this project's preset (add `--global` for every project). From the next start only its servers connect, which works in any mode. `profile off` clears it.

## Turn off per project — `/autoboot disable <server…>`

Holds servers back in this project only. `enable` undoes it, and `disabled` lists them.

## Suggestions — `/autoboot suggest [focus]`

Takes about a minute and opens a pane. It reads the project (files, README, manifests) and searches the **official MCP registry** and the **web**. Then it proposes:
- **new servers** for this project, each with its exact `claude mcp add …` line and a **Copy install** button (installing stays your call),
- **profiles** for the kinds of work in this project, with a **Save profile** button each,
- **groups** of servers that work together (for example scrape → summarize → save to Docs),
- **servers to turn off here**: unused, or unrelated to the project, with the tokens each one saves and a **Disable** button.

Claude can run the same research itself with the `mcp_suggestions` tool when you ask which MCP servers would help.

## Commands

```
/autoboot                      check + repair + reconnect now
/autoboot status               same
/autoboot mode auto|manual|lean
/autoboot goal <task>          turn on just what a task needs
/autoboot on <server…>         turn on named servers
/autoboot keep <server…>       servers lean mode always starts
/autoboot start <server> <cmd> how to start a local server that is down
/autoboot timeout <ms>         raise MCP_TIMEOUT (next session)
```

## Limits

Claude Code's plugin API can't redial a stdio server after it has failed in the current session. That's why this plugin checks before the first dial. If one fails anyway, reconnect it once with `/mcp`, and the raised timeout covers it from the next session on. Servers that need sign-in still need you to sign in through `/mcp`.
