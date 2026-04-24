# ai-usage

It's annoying to dig through three different CLIs to figure out which one still has headroom before you kick off a big task — and even more annoying when you have more than one account so you have to sign in and out to check the usage.

`ai-usage` is a tiny zero-dependency CLI that shows usage for all your Codex, Claude, Gemini, Antigravity, and Kiro accounts, refreshes tokens automatically where possible, and lets you swap which account is logged into with a single command.

## Example Output

Default output is compact and focuses on usage columns. Use `--verbose` or `-v` to also show provider, plan, and status. Providers with monthly-style quotas, like Kiro, render in a second table below the 5h/weekly table.

Name                	5h Usage    		Weekly

claude              	4.0% (4h 52m)       	27.0% (20h 2m)
codex-work      	0.0% (5h 0m)        	16.0% (6d 1h)
codex-personal  	0.0% (5h 0m)        	70.0% (4d 12h)

## Install

```sh
npm install -g .
# or run directly
./cli.mjs
```

Requires Node 18+.

## Quick start

```sh
# Import credentials from local CLI installs (keeps refresh tokens)
ai-usage add work --provider claude --local
ai-usage add personal --provider codex --local
ai-usage add gcp --provider gemini --local
ai-usage add ag --provider antigravity --local
ai-usage add kiro --provider kiro --local

# Check usage across all accounts
ai-usage
ai-usage --verbose

# Switch ~/.codex/auth.json to a different account
ai-usage use personal
```

## Commands

| Command                                                   | Description                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add <name> [--provider codex\|claude\|gemini\|antigravity\|kiro] [--local]` | Store credentials. `--local` reads full creds from the provider's keychain/config file. Antigravity and Kiro are local-only and must use `--local`. Without `--local`, other providers prompt for a pasted access token. |
| `ls`                                                    | List stored accounts.`↻` means a refresh token is present.                                                                                                         |
| `check [name...] [--verbose\|-v]`                      | Refresh expired tokens, then print usage. Default output is compact; `--verbose` / `-v` adds provider, plan, and status columns.                                     |
| `refresh [name...]`                                     | Force-refresh tokens.                                                                                                                                                 |
| `use <name>`                                            | Write a codex account's credentials into `~/.codex/auth.json`.                                                                                                      |
| `park <codex\|claude\|gemini>`                            | Blank the provider's local credentials file without revoking tokens.                                                                                                  |
| `rm <name>`                                             | Remove a stored account.                                                                                                                                              |

## Where credentials come from (`--local`)

- **Claude** — macOS keychain entry `Claude Code-credentials`
- **Codex** — `~/.codex/auth.json`
- **Gemini** — `~/.gemini/oauth_creds.json`
- **Antigravity** — Antigravity panel snapshot in `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
- **Kiro** — latest `GetUsageLimitsCommand` snapshot from `~/Library/Application Support/Kiro/logs/.../q-client.log`

## Notes

- **Antigravity** — one stored account can expand into multiple rows (`Gemini Pro`, `Gemini Flash`, `Other`) because the local IDE exposes separate quota groups.
- **Kiro** — shows up in a separate monthly table because its local quota data is monthly credit-based rather than 5h/weekly windows.
- **Gemini** — local import works from `~/.gemini/oauth_creds.json`, but some installs do not expose enough OAuth metadata for durable auto-refresh. If the imported Gemini access token expires, re-auth with `gemini auth login` and re-run `ai-usage add <name> --provider gemini --local`.

Accounts are stored in `~/.codex-usage/accounts.json`.
