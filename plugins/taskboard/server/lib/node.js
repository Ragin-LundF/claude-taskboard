'use strict';
/**
 * One BoardNode runs inside every Claude Code session (as part of the MCP server).
 * Exactly one node per machine wins the port and becomes the LEADER: it owns the
 * state, persists it and serves the web UI. All other nodes are FOLLOWERS and
 * forward operations to the leader. When the leader's session ends, the next
 * follower that notices takes over the port and reloads the state from disk.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PORT, HOST, HOME, BOARD_FILE, APP_ID } = require('./config');
const board = require('./board');
const a2ui = require('./a2ui');
const { UsageTracker } = require('./usage');
const { fetchPlanLimits } = require('./planlimits');
const API_POLL_MS = Number(process.env.TASKBOARD_LIMITS_POLL_MS || 150000);

const UI_FILE = path.join(__dirname, '..', '..', 'ui', 'index.html');
const VERSION = (() => { try { return require('../../.claude-plugin/plugin.json').version; } catch { return '0.0.0'; } })();

function newer(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

function log(...a) { process.stderr.write(`[taskboard ${process.pid}] ${a.join(' ')}\n`); }

function request(method, urlPath, body, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: HOST, port: PORT, method, path: urlPath, timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'x-taskboard': '1', ...(data ? { 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class BoardNode {
  constructor() {
    this.role = 'starting'; // leader | follower | conflict
    this.server = null;
    this.state = null;
    this.clients = new Set();
    this.saveTimer = null;
    this.watchTimer = null;
    this.conflict = null;
    this.usage = null;
    this.usageSummary = null;
    this.usageTimer = null;
  }

  get url() { return `http://localhost:${PORT}`; }

  async start() {
    await this.elect();
    this.watchTimer = setInterval(() => this.watch().catch(() => {}), 2000);
    this.watchTimer.unref();
  }

  async watch() {
    if (this.role === 'leader') return;
    const ok = await this.leaderAlive();
    if (!ok) await this.elect();
  }

  async leaderAlive() {
    try {
      const r = await request('GET', '/api/health', null, 1000);
      return r.status === 200 && r.json && r.json.app === APP_ID;
    } catch { return false; }
  }

  async leaderInfo() {
    try {
      const r = await request('GET', '/api/health', null, 1000);
      return r.status === 200 && r.json && r.json.app === APP_ID ? r.json : null;
    } catch { return null; }
  }

  async elect() {
    if (this.role === 'leader') return;
    let won = await this.tryListen();
    if (!won) {
      // a session with a newer plugin version takes the board over from an older leader
      const info = await this.leaderInfo();
      if (info && newer(VERSION, info.version)) {
        try {
          const r = await request('POST', '/api/handover', { version: VERSION }, 3000);
          if (r.status === 200) {
            log(`taking over the board from v${info.version || '?'} (pid ${info.pid})`);
            for (let i = 0; i < 20 && !won; i++) { await new Promise((res) => setTimeout(res, 150)); won = await this.tryListen(); }
          }
        } catch { /* old leaders don't support handover */ }
      }
    }
    if (won) { this.becomeLeader(); return; }
    if (await this.leaderAlive()) {
      if (this.role !== 'follower') log('following existing board at', this.url);
      this.role = 'follower';
      this.conflict = null;
    } else {
      this.role = 'conflict';
      this.conflict = `Port ${PORT} is used by another program. Set TASKBOARD_PORT to a free port.`;
    }
  }

  tryListen() {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => this.handle(req, res).catch((e) => {
        log('request error', e.stack || e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }));
      srv.once('error', () => resolve(false));
      srv.listen(PORT, HOST, () => { this.server = srv; resolve(true); });
    });
  }

  becomeLeader() {
    this.role = 'leader';
    this.conflict = null;
    this.state = this.load();
    log('leading board at', this.url);
    try { const { changed } = board.apply(this.state, 'cleanup', {}); if (changed) this.scheduleSave(); } catch (e) { log('cleanup failed', e.message); }
    this.updateAnswerMarker();
    this.updateApiPolling();
    if (process.env.TASKBOARD_USAGE !== '0') {
      this.usage = new UsageTracker();
      const tick = () => this.refreshUsage().catch((e) => log('usage scan failed', e.message));
      setImmediate(tick);
      this.usageTimer = setInterval(tick, 15000);
      this.usageTimer.unref();
    }
  }

  /** Poll the usage endpoint only while the selected source includes it. */
  updateApiPolling() {
    const source = (this.state.limitsConfig && this.state.limitsConfig.source) || 'statusline';
    const want = source === 'api' || source === 'both';
    if (want && !this.apiTimer) {
      const tick = () => this.pollApi();
      setImmediate(tick);
      this.apiTimer = setInterval(tick, API_POLL_MS);
      this.apiTimer.unref();
    } else if (!want && this.apiTimer) {
      clearInterval(this.apiTimer);
      this.apiTimer = null;
    }
  }

  async pollApi() {
    if (this.apiPolling || this.role !== 'leader') return;
    this.apiPolling = true;
    try {
      const r = await fetchPlanLimits();
      this.applyLocal('limitsApiResult', { ok: true, ...r, at: Date.now() });
    } catch (e) {
      this.applyLocal('limitsApiResult', { ok: false, error: e.message, at: Date.now() });
    } finally {
      this.apiPolling = false;
    }
  }

  async refreshUsage() {
    await this.usage.scan();
    this.usageSummary = this.usage.summary();
    const payload = `event: usage\ndata: ${JSON.stringify(this.usageSummary)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  load() {
    try {
      const raw = fs.readFileSync(BOARD_FILE, 'utf8');
      const s = JSON.parse(raw);
      if (s && s.tasks && s.projects) return s;
      throw new Error('invalid board file');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(BOARD_FILE, `${BOARD_FILE}.corrupt-${Date.now()}`); } catch { /* ignore */ }
        log('could not read board file, starting empty:', e.message);
      }
      return board.emptyState();
    }
  }

  saveNow() {
    if (this.role !== 'leader' || !this.state) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(HOME, { recursive: true });
    const tmp = `${BOARD_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, BOARD_FILE);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { try { this.saveNow(); } catch (e) { log('save failed', e.message); } }, 150);
  }

  broadcast() {
    const payload = `event: state\ndata: ${JSON.stringify(this.publicState())}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  publicState() {
    return { serverVersion: VERSION, rev: this.state.rev, projects: this.state.projects, tasks: Object.values(this.state.tasks), questions: Object.values(this.state.questions || {}).map((q) => ({ ...q, kind: a2ui.legacyKind(q), options: (q.options || []).map(board.normOption).filter(Boolean) })), limits: board.effectiveLimits(this.state), bridge: this.state.bridge || null,
      limitsSources: {
        source: (this.state.limitsConfig && this.state.limitsConfig.source) || 'statusline',
        statusline: ((this.state.limitsBySource || {}).statusline || this.state.limits || {}).updatedAt || null,
        api: ((this.state.limitsBySource || {}).api || {}).updatedAt || null,
        apiStatus: (this.state.limitsStatus || {}).api || null,
      } };
  }

  /** Process ids of askers with undelivered answers whose Claude process no longer exists. */
  deadAskerPids() {
    const pids = new Set(Object.values(this.state.questions || {}).filter((q) => q.status === 'answered' && !q.delivered && q.askerPid).map((q) => q.askerPid));
    return [...pids].filter((pid) => {
      try { process.kill(pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; }
    });
  }

  /** Marker file that exists only while answered questions wait for pickup; hooks test it before doing any work. */
  updateAnswerMarker() {
    if (!this.state) return;
    const marker = path.join(HOME, '.answers-ready');
    const waiting = Object.values(this.state.questions || {}).filter((q) => q.status === 'answered' && !q.delivered);
    try {
      if (waiting.length) {
        fs.mkdirSync(HOME, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify(waiting.map((q) => ({ id: q.id, pid: q.askerPid, project: q.project }))));
      } else if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch (e) { log('answer marker failed', e.message); }
  }

  applyLocal(op, args) {
    if (op === 'usage') return this.usageSummary || { hasData: false, pending: true };
    if (op === 'takeAnswers') args = { ...args, deadPids: this.deadAskerPids() };
    const { result, changed } = board.apply(this.state, op, args);
    if (changed) this.updateAnswerMarker();
    if (op === 'setLimitsSource') { clearInterval(this.apiTimer); this.apiTimer = null; this.updateApiPolling(); }
    if (changed) { this.scheduleSave(); this.broadcast(); }
    return result;
  }

  /** Run an operation: locally when leading, otherwise via the leader. */
  async op(op, args) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.role !== 'leader' && this.role !== 'follower') await this.elect();
      if (this.role === 'conflict') throw new Error(this.conflict);
      if (this.role === 'leader') return this.applyLocal(op, args);
      try {
        const r = await request('POST', '/api/op', { op, args });
        if (r.status === 200) return r.json.result;
        if (r.json && r.json.error) throw Object.assign(new Error(r.json.error), { fromLeader: true });
        throw new Error(`leader answered HTTP ${r.status}`);
      } catch (e) {
        if (e.fromLeader) throw e;
        // leader vanished between calls — run an election and retry
        this.role = 'starting';
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw new Error('Could not reach or become the board leader');
  }

  // ---------------------------------------------------------------- HTTP

  async handle(req, res) {
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden host'); }
    const url = new URL(req.url, this.url);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return this.json(res, 200, { app: APP_ID, pid: process.pid, rev: this.state.rev, version: VERSION });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(UI_FILE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return this.json(res, 200, this.publicState());
    if (req.method === 'GET' && url.pathname === '/api/usage') return this.json(res, 200, this.usageSummary || { hasData: false, pending: true });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 1000\nevent: state\ndata: ${JSON.stringify(this.publicState())}\n\n`);
      if (this.usageSummary) res.write(`event: usage\ndata: ${JSON.stringify(this.usageSummary)}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/api/handover') {
      if (req.headers['x-taskboard'] !== '1' || req.headers.origin) return this.json(res, 403, { error: 'forbidden' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!newer(body.version, VERSION)) return this.json(res, 409, { error: 'not newer' });
      this.json(res, 200, { ok: true });
      setImmediate(() => this.stepDown(body.version));
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/api/op') {
      // CSRF guard: custom header forces a CORS preflight we never answer; Origin must be our own.
      if (req.headers['x-taskboard'] !== '1') return this.json(res, 403, { error: 'missing x-taskboard header' });
      if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return this.json(res, 403, { error: 'bad origin' });
      const body = await readBody(req);
      try {
        const { op, args } = JSON.parse(body || '{}');
        return this.json(res, 200, { result: this.applyLocal(op, args) });
      } catch (e) {
        return this.json(res, 400, { error: e.message });
      }
    }
    res.writeHead(404);
    return res.end('not found');
  }

  json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  /** Give the port to a newer session; this node continues as a follower. */
  stepDown(byVersion) {
    if (this.role !== 'leader') return;
    log(`handing the board over to v${byVersion}`);
    try { this.saveNow(); } catch (e) { log('save before handover failed', e.message); }
    clearInterval(this.usageTimer); clearInterval(this.apiTimer); this.apiTimer = null;
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    this.clients.clear();
    try { this.server.close(); if (this.server.closeAllConnections) this.server.closeAllConnections(); } catch { /* ignore */ }
    this.server = null;
    this.state = null;
    this.role = 'starting'; // the watch loop / next op finds the new leader
  }

  shutdown() {
    clearInterval(this.watchTimer);
    clearInterval(this.usageTimer);
    clearInterval(this.apiTimer);
    if (this.role === 'leader') {
      try { this.saveNow(); } catch (e) { log('final save failed', e.message); }
      for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
      try { this.server.close(); } catch { /* ignore */ }
    }
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { BoardNode, request, VERSION };
