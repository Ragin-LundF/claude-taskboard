#!/usr/bin/env node
'use strict';
/**
 * Installs (or with --remove, uninstalls) the taskboard status line bridge in the
 * user's Claude Code settings. An existing status line is kept: the bridge wraps it
 * and prints its output unchanged. settings.json is backed up before every change.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.claude', 'taskboard');
const TARGET = path.join(HOME, 'statusline.js');
const configDir = (process.env.CLAUDE_CONFIG_DIR || '').split(',')[0].trim() || path.join(os.homedir(), '.claude');
const SETTINGS = process.env.TASKBOARD_SETTINGS_FILE || path.join(configDir, 'settings.json');
const MARK = 'taskboard/statusline.js';

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const text = fs.readFileSync(SETTINGS, 'utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) {
    console.error(`Cannot parse ${SETTINGS} (${e.message}). Fix it first; nothing was changed.`);
    process.exit(1);
  }
}

function writeSettings(obj) {
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.taskboard-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`Backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS);
}

function unwrap(command) {
  const m = String(command || '').match(/--wrap\s+([A-Za-z0-9+/=]+)/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
}

const settings = readSettings();
const current = settings.statusLine;
const installed = current && typeof current.command === 'string' && (current.command.includes(MARK) || current.command.includes(TARGET));

if (process.argv.includes('--remove')) {
  if (!installed) { console.log('The taskboard status line is not installed; nothing changed.'); process.exit(0); }
  const original = unwrap(current.command);
  if (original) {
    const restored = { ...current, command: original };
    settings.statusLine = restored;
    console.log(`Restored your previous status line: ${original}`);
  } else {
    delete settings.statusLine;
    console.log('Removed the taskboard status line.');
  }
  writeSettings(settings);
  process.exit(0);
}

// copy the self-contained bridge to a stable location (plugin paths change on updates)
fs.mkdirSync(HOME, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'statusline.js'), TARGET);

if (installed) {
  console.log(`Already installed in ${SETTINGS}. Bridge refreshed at ${TARGET}.`);
  process.exit(0);
}

const base = `node "${TARGET}"`;
let next;
if (current && current.type === 'command' && current.command) {
  next = { ...current, command: `${base} --wrap ${Buffer.from(current.command, 'utf8').toString('base64')}` };
  console.log(`Your existing status line is kept and wrapped: ${current.command}`);
} else {
  next = { type: 'command', command: base };
}
settings.statusLine = next;
writeSettings(settings);
console.log(`Installed the taskboard status line in ${SETTINGS}.`);
console.log('Plan limits (5h / weekly) appear on the board after the next Claude response in any session.');
