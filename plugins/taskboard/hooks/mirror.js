#!/usr/bin/env node
'use strict';
/**
 * PostToolUse hook: mirrors Claude's own task list (TodoWrite / TaskCreate /
 * TaskUpdate) onto the taskboard, so the board stays current without the agent
 * having to call the board tools. Never blocks or fails the tool call.
 * Disable with TASKBOARD_MIRROR=0.
 */
const path = require('path');

if (process.env.TASKBOARD_MIRROR === '0') process.exit(0);

const { detectProject } = require(path.join(__dirname, '..', 'server', 'lib', 'config'));
const { request } = require(path.join(__dirname, '..', 'server', 'lib', 'node'));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  main().catch(() => {}).finally(() => process.exit(0));
});
setTimeout(() => process.exit(0), 2500).unref();

function extractId(resp) {
  if (resp == null) return null;
  if (typeof resp === 'object') {
    const cand = resp.id ?? resp.taskId ?? (resp.task && (resp.task.id ?? resp.task.taskId));
    if (cand != null) return String(cand);
  }
  const s = typeof resp === 'string' ? resp : JSON.stringify(resp);
  const m = s.match(/#(\d+)/) || s.match(/"(?:id|taskId)"\s*:\s*"?([\w-]+)/);
  return m ? m[1] : null;
}

async function main() {
  const input = JSON.parse(raw || '{}');
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const session = String(input.session_id || 'session').slice(0, 8);
  const proj = detectProject(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const assignee = process.env.TASKBOARD_AGENT_NAME || `Claude ${session.slice(0, 4)}`;
  const base = { project: proj.path, projectName: proj.name, session, assignee };

  let op = null;
  let args = null;
  if (tool === 'TodoWrite' && Array.isArray(ti.todos)) {
    op = 'mirrorTodos'; args = { ...base, todos: ti.todos };
  } else if (tool === 'TaskCreate' && ti.subject) {
    op = 'mirrorTaskCreate';
    args = { ...base, subject: ti.subject, description: ti.description, extId: extractId(input.tool_response) };
  } else if (tool === 'TaskUpdate' && ti.taskId != null) {
    op = 'mirrorTaskUpdate';
    args = { ...base, extId: String(ti.taskId), status: ti.status, subject: ti.subject, description: ti.description, owner: ti.owner };
  }
  if (!op) return;
  await request('POST', '/api/op', { op, args }, 1500);
}
