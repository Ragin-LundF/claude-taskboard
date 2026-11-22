#!/usr/bin/env node
'use strict';
/**
 * Taskboard status line bridge (self-contained: copied to ~/.claude/taskboard/statusline.js
 * so the path in settings.json survives plugin updates).
 *
 * Claude Code pipes session JSON to the status line on every render. For Pro/Max
 * subscribers it contains rate_limits.five_hour / seven_day (used_percentage, resets_at).
 * This script forwards those numbers to the taskboard (throttled) and prints a status line:
 *   - with --wrap <base64 command>: runs your original status line command and prints its output
 *   - otherwise: prints a compact "5h 34% · 7d 12%" line
 * It never fails the status line: any error just skips forwarding.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.TASKBOARD_PORT || 4747);
const HOME = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.claude', 'taskboard');
const CACHE = path.join(HOME, '.limits-last.json');
const RESEND_MS = 60 * 1000;
const PING = path.join(HOME, '.bridge-ping.json');
const DEBUG = path.join(HOME, '.statusline-debug.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main().catch(() => {}).finally(() => process.exit(0)); });

function wrapped() {
  const i = process.argv.indexOf('--wrap');
  if (i < 0 || !process.argv[i + 1]) return null;
  try { return Buffer.from(process.argv[i + 1], 'base64').toString('utf8'); } catch { return null; }
}

function pickLimits(input) {
  const rl = input && input.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => (w && typeof w.used_percentage === 'number' ? {
    used: w.used_percentage,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null,
    ...(w.used_usd != null ? { usedUsd: w.used_usd } : {}),
    ...(w.limit_usd != null ? { limitUsd: w.limit_usd } : {}),
    ...(w.period ? { period: w.period } : {}),
  } : null);
  const out = { five_hour: win(rl.five_hour), seven_day: win(rl.seven_day), spend_limit: win(rl.spend_limit) };
  return out.five_hour || out.seven_day || out.spend_limit ? out : null;
}

function post(body, timeoutMs) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/op', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'x-taskboard': '1', 'content-length': data.length },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(data);
  });
}

async function forward(limits, sessionId) {
  const sig = JSON.stringify([limits.five_hour, limits.seven_day, limits.spend_limit]);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* first run */ }
  if (last && last.sig === sig && Date.now() - last.at < RESEND_MS) return;
  const ok = await post({ op: 'limits', args: { ...limits, sessionId, at: Date.now() } }, 400);
  if (ok) {
    try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify({ sig, at: Date.now() })); } catch { /* ignore */ }
  }
}

/** Tell the board the bridge runs even when Claude Code sends no rate_limits (throttled). */
async function ping(input) {
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(PING, 'utf8')).at; } catch { /* first */ }
  if (Date.now() - last < RESEND_MS) return;
  const ok = await post({ op: 'bridgePing', args: { at: Date.now(), hasRateLimits: false, version: input.version || null } }, 400);
  if (ok) { try { fs.writeFileSync(PING, JSON.stringify({ at: Date.now() })); } catch { /* ignore */ } }
}

function left(ms) {
  if (!ms) return '';
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

function ownLine(input, limits) {
  const parts = [];
  if (input.model && input.model.display_name) parts.push(input.model.display_name);
  if (limits && limits.five_hour) parts.push(`5h ${Math.round(limits.five_hour.used)}% (${left(limits.five_hour.resetsAt)})`);
  if (limits && limits.seven_day) parts.push(`7d ${Math.round(limits.seven_day.used)}% (${left(limits.seven_day.resetsAt)})`);
  if (limits && limits.spend_limit) parts.push(`spend ${Math.round(limits.spend_limit.used)}%`);
  if (input.context_window && typeof input.context_window.used_percentage === 'number') parts.push(`ctx ${Math.round(input.context_window.used_percentage)}%`);
  parts.push(`board :${PORT}`);
  return parts.join(' · ');
}

async function main() {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* keep empty */ }
  const limits = pickLimits(input);
  // diagnostics: which fields Claude Code sends (field names only, no values)
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(DEBUG, JSON.stringify({
      at: new Date().toISOString(), claudeCodeVersion: input.version || null, fields: Object.keys(input),
      rateLimits: input.rate_limits ? Object.keys(input.rate_limits) : null, forwarded: !!limits, port: PORT,
    }, null, 2));
  } catch { /* ignore */ }
  const sending = limits ? forward(limits, input.session_id).catch(() => {}) : ping(input).catch(() => {});

  const cmd = wrapped();
  if (cmd) {
    const r = spawnSync(cmd, { shell: true, input: raw, encoding: 'utf8', timeout: 5000, env: process.env });
    if (r.stdout) process.stdout.write(r.stdout);
  } else {
    process.stdout.write(`${ownLine(input, limits)}\n`);
  }
  await sending;
}
