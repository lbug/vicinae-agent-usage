# Agent Usage for Vicinae

Rate limits and spend of the coding agents you actually use — Claude Code,
Codex and OpenRouter — in [Vicinae](https://vicinae.com). Inspired by the
Raycast extension [Agent Usage](https://www.raycast.com/thuggyduck/agent-usage),
cut down to three providers and adapted to Linux credential locations.

## Command

### Agent Usage

One row per account. Claude Code and Codex show a progress ring with the
limit that runs out first; OpenRouter shows today's spend. The detail panel
(open by default, `Ctrl+D`) lists every limit as a bar with its reset time,
plus spend, balance and extra usage.

The last result is cached: opening the view within a minute reuses it instead
of calling the APIs again, and when a fetch fails — Anthropic rate-limits its
usage endpoint quickly — the last good numbers stay visible, marked with the
time they are from.

| Action | Shortcut |
| --- | --- |
| Open Usage Dashboard | `Enter` |
| Refresh | `Ctrl+R` |
| Show / Hide Details | `Ctrl+D` |
| Copy Summary | |

## Sources

| Provider | Credentials | Endpoint | Shows |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/.credentials.json` (+ extra config dirs) | `api.anthropic.com/api/oauth/usage` | 5h session, weekly, model-specific weekly limits, extra usage |
| Codex | `$CODEX_HOME/auth.json` (default `~/.codex`) | `chatgpt.com/backend-api/wham/usage` | 5h and weekly limits, credits |
| OpenRouter | OpenCode's key from `~/.local/share/opencode/opencode.db`, else `OPENROUTER_API_KEY` | `/api/v1/key`, `/api/v1/credits`, `/api/v1/keys` | Spend today / this week / this month, key limit, credit balance |

OpenRouter counts days, weeks and months in **UTC** — "today" starts at
02:00 CEST / 01:00 CET.

Tokens are never refreshed by this extension: refreshing would rotate the
refresh token under a running Claude Code or Codex and log it out. An expired
login shows a hint instead; starting `claude` or `codex` once renews it.

## Preferences

- **Additional Claude config dirs** — comma-separated `CLAUDE_CONFIG_DIR`
  paths of further accounts, e.g. `~/.claude-work`. Each gets its own row.
- **OpenRouter API key** — overrides the key read from OpenCode.
- **OpenRouter management key** — optional; spend is then summed over all keys
  of the account instead of only OpenCode's key, and the detail panel breaks
  it down per key. It is only used to read `/api/v1/keys`.

## Development

```sh
npm install
npm run dev     # vici develop
npm run build   # installs into ~/.local/share/vicinae/extensions
npm test        # parser tests (node --test)
```
