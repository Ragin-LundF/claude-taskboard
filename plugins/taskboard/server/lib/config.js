'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.TASKBOARD_PORT || 4747);
const HOST = '127.0.0.1';
const HOME = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.claude', 'taskboard');
const BOARD_FILE = path.join(HOME, 'board.json');
const APP_ID = 'claude-taskboard';

/** Walk up from dir to the nearest git root; fall back to dir itself. */
function detectProject(dir) {
  const start = path.resolve(dir || process.cwd());
  let cur = start;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return { path: cur, name: path.basename(cur) || cur };
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { path: start, name: path.basename(start) || start };
}

module.exports = { PORT, HOST, HOME, BOARD_FILE, APP_ID, detectProject };
