#!/usr/bin/env node
'use strict';
/**
 * Keep-alive for the board after the last Claude session ended.
 *
 * Started detached by the leading MCP server when its session ends. It takes over the port,
 * serves the board and stores answers, and exits
 *   - after TASKBOARD_LINGER_MIN minutes without activity (default 30; activity = an answer,
 *     a click or an agent action, or loading the page — an open tab alone does not count),
 *   - after TASKBOARD_LINGER_MAX_MIN minutes in total (default 240), or
 *   - as soon as a Claude session starts and takes the board over.
 * No model is involved, so this costs no tokens.
 */
const { BoardNode } = require('./lib/node');

const IDLE_MS = Number(process.env.TASKBOARD_LINGER_MIN || 30) * 60000;
const MAX_MS = Number(process.env.TASKBOARD_LINGER_MAX_MIN || 240) * 60000;
const started = Date.now();
const node = new BoardNode({ keeper: true });

function log(...a) { process.stderr.write(`[taskboard keeper ${process.pid}] ${a.join(' ')}\n`); }

async function main() {
  // the old leader is closing the port right now: try for a few seconds
  for (let i = 0; i < 40 && node.role !== 'leader'; i++) {
    await node.elect();
    if (node.role === 'follower') { log('a session already serves the board; nothing to keep alive'); process.exit(0); }
    if (node.role !== 'leader') await new Promise((r) => setTimeout(r, 150));
  }
  if (node.role !== 'leader') { log('could not take the port'); process.exit(0); }
  log(`keeping the board alive (idle ${IDLE_MS / 60000} min, max ${MAX_MS / 60000} min)`);
  setInterval(() => {
    const now = Date.now();
    if (now - node.lastActivity > IDLE_MS || now - started > MAX_MS) {
      log(now - started > MAX_MS ? 'maximum lifetime reached' : 'idle timeout reached', '— stopping');
      node.shutdown();
      process.exit(0);
    }
  }, Math.min(15000, Math.max(1000, IDLE_MS / 3))).unref();
}

process.on('SIGTERM', () => { node.shutdown(); process.exit(0); });
process.on('SIGINT', () => { node.shutdown(); process.exit(0); });
main().catch((e) => { log('failed:', e.message); process.exit(1); });
