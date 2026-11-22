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

let cachedToken = null; // { token, expiresAt }

function configDir() {
  return (process.env.CLAUDE_CONFIG_DIR || '').split(',')[0].trim() || path.join(os.homedir(), '.claude');
}

function parseCredentials(text) {
  const j = JSON.parse(text);
  const o = j.claudeAiOauth || j;
  if (!o || !o.accessToken) throw new Error('No Claude login found in the stored credentials');
  return { token: o.accessToken, expiresAt: Number(o.expiresAt) || null };
}

function readKeychain() {
  return new Promise((resolve, reject) => {
    // waits for the user if macOS asks for Keychain permission
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 120000 }, (err, stdout) => {
      if (err) return reject(new Error('Could not read "Claude Code-credentials" from the Keychain (denied or not logged in)'));
      try { resolve(parseCredentials(stdout.trim())); } catch (e) { reject(e); }
    });
  });
}

async function getToken(force) {
  if (!force && cachedToken && (!cachedToken.expiresAt || cachedToken.expiresAt > Date.now() + 60000)) return cachedToken;
  const file = process.env.TASKBOARD_CREDENTIALS_FILE || path.join(configDir(), '.credentials.json');
  let creds = null;
  if (fs.existsSync(file)) creds = parseCredentials(fs.readFileSync(file, 'utf8'));
  else if (process.platform === 'darwin') creds = await readKeychain();
  else throw new Error(`No Claude Code credentials found (${file})`);
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    cachedToken = null;
    throw new Error('Claude Code login token expired; it refreshes the next time Claude Code runs');
  }
  cachedToken = creds;
  return creds;
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

/** Returns { five_hour, seven_day } in the board's format. */
async function fetchPlanLimits() {
  let creds = await getToken(false);
  let data;
  try {
    data = await request(USAGE_URL, creds.token);
  } catch (e) {
    if (!e.unauthorized) throw e;
    creds = await getToken(true); // token may have been refreshed by Claude Code
    data = await request(USAGE_URL, creds.token);
  }
  const out = { five_hour: mapWindow(data.five_hour), seven_day: mapWindow(data.seven_day) };
  if (!out.five_hour && !out.seven_day) throw new Error('Usage endpoint returned no 5h/weekly windows (API-key login?)');
  return out;
}

module.exports = { fetchPlanLimits };
