#!/usr/bin/env node
'use strict';
/**
 * Stop / UserPromptSubmit / PostToolUse hook.
 *  PostToolUse runs after every tool call but is guarded in hooks.json by a file test, so this
 *  script only starts while answered questions are waiting (the leader keeps .answers-ready).
 *  1. Delivers answers the user gave on the taskboard to the session that asked (matched by the
 *     Claude Code process id, falling back to the project).
 *     - Stop: the agent continues with the answers instead of stopping.
 *     - UserPromptSubmit: answers are added as context to the user's next prompt.
 *  2. Question nudge (Stop only): if the turn ends with questions for the user, the project has
 *     open work on the board and none of them were pushed, the agent is sent back ONCE to push
 *     them with board_ask_many. Disable with TASKBOARD_QUESTION_NUDGE=0.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectProject } = require(path.join(__dirname, '..', 'server', 'lib', 'config'));
const { request } = require(path.join(__dirname, '..', 'server', 'lib', 'node'));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main().catch(() => {}).finally(() => process.exit(0)); });
setTimeout(() => process.exit(0), 4500).unref();

function ancestorPids() {
  const pids = [process.ppid];
  if (process.platform === 'win32') return pids;
  let cur = process.ppid;
  for (let i = 0; i < 5; i++) {
    try {
      const p = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8', timeout: 500 }).trim());
      if (!p || p <= 1) break;
      pids.push(p);
      cur = p;
    } catch { break; }
  }
  return pids;
}

async function op(name, args) {
  const r = await request('POST', '/api/op', { op: name, args }, 1500);
  return r.json && r.json.result;
}

// ------------------------------------------------------------------ transcript analysis

function readTail(file, bytes = 600000) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return (start ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
  } finally { fs.closeSync(fd); }
}

function isRealUserMessage(j) {
  if (j.type !== 'user' || j.isMeta || !j.message) return false;
  const c = j.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b && b.type === 'text') && !c.some((b) => b && b.type === 'tool_result');
}

/** Questions in the final assistant text of this turn, unless the turn already used the board's question tools. */
function unpushedQuestions(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const entries = [];
  for (const line of readTail(transcriptPath)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isRealUserMessage(entries[i])) { start = i + 1; break; }
  let lastText = '';
  for (const e of entries.slice(start)) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use' && /board_ask/.test(b.name || '')) return [];
      if (b.type === 'tool_use') lastText = ''; // only text written after the last tool call counts
      if (b.type === 'text' && b.text) lastText += `\n${b.text}`;
    }
  }
  const noCode = lastText.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, (m) => m.replace(/\?/g, ''));
  return noCode.split('\n')
    .map((l) => l.trim().replace(/^([-*>]|\d+[.)])\s+/, '').replace(/\*\*/g, ''))
    .filter((l) => l.length >= 12 && /\?\s*$/.test(l))
    .slice(0, 10);
}

// ------------------------------------------------------------------ main

async function main() {
  const input = JSON.parse(raw || '{}');
  const event = input.hook_event_name;
  const proj = detectProject(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());

  const res = await op('takeAnswers', { pids: ancestorPids(), project: proj.path });
  const answers = (res && res.answers) || [];
  if (answers.length) {
    const text = `The user answered on the taskboard:\n${answers.map((q) => `- ${q.id}${q.externalId ? ` [${q.externalId}]` : ''} "${q.question}" → ${q.answer}`).join('\n')}\nIf these questions come from a file, record the decisions there.`;
    if (event === 'Stop' || event === 'SubagentStop') {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: `${text}\nContinue the work using these answers.` }));
    } else if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `${text}\nTake these answers into account in your next steps.` } }));
    }
    return;
  }

  if (event !== 'Stop' || input.stop_hook_active || process.env.TASKBOARD_QUESTION_NUDGE === '0') return;
  const questions = unpushedQuestions(input.transcript_path);
  if (!questions.length) return;
  const active = await op('projectActive', { project: proj.path });
  if (!active || !active.active) return;
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `The taskboard is active for this project and your last message asks the user:\n${questions.map((q) => `- ${q}`).join('\n')}\n`
      + 'Push these questions to the taskboard with board_ask_many (one entry each: description, your recommendation if you have one, an id if they have one) so the user can answer them in the browser. Then end your turn with one short line saying the questions are on the board.',
  }));
}
