'use strict';
/**
 * Token usage from Claude Code's local session transcripts
 * (~/.claude/projects/**\/*.jsonl). Files are read incrementally; only the
 * leader runs the scanner. Costs are API-list-price estimates — on a
 * subscription plan they show what the same usage would cost on the API.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOME, detectProject } = require('./config');

const RETAIN_MS = 35 * 24 * 3600 * 1000;
const BLOCK_MS = 5 * 3600 * 1000;
const ACTIVE_MS = 15 * 60 * 1000;

// USD per million tokens. cw = 5-minute cache write; 1-hour cache writes cost 2x input.
const DEFAULT_PRICES = [
  { match: 'opus-5-5', in: 4, out: 20, cr: 0.20, cw: 5 },
  { match: 'sonnet-5-5', in: 2, out: 10, cr: 0.10, cw: 2.5 },
  { match: 'haiku-5-5', in: 0.10, out: 0.50, cr: 0.01, cw: 0.125, longContext: { above: 100000, in: 0.50, out: 2.50, cr: 0.05, cw: 0.625 } },
  { match: 'fable', in: 8, out: 40, cr: 0.80, cw: 10 },
  { match: 'mythos', in: 8, out: 40, cr: 0.80, cw: 10 },
  { match: 'opus-5', in: 5, out: 25, cr: 0.50, cw: 6.25 },
  { match: 'sonnet-5', in: 2, out: 10, cr: 0.20, cw: 2.5 },
  { match: 'opus-4', in: 5, out: 25, cr: 0.50, cw: 6.25 },
  { match: 'sonnet-4', in: 3, out: 15, cr: 0.30, cw: 3.75 },
  { match: 'haiku-4', in: 1, out: 5, cr: 0.10, cw: 1.25 },
];

function loadPrices() {
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(HOME, 'pricing.json'), 'utf8'));
    if (Array.isArray(custom)) return [...custom, ...DEFAULT_PRICES];
  } catch { /* no override */ }
  return DEFAULT_PRICES;
}

function transcriptRoots() {
  const roots = [];
  if (process.env.TASKBOARD_TRANSCRIPTS) roots.push(...process.env.TASKBOARD_TRANSCRIPTS.split(path.delimiter));
  if (process.env.CLAUDE_CONFIG_DIR) for (const d of process.env.CLAUDE_CONFIG_DIR.split(',')) roots.push(path.join(d.trim(), 'projects'));
  roots.push(path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.config', 'claude', 'projects'));
  return [...new Set(roots)].filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class UsageTracker {
  constructor() {
    this.files = new Map(); // file -> { offset, rest }
    this.entries = [];
    this.seen = new Set();
    this.projectCache = new Map();
    this.prices = loadPrices();
    this.version = 0;
    this.unknownModels = new Set();
  }

  priceFor(model) {
    const m = String(model || '').toLowerCase();
    return this.prices.find((p) => m.includes(p.match)) || null;
  }

  cost(model, u) {
    let p = this.priceFor(model);
    if (!p) { this.unknownModels.add(model); return null; }
    const prompt = u.in + u.cw5 + u.cw1 + u.cr;
    if (p.longContext && prompt > p.longContext.above) p = { ...p, ...p.longContext };
    return (u.in * p.in + u.out * p.out + u.cr * p.cr + u.cw5 * p.cw + u.cw1 * p.in * 2) / 1e6;
  }

  project(cwd) {
    if (!cwd) return null;
    if (!this.projectCache.has(cwd)) this.projectCache.set(cwd, detectProject(cwd));
    return this.projectCache.get(cwd);
  }

  /** Scan for new transcript lines. Returns true when anything changed. Yields between files. */
  async scan(now = Date.now()) {
    if (this.scanning) return false;
    this.scanning = true;
    try { return await this.scanInner(now); } finally { this.scanning = false; }
  }

  async scanInner(now) {
    let changed = false;
    const cutoff = now - RETAIN_MS;
    for (const root of transcriptRoots()) {
      for (const file of walk(root)) {
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        const known = this.files.get(file) || { offset: 0 };
        if (st.size < known.offset) known.offset = 0;
        this.files.set(file, known);
        if (st.size === known.offset) continue;
        await new Promise((r) => setImmediate(r)); // keep the MCP server responsive on big histories
        // only consume complete lines, so a half-written line (or UTF-8 char) is read next time
        const buf = readRange(file, known.offset, st.size);
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl < 0) continue;
        known.offset += lastNl + 1;
        for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) if (this.ingest(line, cutoff)) changed = true;
      }
    }
    const before = this.entries.length;
    if (this.entries.length && this.entries[0].t < cutoff) this.entries = this.entries.filter((e) => e.t >= cutoff);
    if (this.entries.length !== before) changed = true;
    if (changed) { this.entries.sort((a, b) => a.t - b.t); this.version++; }
    return changed;
  }

  ingest(line, cutoff) {
    if (!line || line.indexOf('"usage"') < 0) return false;
    let j;
    try { j = JSON.parse(line); } catch { return false; }
    const msg = j.message;
    if (!msg || !msg.usage || j.type !== 'assistant') return false;
    if (!msg.model || msg.model === '<synthetic>') return false;
    const t = Date.parse(j.timestamp);
    if (!Number.isFinite(t) || t < cutoff) return false;
    const key = `${msg.id || ''}:${j.requestId || ''}`;
    if (key !== ':') { if (this.seen.has(key)) return false; this.seen.add(key); }
    const us = msg.usage;
    const cwTotal = us.cache_creation_input_tokens || 0;
    const cc = us.cache_creation || {};
    const cw1 = cc.ephemeral_1h_input_tokens || 0;
    const u = {
      in: us.input_tokens || 0,
      out: us.output_tokens || 0,
      cr: us.cache_read_input_tokens || 0,
      cw1,
      cw5: cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, cwTotal - cw1),
    };
    const proj = this.project(j.cwd);
    this.entries.push({
      t,
      session: j.sessionId || 'unknown',
      project: proj ? proj.path : null,
      projectName: proj ? proj.name : null,
      model: msg.model,
      tokens: u.in + u.out + u.cr + u.cw5 + u.cw1,
      out: u.out,
      context: u.in + u.cr + u.cw5 + u.cw1,
      cost: this.cost(msg.model, u),
    });
    return true;
  }

  summary(now = Date.now()) {
    const todayKey = localDay(now);
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const day7 = startOfToday.getTime() - 6 * 86400000;
    const day30 = startOfToday.getTime() - 29 * 86400000;
    const dayKeys = [];
    for (let i = 13; i >= 0; i--) dayKeys.push(localDay(startOfToday.getTime() - i * 86400000 + 12 * 3600000));

    const scopes = {};
    const scope = (k) => {
      if (!scopes[k]) scopes[k] = { today: zero(), last7: zero(), last30: zero(), days: Object.fromEntries(dayKeys.map((d) => [d, zero()])), models: {} };
      return scopes[k];
    };
    const sessions = {};
    for (const e of this.entries) {
      const keys = ['__all'];
      if (e.project) keys.push(e.project);
      const dk = localDay(e.t);
      for (const k of keys) {
        const s = scope(k);
        if (dk === todayKey) add(s.today, e);
        if (e.t >= day7) add(s.last7, e);
        if (e.t >= day30) { add(s.last30, e); add(s.models[e.model] = s.models[e.model] || zero(), e); }
        if (s.days[dk]) add(s.days[dk], e);
      }
      const ss = sessions[e.session] = sessions[e.session] || { id: e.session, project: e.project, projectName: e.projectName, cost: 0, tokens: 0, first: e.t };
      ss.last = e.t; ss.model = e.model; ss.context = e.context; ss.tokens += e.tokens; ss.cost += e.cost || 0;
    }

    // 5-hour blocks (account-wide): a block starts at the full hour of the first message after the previous block ended
    let block = null;
    for (const e of this.entries) {
      if (!block || e.t >= block.end) {
        const start = new Date(e.t); start.setMinutes(0, 0, 0);
        block = { start: start.getTime(), end: start.getTime() + BLOCK_MS, ...zero() };
      }
      add(block, e);
    }
    const currentBlock = block && now < block.end ? {
      ...block,
      burnPerHour: block.cost / Math.max(0.25, (now - block.start) / 3600000),
    } : null;

    for (const s of Object.values(scopes)) {
      s.days = dayKeys.map((d) => ({ day: d, ...s.days[d] }));
      s.models = Object.entries(s.models).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.cost - a.cost);
    }
    const active = Object.values(sessions).filter((s) => now - s.last < ACTIVE_MS).sort((a, b) => b.last - a.last);
    return {
      generatedAt: now,
      scopes,
      block: currentBlock,
      activeSessions: active,
      unknownModels: [...this.unknownModels],
      hasData: this.entries.length > 0,
    };
  }
}

function zero() { return { cost: 0, tokens: 0, out: 0, messages: 0 }; }
function add(acc, e) { acc.cost += e.cost || 0; acc.tokens += e.tokens; acc.out += e.out; acc.messages++; }

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p, depth + 1);
    else if (d.isFile() && d.name.endsWith('.jsonl')) yield p;
  }
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf;
  } finally { fs.closeSync(fd); }
}

module.exports = { UsageTracker };
