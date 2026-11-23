'use strict';
/**
 * Plan limits from Anthropic's usage endpoint (the numbers behind /usage in Claude Code).
 * Uses the OAuth token Claude Code already stores:
 *   macOS: Keychain item "Claude Code-credentials"; elsewhere: <config dir>/.credentials.json
 * The token is kept in memory only and sent only to the usage endpoint.
 * NOTE: the endpoint is not publicly documented and may change.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const USAGE_URL = process.env.TASKBOARD_USAGE_API_URL || 'https://api.anthropic.com/api/oauth/usage';

let cachedToken = null; // { token, expiresAt, source }

function configDirs() {
  const dirs = (process.env.CLAUDE_CONFIG_DIR || '').split(',').map((d) => d.trim()).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.claude'));
  return [...new Set(dirs)];
}

function parseCredentials(text, source) {
  const j = JSON.parse(text);
  const o = j.claudeAiOauth || j;
  if (!o || !o.accessToken) throw new Error('No Claude login found in the stored credentials');
  return { token: o.accessToken, expiresAt: Number(o.expiresAt) || null, source };
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Names of all Keychain items for Claude Code logins (attributes only, no secrets are read here). */
async function keychainServices() {
  const names = new Set(['Claude Code-credentials']);
  const dump = await run('security', ['dump-keychain'], 10000);
  if (dump) for (const m of dump.matchAll(/"svce"<blob>="(Claude Code-credentials[^"]*)"/g)) names.add(m[1]);
  return [...names];
}

/**
 * Stored Claude Code logins in the order they are tried, read lazily so macOS asks for as few
 * Keychain permissions as possible: the main Keychain item first, then credentials files
 * (newest first), then other "Claude Code-credentials-*" Keychain items.
 */
async function* credentialCandidates() {
  const mac = process.platform === 'darwin' && !process.env.TASKBOARD_CREDENTIALS_FILE;
  const readKeychain = async (svc) => {
    // waits for the user if macOS asks for Keychain permission
    const secret = await run('security', ['find-generic-password', '-s', svc, '-w'], 120000);
    if (!secret) return null;
    try { return parseCredentials(secret.trim(), `Keychain "${svc}"`); } catch { return null; }
  };
  if (mac) { const c = await readKeychain('Claude Code-credentials'); if (c) yield c; }
  const files = process.env.TASKBOARD_CREDENTIALS_FILE ? [process.env.TASKBOARD_CREDENTIALS_FILE] : configDirs().map((d) => path.join(d, '.credentials.json'));
  const fromFiles = [];
  for (const f of files) {
    try { if (fs.existsSync(f)) fromFiles.push(parseCredentials(fs.readFileSync(f, 'utf8'), f)); } catch { /* unreadable */ }
  }
  fromFiles.sort((a, b) => (b.expiresAt || Infinity) - (a.expiresAt || Infinity));
  yield* fromFiles;
  if (mac) {
    for (const svc of await keychainServices()) {
      if (svc === 'Claude Code-credentials') continue;
      const c = await readKeychain(svc);
      if (c) yield c;
    }
  }
}

function request(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !isLocal) return reject(new Error('Refusing non-HTTPS usage URL'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET', timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'claude-taskboard',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) return reject(Object.assign(new Error('Login rejected (401)'), { unauthorized: true }));
        if (res.statusCode !== 200) return reject(new Error(`Usage endpoint answered HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Usage endpoint returned invalid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Usage endpoint timed out')));
    req.on('error', reject);
    req.end();
  });
}

function mapWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  const t = w.resets_at ? (typeof w.resets_at === 'number' ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : Date.parse(w.resets_at)) : null;
  return { used: w.utilization, resetsAt: Number.isFinite(t) ? t : null };
}

/** Returns { five_hour, seven_day } in the board's format. Tries the stored logins newest first. */
async function fetchPlanLimits() {
  const tried = [];
  const attempt = async (c) => {
    try {
      const data = await request(USAGE_URL, c.token);
      cachedToken = c;
      return data;
    } catch (e) {
      if (!e.unauthorized) throw e;
      tried.push(c);
      return null;
    }
  };
  let data = cachedToken ? await attempt(cachedToken) : null;
  if (!data) {
    cachedToken = null;
    const seen = [];
    for await (const c of credentialCandidates()) {
      if (seen.some((t) => t.token === c.token)) continue;
      seen.push(c);
      if (tried.some((t) => t.token === c.token)) continue;
      data = await attempt(c);
      if (data) break;
    }
    if (!seen.length) throw new Error('No Claude Code login found (Keychain "Claude Code-credentials" or ~/.claude/.credentials.json)');
    if (!data) {
      const newest = [...seen].sort((a, b) => (b.expiresAt || Infinity) - (a.expiresAt || Infinity))[0];
      const exp = newest.expiresAt ? new Date(newest.expiresAt).toLocaleString() : 'unknown';
      throw new Error(`All ${seen.length} stored Claude Code login(s) were rejected; the newest (${newest.source}) expires ${exp}. Run /login in Claude Code if this persists.`);
    }
  }
  const out = { five_hour: mapWindow(data.five_hour), seven_day: mapWindow(data.seven_day) };
  if (!out.five_hour && !out.seven_day) throw new Error('Usage endpoint returned no 5h/weekly windows (API-key login?)');
  return out;
}

module.exports = { fetchPlanLimits };
