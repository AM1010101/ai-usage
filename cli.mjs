#!/usr/bin/env node
// codex-usage CLI — manage and check usage for Codex / Claude / Gemini / Antigravity / Kiro accounts.
// Zero dependencies, Node 18+.
//
// Usage:
//   ai-usage add <name> [--provider codex|claude|gemini|antigravity|kiro] [--local]
//   ai-usage ls
//   ai-usage check [name...]      # default command (runs if no subcommand given)
//   ai-usage use <name>           # write token into ~/.codex/auth.json
//   ai-usage rm <name>
//   ai-usage refresh [name...]    # force-refresh tokens

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
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
const GEMINI_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const ANTIGRAVITY_STATE_DB = join(homedir(), "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb");
const KIRO_LOGS_DIR = join(homedir(), "Library", "Application Support", "Kiro", "logs");

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
//   antigravity: { source: "local-state" }
//   kiro: { source: "local-logs" }

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

async function readLocalAntigravityCreds() {
  await readFile(ANTIGRAVITY_STATE_DB);
  return { source: "local-state" };
}

async function findFilesByName(root, target) {
  const out = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === target) out.push(fullPath);
    }
  }

  return out;
}

async function readLocalKiroCreds() {
  const files = await findFilesByName(KIRO_LOGS_DIR, "q-client.log");
  if (!files.length) throw new Error("No Kiro q-client.log found");
  return { source: "local-logs" };
}

async function readLocalCreds(provider) {
  if (provider === "claude") return readLocalClaudeCreds();
  if (provider === "codex") return readLocalCodexCreds();
  if (provider === "gemini") return readLocalGeminiCreds();
  if (provider === "antigravity") return readLocalAntigravityCreds();
  if (provider === "kiro") return readLocalKiroCreds();
  throw new Error(`Unknown provider: ${provider}`);
}

// Helper: get the usable access token from a credentials blob
function getAccessToken(provider, credentials) {
  if (provider === "claude") return credentials.accessToken;
  if (provider === "codex") return credentials.tokens?.access_token;
  if (provider === "gemini") return credentials.access_token;
  if (provider === "antigravity") return "local-state";
  if (provider === "kiro") return "local-logs";
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
  const clientId = credentials.client_id || GEMINI_CLIENT_ID;
  const clientSecret = credentials.client_secret || "";
  if (!rt || !clientId) throw new Error("Missing refresh_token or client_id");
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
    client_id: clientId,
    client_secret: credentials.client_secret,
    access_token: data.access_token,
    expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : credentials.expiry_date,
  };
}

function canRefresh(provider, credentials) {
  if (provider === "claude") return !!credentials.refreshToken;
  if (provider === "codex") return !!credentials.tokens?.refresh_token;
  if (provider === "gemini") return !!credentials.refresh_token && !!(credentials.client_secret || credentials.client_id);
  if (provider === "antigravity" || provider === "kiro") return false;
  return false;
}

async function readAntigravityPanelState() {
  const raw = await new Promise((resolve, reject) => {
    execFile("sqlite3", [ANTIGRAVITY_STATE_DB, "select value from ItemTable where key = 'n2ns.antigravity-panel';"], (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr?.trim() || err.message || "sqlite3 failed"));
      }
      resolve(stdout.trim());
    });
  });

  if (!raw) throw new Error("Antigravity panel state not found in globalStorage");

  const parsed = JSON.parse(raw);
  const snapshot = parsed["tfa.lastSnapshot"]?.data;
  const viewState = parsed["tfa.lastViewState"];
  if (!snapshot || !viewState) throw new Error("Antigravity quota snapshot missing");
  return { snapshot, viewState };
}

function isExpired(provider, credentials) {
  const buffer = 60_000; // 1 minute buffer
  if (provider === "claude") {
    return credentials.expiresAt && Date.now() > credentials.expiresAt - buffer;
  }
  if (provider === "gemini") {
    return canRefresh(provider, credentials) && credentials.expiry_date && Date.now() > credentials.expiry_date - buffer;
  }
  // Codex: no expiry field in auth.json, rely on last_refresh age (~8 day staleness)
  if (provider === "codex" && credentials.last_refresh) {
    const age = Date.now() - new Date(credentials.last_refresh).getTime();
    return age > 7 * 24 * 60 * 60 * 1000; // refresh if older than 7 days
  }
  if (provider === "antigravity" || provider === "kiro") return false;
  return false;
}

// Refresh a single account's credentials, returns updated credentials
async function refreshAccount(acc) {
  if (acc.provider === "claude") return refreshClaude(acc.credentials);
  if (acc.provider === "codex") return refreshCodex(acc.credentials);
  if (acc.provider === "gemini") return refreshGemini(acc.credentials);
  if (acc.provider === "antigravity" || acc.provider === "kiro") return acc.credentials;
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
    primary: { used_percent: null, reset_seconds: null, status: credits || tier || "ok" },
    secondary: null,
    status: "ok",
  };
}

async function checkAntigravity() {
  const { snapshot, viewState } = await readAntigravityPanelState();
  const groups = Array.isArray(viewState.groups) ? viewState.groups.filter((g) => g?.hasData) : [];
  const models = Array.isArray(snapshot.models) ? snapshot.models : [];
  const normalizeGroupName = (label, id) => {
    if (id === "gemini-pro") return "Gemini Pro";
    if (id === "gemini-flash") return "Gemini Flash";
    if (id === "claude" || id === "gpt") return "Other";
    return label || id || "Unknown";
  };
  const visibleGroups = groups.filter((group) => group.id !== "gpt");

  const results = visibleGroups.map((group) => {
    const matchingModels = models.filter((m) => m.remainingPercentage === group.remaining && m.timeUntilReset === group.resetTime);
    const model = matchingModels.find((m) => {
      const label = (m.label || "").toLowerCase();
      if (group.id === "gemini-pro") return label.includes("gemini") && label.includes("pro");
      if (group.id === "gemini-flash") return label.includes("gemini") && label.includes("flash");
      if (group.id === "claude") return label.includes("claude");
      if (group.id === "gpt") return label.includes("gpt");
      return true;
    }) || matchingModels[0] || null;

    return {
      table: "window",
      provider: "antigravity",
      email: snapshot.userInfo?.email || null,
      plan: snapshot.userInfo?.planName || snapshot.userInfo?.tier || null,
      primary: {
        used_percent: 100 - Number(group.remaining),
        reset_seconds: model?.resetTime ? Math.max(0, Math.round((new Date(model.resetTime).getTime() - Date.now()) / 1000)) : null,
        status: normalizeGroupName(group.label, group.id),
      },
      secondary: null,
      status: "ok",
      line_name: normalizeGroupName(group.label, group.id),
    };
  });

  return results.length ? results : [{
    table: "window",
    provider: "antigravity",
    email: snapshot.userInfo?.email || null,
    plan: snapshot.userInfo?.planName || snapshot.userInfo?.tier || null,
    primary: null,
    secondary: null,
    status: "ok",
    line_name: "Antigravity",
  }];
}

async function readLatestKiroUsage() {
  const files = await findFilesByName(KIRO_LOGS_DIR, "q-client.log");
  if (!files.length) throw new Error("No Kiro q-client.log found");

  const snapshots = [];
  for (const path of files) {
    try {
      const raw = await readFile(path, "utf8");
      const line = raw
        .split("\n")
        .filter((entry) => entry.includes('"commandName":"GetUsageLimitsCommand"'))
        .at(-1);
      if (!line) continue;

      const jsonStart = line.indexOf("{");
      if (jsonStart === -1) continue;
      const observedAtRaw = line.slice(0, jsonStart).trim().replace(" ", "T");
      const observedAt = Number.isNaN(Date.parse(observedAtRaw)) ? 0 : Date.parse(observedAtRaw);
      const parsed = JSON.parse(line.slice(jsonStart));
      const breakdown = parsed.output?.usageBreakdownList?.[0];
      if (!breakdown) continue;

      const resetAt = parsed.output?.nextDateReset || breakdown.nextDateReset || null;
      snapshots.push({
        parsed,
        breakdown,
        resetAt,
        observedAt,
      });
    } catch {}
  }

  snapshots.sort((a, b) => b.observedAt - a.observedAt);
  if (!snapshots.length) throw new Error("Kiro usage snapshot not found in q-client.log");
  return snapshots[0];
}

async function checkKiro() {
  const { parsed, breakdown, resetAt } = await readLatestKiroUsage();
  const used = Number(breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? null);
  const limit = Number(breakdown.usageLimitWithPrecision ?? breakdown.usageLimit ?? null);

  return {
    table: "monthly",
    provider: "kiro",
    email: null,
    plan: parsed.output?.subscriptionInfo?.subscriptionTitle || null,
    monthly: {
      used,
      limit,
      used_percent: Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? (used / limit) * 100 : null,
      unit: breakdown.displayNamePlural || breakdown.displayName || "Credits",
      reset_seconds: resetAt ? Math.max(0, Math.round((new Date(resetAt).getTime() - Date.now()) / 1000)) : null,
    },
    status: "ok",
  };
}

async function checkAccount(acc) {
  const token = getAccessToken(acc.provider, acc.credentials);
  if (acc.provider === "claude") return checkClaude(token);
  if (acc.provider === "codex") return checkCodex(token);
  if (acc.provider === "gemini") return checkGemini(token);
  if (acc.provider === "antigravity") return checkAntigravity();
  if (acc.provider === "kiro") return checkKiro();
  if (!token) throw new Error("No access token in stored credentials");
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
  if ((w.used_percent == null || isNaN(w.used_percent)) && w.status) {
    return c.gray + String(w.status) + c.reset;
  }
  const pct = fmtPct(w.used_percent);
  const reset = w.reset_seconds ? c.gray + ` (${fmtReset(w.reset_seconds)})` + c.reset : "";
  return pct + reset;
}

function fmtMonthly(m) {
  if (!m) return c.gray + "—" + c.reset;
  const pct = fmtPct(m.used_percent);
  if (!Number.isFinite(m.used) || !Number.isFinite(m.limit)) return pct;
  return `${pct}${c.gray} (${m.used.toFixed(2)}/${m.limit} ${m.unit || ""})${c.reset}`;
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

function printWindowTable(rows, opts = {}) {
  const cols = opts.verbose
    ? [
        { key: "name", label: "Name", width: 14 },
        { key: "provider", label: "Provider", width: 9 },
        { key: "plan", label: "Plan", width: 8 },
        { key: "primary", label: "5h Usage", width: 20 },
        { key: "secondary", label: "Weekly", width: 20 },
        { key: "status", label: "Status", width: 8 },
      ]
    : [
        { key: "name", label: "Name", width: 14 },
        { key: "primary", label: "5h Usage", width: 20 },
        { key: "secondary", label: "Weekly", width: 20 },
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

function printMonthlyTable(rows, opts = {}) {
  const cols = opts.verbose
    ? [
        { key: "name", label: "Name", width: 14 },
        { key: "provider", label: "Provider", width: 9 },
        { key: "plan", label: "Plan", width: 8 },
        { key: "monthly", label: "Monthly", width: 30 },
        { key: "reset", label: "Reset", width: 10 },
        { key: "status", label: "Status", width: 8 },
      ]
    : [
        { key: "name", label: "Name", width: 14 },
        { key: "monthly", label: "Monthly", width: 30 },
        { key: "reset", label: "Reset", width: 10 },
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
  console.log(c.bold + "Monthly Usage" + c.reset);
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
    console.error(`Usage: ai-usage add <name> [--provider codex|claude|gemini|antigravity|kiro] [--local]`);
    process.exit(1);
  }

  const providerIdx = args.indexOf("--provider");
  const provider = providerIdx !== -1 ? args[providerIdx + 1] : "codex";
  const local = args.includes("--local");

  if (!["codex", "claude", "gemini", "antigravity", "kiro"].includes(provider)) {
    console.error(`Unknown provider: ${provider}. Use codex, claude, gemini, antigravity, or kiro.`);
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
    if (provider === "antigravity" || provider === "kiro") {
      const label = provider[0].toUpperCase() + provider.slice(1);
      console.error(`${label} only supports --local because usage is read from the local IDE state.`);
      process.exit(1);
    }
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
    const hasRefresh = canRefresh(acc.provider, acc.credentials);
    const refreshIcon = hasRefresh ? c.green + "↻" + c.reset : c.gray + "—" + c.reset;
    console.log(`  ${c.bold}${acc.name}${c.reset}  ${c.cyan}${acc.provider}${c.reset}  ${c.gray}${masked}${c.reset}  ${refreshIcon}`);
  }
  console.log();
}

async function cmdCheck(args) {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const names = args.filter((arg) => arg !== "--verbose" && arg !== "-v");
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

  const rowGroups = await Promise.all(
    targets.map(async (acc) => {
      try {
        const result = await checkAccount(acc);
        const results = Array.isArray(result) ? result : [result];
        return results.map((item) => ({
          table: item.table || "window",
          name: c.bold + (item.line_name ? `${acc.name}/${item.line_name}` : acc.name) + c.reset,
          provider: c.cyan + item.provider + c.reset,
          plan: item.plan || "—",
          primary: fmtWindow(item.primary),
          secondary: fmtWindow(item.secondary),
          monthly: fmtMonthly(item.monthly),
          reset: item.monthly?.reset_seconds == null ? c.gray + "—" + c.reset : c.gray + fmtReset(item.monthly.reset_seconds) + c.reset,
          status: fmtStatus(item.status),
        }));
      } catch (e) {
        return [{
          table: acc.provider === "kiro" ? "monthly" : "window",
          name: c.bold + acc.name + c.reset,
          provider: c.cyan + acc.provider + c.reset,
          plan: "—",
          primary: c.red + "error" + c.reset,
          secondary: c.red + e.message.slice(0, 40) + c.reset,
          monthly: c.red + "error" + c.reset,
          reset: c.red + e.message.slice(0, 24) + c.reset,
          status: c.red + "✗" + c.reset,
        }];
      }
    }),
  );

  const rows = rowGroups.flat();
  const windowRows = rows.filter((row) => row.table === "window");
  const monthlyRows = rows.filter((row) => row.table === "monthly");

  if (windowRows.length) printWindowTable(windowRows, { verbose });
  if (monthlyRows.length) printMonthlyTable(monthlyRows, { verbose });
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
${c.bold}ai-usage${c.reset} — check rate-limit usage for Codex / Claude / Gemini / Antigravity / Kiro accounts

${c.bold}Commands:${c.reset}
  add <name> [--provider codex|claude|gemini|antigravity|kiro] [--local]
      Store credentials. --local reads full creds (with refresh token) from
      keychain/disk. Without --local, prompts for an access token only.
      Antigravity and Kiro are local-only and require --local.

  ls
      List stored accounts. ${c.green}↻${c.reset} = has refresh token, ${c.gray}—${c.reset} = access token only.

  check [name...] [--verbose|-v]
      Refresh expired tokens, then check usage. No args = check all.
      This is the default command — just running "ai-usage" does a check.
      --verbose / -v adds provider, plan, and status columns.

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

  ${c.dim}# Add Antigravity from Antigravity's local globalStorage${c.reset}
  ai-usage add ag --provider antigravity --local

  ${c.dim}# Add Kiro from Kiro's local q-client usage log${c.reset}
  ai-usage add kiro --provider kiro --local

  ${c.dim}# Check all accounts${c.reset}
  ai-usage

  ${c.dim}# Check all accounts with provider metadata${c.reset}
  ai-usage --verbose

  ${c.dim}# Short verbose flag${c.reset}
  ai-usage -v

  ${c.dim}# Force refresh all tokens${c.reset}
  ai-usage refresh

  ${c.dim}# Switch codex to "personal"${c.reset}
  ai-usage use personal
`);
}

// ── Main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const defaultCheckFlags = new Set(["--verbose", "-v"]);
const [cmd, ...rest] = argv;
const treatAsDefaultCheck = cmd == null || defaultCheckFlags.has(cmd);

switch (treatAsDefaultCheck ? undefined : cmd) {
  case "add":
    await cmdAdd(rest);
    break;
  case "ls":
  case "list":
    await cmdLs();
    break;
  case "check":
    await cmdCheck(rest);
    break;
  case undefined:
    await cmdCheck(argv);
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
