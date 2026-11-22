#!/usr/bin/env node
'use strict';
/**
 * PostToolUse hook (Write / Edit / MultiEdit): when an agent writes a questions file
 * (file name contains "question" or "fragen", e.g. OPEN_QUESTIONS.md, questions.json,
 * offene-fragen.md), remind it to push the open entries to the taskboard.
 * Throttled to once per file per 5 minutes. Disable with TASKBOARD_QUESTION_NUDGE=0.
 */
const fs = require('fs');
const path = require('path');

if (process.env.TASKBOARD_QUESTION_NUDGE === '0') process.exit(0);
const { HOME } = require(path.join(__dirname, '..', 'server', 'lib', 'config'));
const { request } = require(path.join(__dirname, '..', 'server', 'lib', 'node'));
const CACHE = path.join(HOME, '.question-file-nudges.json');
const PATTERN = /(question|fragen)/i;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main().catch(() => {}).finally(() => process.exit(0)); });
setTimeout(() => process.exit(0), 2500).unref();

async function main() {
  const input = JSON.parse(raw || '{}');
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file || !PATTERN.test(path.basename(file))) return;

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* first time */ }
  const key = `${input.session_id || ''}:${file}`;
  if (cache[key] && Date.now() - cache[key] < 5 * 60 * 1000) return;

  // only when a board is running
  try {
    const r = await request('GET', '/api/health', null, 800);
    if (r.status !== 200) return;
  } catch { return; }

  cache[key] = Date.now();
  for (const k of Object.keys(cache)) if (Date.now() - cache[k] > 24 * 3600 * 1000) delete cache[k];
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { /* ignore */ }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `You just wrote the questions file ${file}. Push every OPEN question in it to the taskboard with board_ask_many `
        + '(id = the question id from the file, description, recommendation) so the user can answer in the browser. '
        + 'Skip entries that are already answered in the file. When answers arrive, write the decisions back into the file.',
    },
  }));
}
