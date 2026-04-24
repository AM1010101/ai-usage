# ai-usage

It's annoying to dig through three different CLIs to figure out which one still has headroom before you kick off a big task — and even more annoying when you have more than one account so you have to sign in and out to check the usage.

`ai-usage` is a tiny zero-dependency CLI that shows 5-hour and weekly usage for all your Codex, Claude, and Gemini accounts in one table, refreshes tokens automatically, and lets you swap which account is logged into with a single command.

## Example Output

Name                	Provider        	5h Usage    		Weekly              	Status

claude              	claude     	4.0% (4h 52m)       	27.0% (20h 2m)      allowed
codex-work      	codex      	0.0% (5h 0m)        	16.0% (6d 1h)       	ok
codex-personal  	codex           	0.0% (5h 0m)        	70.0% (4d 12h)      	ok

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

# Check usage across all accounts
ai-usage

# Switch ~/.codex/auth.json to a different account
ai-usage use personal
```

## Commands

| Command                                                   | Description                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add <name> [--provider codex\|claude\|gemini] [--local]` | Store credentials.`--local` reads full creds (with refresh token) from the provider's keychain/config file. Without `--local`, prompts for a pasted access token. |
| `ls`                                                    | List stored accounts.`↻` means a refresh token is present.                                                                                                         |
| `check [name...]`                                       | Refresh expired tokens, then print 5h / weekly usage. Default command.                                                                                                |
| `refresh [name...]`                                     | Force-refresh tokens.                                                                                                                                                 |
| `use <name>`                                            | Write a codex account's credentials into `~/.codex/auth.json`.                                                                                                      |
| `park <codex\|claude\|gemini>`                            | Blank the provider's local credentials file without revoking tokens.                                                                                                  |
| `rm <name>`                                             | Remove a stored account.                                                                                                                                              |

## Where credentials come from (`--local`)

- **Claude** — macOS keychain entry `Claude Code-credentials`
- **Codex** — `~/.codex/auth.json`
- **Gemini** — `~/.gemini/oauth_creds.json`

Accounts are stored in `~/.codex-usage/accounts.json`.
