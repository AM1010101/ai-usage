#!/usr/bin/env node
// codex-usage CLI — manage and check usage for Codex / Claude / Gemini accounts.
// Zero dependencies, Node 18+.
//
// Usage:
//   ai-usage add <name> [--provider codex|claude|gemini] [--local]
//   ai-usage ls
//   ai-usage check [name...]      # default command (runs if no subcommand given)
//   ai-usage use <name>           # write token into ~/.codex/auth.json
//   ai-usage rm <name>
//   ai-usage refresh [name...]    # force-refresh tokens

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG_DIR = join(homedir(), ".codex-usage");
const ACCOUNTS_FILE = join(CONFIG_DIR, "accounts.json");

const CLAUDE_MESSAGES = "https://api.anthropic.com/v1/messages?beta=true";
const CLAUDE_PROFILE = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE = "https://chatgpt.com/backend-api/codex/usage";

const GEMINI_LOAD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ── Colors ──────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// ── Storage ─────────────────────────────────────────────────────────────────
// Account shape: { name, provider, credentials }
// credentials shape per provider:
//   claude:  { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier }
//   codex:   { auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }
//   gemini:  { access_token, refresh_token, client_id, client_secret, expiry_date }

async function loadAccounts() {
  try {
    return JSON.parse(await readFile(ACCOUNTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function saveAccounts(accounts) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2) + "\n");
}

// ── Token readers (full credential blobs) ───────────────────────────────────
async function readLocalClaudeCreds() {
  return new Promise((resolve, reject) => {
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], (err, stdout) => {
      if (err) return reject(new Error("Keychain entry not found (macOS only)"));
      try {
        const parsed = JSON.parse(stdout.trim());
        const creds = parsed?.claudeAiOauth;
        if (!creds?.accessToken) return reject(new Error("accessToken missing in keychain blob"));
        resolve(creds);
      } catch {
        reject(new Error("Failed to parse keychain blob"));
      }
    });
  });
}

async function readLocalCodexCreds() {
  const path = join(homedir(), ".codex", "auth.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.tokens?.access_token) throw new Error("access_token missing in ~/.codex/auth.json");
  return parsed;
}

async function readLocalGeminiCreds() {
  const path = join(homedir(), ".gemini", "oauth_creds.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.access_token) throw new Error("access_token missing in ~/.gemini/oauth_creds.json");
  return parsed;
}

async function readLocalCreds(provider) {
  if (provider === "claude") return readLocalClaudeCreds();
  if (provider === "codex") return readLocalCodexCreds();
  if (provider === "gemini") return readLocalGeminiCreds();
  throw new Error(`Unknown provider: ${provider}`);
}

// Helper: get the usable access token from a credentials blob
function getAccessToken(provider, credentials) {
  if (provider === "claude") return credentials.accessToken;
  if (provider === "codex") return credentials.tokens?.access_token;
  if (provider === "gemini") return credentials.access_token;
  return null;
}

// ── Token refresh ───────────────────────────────────────────────────────────
async function refreshClaude(credentials) {
  if (!credentials.refreshToken) throw new Error("No refresh token stored");
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "anthropic" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    ...credentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || credentials.refreshToken,
    expiresAt: data.expires_at || (data.expires_in ? Date.now() + data.expires_in * 1000 : credentials.expiresAt),
  };
}

async function refreshCodex(credentials) {
  const rt = credentials.tokens?.refresh_token;
  if (!rt) throw new Error("No refresh token stored");
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Codex refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    ...credentials,
    tokens: {
      ...credentials.tokens,
      access_token: data.access_token,
      id_token: data.id_token || credentials.tokens.id_token,
      refresh_token: data.refresh_token || rt,
    },
    last_refresh: new Date().toISOString(),
  };
}

async function refreshGemini(credentials) {
  const rt = credentials.refresh_token;
  const clientId = credentials.client_id;
  const clientSecret = credentials.client_secret;
  if (!rt || !clientId || !clientSecret) throw new Error("Missing refresh_token, client_id, or client_secret");
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    ...credentials,
    access_token: data.access_token,
    expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : credentials.expiry_date,
  };
}

function isExpired(provider, credentials) {
  const buffer = 60_000; // 1 minute buffer
  if (provider === "claude") {
    return credentials.expiresAt && Date.now() > credentials.expiresAt - buffer;
  }
  if (provider === "gemini") {
    return credentials.expiry_date && Date.now() > credentials.expiry_date - buffer;
  }
  // Codex: no expiry field in auth.json, rely on last_refresh age (~8 day staleness)
  if (provider === "codex" && credentials.last_refresh) {
    const age = Date.now() - new Date(credentials.last_refresh).getTime();
    return age > 7 * 24 * 60 * 60 * 1000; // refresh if older than 7 days
  }
  return false;
}

// Refresh a single account's credentials, returns updated credentials
async function refreshAccount(acc) {
  if (acc.provider === "claude") return refreshClaude(acc.credentials);
  if (acc.provider === "codex") return refreshCodex(acc.credentials);
  if (acc.provider === "gemini") return refreshGemini(acc.credentials);
  throw new Error(`Unknown provider: ${acc.provider}`);
}

// Ensure token is fresh before use. Mutates accounts array and saves.
async function ensureFresh(acc, accounts) {
  if (!isExpired(acc.provider, acc.credentials)) return;
  try {
    acc.credentials = await refreshAccount(acc);
    await saveAccounts(accounts);
    console.log(`${c.green}↻${c.reset} Refreshed token for ${c.bold}${acc.name}${c.reset}`);
  } catch (e) {
    console.error(`${c.yellow}⚠${c.reset} Refresh failed for ${acc.name}: ${e.message}`);
  }
}

// ── Prompt for input ────────────────────────────────────────────────────────
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── API calls ───────────────────────────────────────────────────────────────
async function checkClaude(token) {
  const [probe, profile] = await Promise.all([
    fetch(CLAUDE_MESSAGES, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-app": "cli",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      }),
    }),
    fetch(CLAUDE_PROFILE, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);

  if (!probe.ok) {
    const body = await probe.text();
    throw new Error(`${probe.status}: ${body.slice(0, 200)}`);
  }
  await probe.text(); // drain

  const h = (k) => probe.headers.get(k);
  const n = (k) => { const v = h(k); return v == null || v === "" ? null : Number(v); };

  const win = (util, reset, status) => {
    const u = n(util);
    if (u == null) return null;
    const r = n(reset);
    const now = Math.floor(Date.now() / 1000);
    return {
      used_percent: Math.round(u * 1000) / 10,
      reset_seconds: r ? Math.max(0, r - now) : null,
      status: h(status) || null,
    };
  };

  return {
    provider: "claude",
    email: profile?.account?.email || null,
    plan: profile?.organization?.organization_type
      || (profile?.account?.has_claude_max ? "max" : profile?.account?.has_claude_pro ? "pro" : null),
    primary: win(
      "anthropic-ratelimit-unified-5h-utilization",
      "anthropic-ratelimit-unified-5h-reset",
      "anthropic-ratelimit-unified-5h-status",
    ),
    secondary: win(
      "anthropic-ratelimit-unified-7d-utilization",
      "anthropic-ratelimit-unified-7d-reset",
      "anthropic-ratelimit-unified-7d-status",
    ),
    status: h("anthropic-ratelimit-unified-status") || "unknown",
  };
}

async function checkCodex(token) {
  const res = await fetch(CODEX_USAGE, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "codex-usage-cli/0.1",
      "OpenAI-Beta": "responses=experimental",
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data).slice(0, 200)}`);

  const pick = (...keys) => {
    for (const root of [data, data.rate_limit, data.rate_limits, data.usage]) {
      if (!root) continue;
      for (const k of keys) if (root[k]) return root[k];
    }
    return null;
  };

  const norm = (w) => {
    if (!w) return null;
    return {
      used_percent: w.used_percent ?? w.percent_used ?? null,
      reset_seconds: w.reset_after_seconds ?? w.resets_in_seconds ?? null,
      status: w.status || null,
    };
  };

  return {
    provider: "codex",
    email: data.email || null,
    plan: data.plan || data.account_plan || null,
    primary: norm(pick("primary_window", "primary", "short_term", "five_hour")),
    secondary: norm(pick("secondary_window", "secondary", "long_term", "weekly")),
    status: data.status || "ok",
  };
}

async function checkGemini(token) {
  const res = await fetch(GEMINI_LOAD, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data).slice(0, 200)}`);

  const tier = data.currentTier?.name || data.currentTier?.id || "—";
  const credits = Array.isArray(data.paidTier?.availableCredits) && data.paidTier.availableCredits.length
    ? data.paidTier.availableCredits.map((cr) => `${cr.creditAmount || "?"} ${cr.creditType || ""}`).join(", ")
    : null;

  return {
    provider: "gemini",
    email: null,
    plan: tier,
    primary: credits ? { used_percent: null, reset_seconds: null, status: credits } : null,
    secondary: null,
    status: "ok",
  };
}

async function checkAccount(acc) {
  const token = getAccessToken(acc.provider, acc.credentials);
  if (!token) throw new Error("No access token in stored credentials");
  if (acc.provider === "claude") return checkClaude(token);
  if (acc.provider === "codex") return checkCodex(token);
  if (acc.provider === "gemini") return checkGemini(token);
  throw new Error(`Unknown provider: ${acc.provider}`);
}

// ── Formatting ──────────────────────────────────────────────────────────────
function fmtPct(n) {
  if (n == null || isNaN(n)) return c.gray + "—" + c.reset;
  const s = n.toFixed(1) + "%";
  if (n >= 90) return c.red + s + c.reset;
  if (n >= 70) return c.yellow + s + c.reset;
  return c.green + s + c.reset;
}

function fmtReset(secs) {
  if (secs == null) return "";
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtWindow(w) {
  if (!w) return c.gray + "—" + c.reset;
  const pct = fmtPct(w.used_percent);
  const reset = w.reset_seconds ? c.gray + ` (${fmtReset(w.reset_seconds)})` + c.reset : "";
  return pct + reset;
}

function fmtStatus(s) {
  if (s === "allowed" || s === "ok") return c.green + s + c.reset;
  if (s === "rejected") return c.red + s + c.reset;
  return c.yellow + (s || "—") + c.reset;
}

function pad(str, len) {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, "");
  return str + " ".repeat(Math.max(0, len - visible.length));
}

function printTable(rows) {
  const cols = [
    { key: "name", label: "Name", width: 14 },
    { key: "provider", label: "Provider", width: 9 },
    { key: "plan", label: "Plan", width: 8 },
    { key: "primary", label: "5h Usage", width: 20 },
    { key: "secondary", label: "Weekly", width: 20 },
    { key: "status", label: "Status", width: 8 },
  ];

  for (const row of rows) {
    for (const col of cols) {
      const val = String(row[col.key] ?? "");
      const visible = val.replace(/\x1b\[[0-9;]*m/g, "");
      col.width = Math.max(col.width, visible.length + 2);
    }
  }

  const header = cols.map((col) => c.dim + pad(col.label, col.width) + c.reset).join("");
  console.log();
  console.log(header);
  console.log(c.dim + "─".repeat(cols.reduce((s, col) => s + col.width, 0)) + c.reset);

  for (const row of rows) {
    const line = cols.map((col) => pad(String(row[col.key] ?? ""), col.width)).join("");
    console.log(line);
  }
  console.log();
}

// ── Commands ────────────────────────────────────────────────────────────────
async function cmdAdd(args) {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ai-usage add <name> [--provider codex|claude|gemini] [--local]`);
    process.exit(1);
  }

  const providerIdx = args.indexOf("--provider");
  const provider = providerIdx !== -1 ? args[providerIdx + 1] : "codex";
  const local = args.includes("--local");

  if (!["codex", "claude", "gemini"].includes(provider)) {
    console.error(`Unknown provider: ${provider}. Use codex, claude, or gemini.`);
    process.exit(1);
  }

  let credentials;
  if (local) {
    try {
      credentials = await readLocalCreds(provider);
      console.log(`${c.green}✓${c.reset} Read local ${provider} credentials`);
    } catch (e) {
      console.error(`${c.red}✗${c.reset} Failed to read local ${provider} credentials: ${e.message}`);
      process.exit(1);
    }
  } else {
    const token = await prompt(`Paste ${provider} access token: `);
    if (!token) { console.error("No token provided."); process.exit(1); }
    // Store as minimal credentials — no refresh token available when pasting manually
    if (provider === "claude") {
      credentials = { accessToken: token };
    } else if (provider === "codex") {
      credentials = { tokens: { access_token: token } };
    } else {
      credentials = { access_token: token };
    }
    console.log(`${c.yellow}⚠${c.reset} Manual token — no refresh token. Use --local for full credentials.`);
  }

  const accounts = await loadAccounts();
  const existing = accounts.findIndex((a) => a.name === name);
  if (existing !== -1) {
    accounts[existing] = { name, provider, credentials };
    console.log(`${c.yellow}↻${c.reset} Updated ${c.bold}${name}${c.reset} (${provider})`);
  } else {
    accounts.push({ name, provider, credentials });
    console.log(`${c.green}+${c.reset} Added ${c.bold}${name}${c.reset} (${provider})`);
  }
  await saveAccounts(accounts);
}

async function cmdLs() {
  const accounts = await loadAccounts();
  if (!accounts.length) {
    console.log(`${c.gray}No accounts. Run: ai-usage add <name>${c.reset}`);
    return;
  }
  console.log();
  for (const acc of accounts) {
    const token = getAccessToken(acc.provider, acc.credentials) || "???";
    const masked = token.length > 16 ? token.slice(0, 12) + "…" + token.slice(-4) : token;
    const hasRefresh = acc.provider === "claude"
      ? !!acc.credentials.refreshToken
      : acc.provider === "codex"
        ? !!acc.credentials.tokens?.refresh_token
        : !!acc.credentials.refresh_token;
    const refreshIcon = hasRefresh ? c.green + "↻" + c.reset : c.gray + "—" + c.reset;
    console.log(`  ${c.bold}${acc.name}${c.reset}  ${c.cyan}${acc.provider}${c.reset}  ${c.gray}${masked}${c.reset}  ${refreshIcon}`);
  }
  console.log();
}

async function cmdCheck(names) {
  const accounts = await loadAccounts();
  if (!accounts.length) {
    console.log(`${c.gray}No accounts. Run: ai-usage add <name>${c.reset}`);
    return;
  }

  const targets = names.length
    ? accounts.filter((a) => names.includes(a.name))
    : accounts;

  if (!targets.length) {
    console.error(`No matching accounts found for: ${names.join(", ")}`);
    process.exit(1);
  }

  // Refresh expired tokens before checking
  for (const acc of targets) {
    await ensureFresh(acc, accounts);
  }

  console.log(`${c.dim}Checking ${targets.length} account(s)…${c.reset}`);

  const rows = await Promise.all(
    targets.map(async (acc) => {
      try {
        const result = await checkAccount(acc);
        return {
          name: c.bold + acc.name + c.reset,
          provider: c.cyan + result.provider + c.reset,
          plan: result.plan || "—",
          primary: fmtWindow(result.primary),
          secondary: fmtWindow(result.secondary),
          status: fmtStatus(result.status),
        };
      } catch (e) {
        return {
          name: c.bold + acc.name + c.reset,
          provider: c.cyan + acc.provider + c.reset,
          plan: "—",
          primary: c.red + "error" + c.reset,
          secondary: c.red + e.message.slice(0, 40) + c.reset,
          status: c.red + "✗" + c.reset,
        };
      }
    }),
  );

  printTable(rows);
}

async function cmdRefresh(names) {
  const accounts = await loadAccounts();
  const targets = names.length
    ? accounts.filter((a) => names.includes(a.name))
    : accounts;

  if (!targets.length) {
    console.error(names.length ? `No matching accounts: ${names.join(", ")}` : "No accounts stored.");
    process.exit(1);
  }

  for (const acc of targets) {
    try {
      acc.credentials = await refreshAccount(acc);
      console.log(`${c.green}↻${c.reset} Refreshed ${c.bold}${acc.name}${c.reset}`);
    } catch (e) {
      console.error(`${c.red}✗${c.reset} ${acc.name}: ${e.message}`);
    }
  }
  await saveAccounts(accounts);
}

async function cmdUse(args) {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ai-usage use <name>`);
    process.exit(1);
  }

  const accounts = await loadAccounts();
  const acc = accounts.find((a) => a.name === name);
  if (!acc) {
    console.error(`Account "${name}" not found. Run: ai-usage ls`);
    process.exit(1);
  }

  if (acc.provider !== "codex") {
    console.error(`"use" only works for codex accounts (switches ~/.codex/auth.json). "${name}" is ${acc.provider}.`);
    process.exit(1);
  }

  // Refresh first to avoid writing a stale token
  await ensureFresh(acc, accounts);

  const authPath = join(homedir(), ".codex", "auth.json");
  // Write the full credentials blob — it's the same shape as auth.json
  const output = { ...acc.credentials };
  await mkdir(join(homedir(), ".codex"), { recursive: true });
  await writeFile(authPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`${c.green}✓${c.reset} Switched codex to ${c.bold}${name}${c.reset} → ~/.codex/auth.json`);
}

async function cmdPark(args) {
  const provider = args[0];
  if (!provider || !["codex", "claude", "gemini"].includes(provider)) {
    console.error(`Usage: ai-usage park <codex|claude|gemini>`);
    process.exit(1);
  }

  if (provider === "codex") {
    const authPath = join(homedir(), ".codex", "auth.json");
    await mkdir(join(homedir(), ".codex"), { recursive: true });
    await writeFile(authPath, "{}\n");
    console.log(`${c.green}✓${c.reset} Parked codex — ~/.codex/auth.json is now empty.`);
  } else if (provider === "claude") {
    // Overwrite the keychain entry with an empty blob
    await new Promise((resolve, reject) => {
      // Delete then re-add with empty value
      execFile("security", ["delete-generic-password", "-s", "Claude Code-credentials"], () => {
        execFile("security", ["add-generic-password", "-s", "Claude Code-credentials", "-a", "", "-w", "{}"], (err) => {
          if (err) return reject(new Error(`Failed to park claude keychain: ${err.message}`));
          resolve();
        });
      });
    });
    console.log(`${c.green}✓${c.reset} Parked claude — keychain entry blanked.`);
  } else if (provider === "gemini") {
    const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
    await mkdir(join(homedir(), ".gemini"), { recursive: true });
    await writeFile(credsPath, "{}\n");
    console.log(`${c.green}✓${c.reset} Parked gemini — ~/.gemini/oauth_creds.json is now empty.`);
  }

  console.log(`${c.dim}  Run ai-usage use <name> to restore an account.${c.reset}`);
}

async function cmdRm(args) {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ai-usage rm <name>`);
    process.exit(1);
  }

  const accounts = await loadAccounts();
  const idx = accounts.findIndex((a) => a.name === name);
  if (idx === -1) {
    console.error(`Account "${name}" not found.`);
    process.exit(1);
  }

  accounts.splice(idx, 1);
  await saveAccounts(accounts);
  console.log(`${c.red}-${c.reset} Removed ${c.bold}${name}${c.reset}`);
}

function cmdHelp() {
  console.log(`
${c.bold}ai-usage${c.reset} — check rate-limit usage for Codex / Claude / Gemini accounts

${c.bold}Commands:${c.reset}
  add <name> [--provider codex|claude|gemini] [--local]
      Store credentials. --local reads full creds (with refresh token) from
      keychain/disk. Without --local, prompts for an access token only.

  ls
      List stored accounts. ${c.green}↻${c.reset} = has refresh token, ${c.gray}—${c.reset} = access token only.

  check [name...]
      Refresh expired tokens, then check usage. No args = check all.
      This is the default command — just running "ai-usage" does a check.

  refresh [name...]
      Force-refresh tokens for named (or all) accounts.

  use <name>
      Write a codex account's full credentials into ~/.codex/auth.json.
      Refreshes the token first to avoid writing stale creds.

  park <codex|claude|gemini>
      Blank out the provider's local credentials file so the CLI sees
      "not logged in" without revoking any tokens.

  rm <name>
      Remove a stored account.

${c.bold}Examples:${c.reset}
  ${c.dim}# Add Claude from macOS keychain (includes refresh token)${c.reset}
  ai-usage add work --provider claude --local

  ${c.dim}# Add Codex from ~/.codex/auth.json${c.reset}
  ai-usage add personal --provider codex --local

  ${c.dim}# Check all accounts${c.reset}
  ai-usage

  ${c.dim}# Force refresh all tokens${c.reset}
  ai-usage refresh

  ${c.dim}# Switch codex to "personal"${c.reset}
  ai-usage use personal
`);
}

// ── Main ────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "add":
    await cmdAdd(rest);
    break;
  case "ls":
  case "list":
    await cmdLs();
    break;
  case "check":
  case undefined:
    await cmdCheck(rest);
    break;
  case "refresh":
    await cmdRefresh(rest);
    break;
  case "use":
    await cmdUse(rest);
    break;
  case "park":
    await cmdPark(rest);
    break;
  case "rm":
  case "remove":
    await cmdRm(rest);
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}. Run: ai-usage help`);
    process.exit(1);
}
