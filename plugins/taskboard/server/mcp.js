#!/usr/bin/env node
'use strict';
/**
 * Taskboard MCP server (stdio). Claude Code starts one per session and stops it
 * when the session ends; stdin closing is our signal to shut down.
 */
const readline = require('readline');
const { spawn } = require('child_process');
const { detectProject, PORT, HOME } = require('./lib/config');
const { BoardNode } = require('./lib/node');

const VERSION = '1.7.1';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const project = detectProject(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const node = new BoardNode();
refreshStatuslineBridge();
const ready = node.start().catch((e) => process.stderr.write(`[taskboard] start failed: ${e.message}\n`));

// ------------------------------------------------------------------ tools

const subtaskSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short imperative title' },
    description: { type: 'string', description: 'What has to be done / acceptance criteria' },
    assignee: { type: 'string', description: 'Who works on it, e.g. "Bob"' },
    status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
    subtasks: { type: 'array', items: { type: 'object' }, description: 'Nested subtasks, same shape' },
  },
  required: ['title'],
};

const projectProp = { type: 'string', description: 'Absolute project path. Omit to use the current project.' };

const TOOLS = [
  {
    name: 'board_open',
    description: 'Ensure the taskboard is running and return its URL and the current project. Call this first when using the taskboard.',
    inputSchema: { type: 'object', properties: { launchBrowser: { type: 'boolean', description: 'Open the board in the user\'s default browser' } } },
    run: async (a) => {
      await ready;
      if (node.role === 'conflict') throw new Error(node.conflict);
      if (a.launchBrowser) openBrowser(node.url);
      return `Taskboard: ${node.url}\nProject: ${project.name} (${project.path})\nThis session is the board ${node.role}.`;
    },
  },
  {
    name: 'board_list',
    description: 'List tasks on the board for the current project (open tasks by default). Always check this before adding tasks to avoid duplicates.',
    inputSchema: { type: 'object', properties: { includeFinished: { type: 'boolean' }, allProjects: { type: 'boolean' }, project: projectProp } },
    run: async (a) => formatList(await node.op('list', { ...a, project: a.project || project.path })),
  },
  {
    name: 'board_plan',
    description: 'Create several tasks at once, optionally nested (subtasks). Use this to put an implementation plan on the board.',
    inputSchema: {
      type: 'object',
      properties: { tasks: { type: 'array', items: subtaskSchema }, parentId: { type: 'string', description: 'Attach all tasks under this existing task' }, project: projectProp },
      required: ['tasks'],
    },
    run: async (a) => formatCreated(await node.op('plan', withProject(a))),
  },
  {
    name: 'board_add',
    description: 'Add a single task to the board.',
    inputSchema: {
      type: 'object',
      properties: { ...subtaskSchema.properties, parentId: { type: 'string' }, project: projectProp },
      required: ['title'],
    },
    run: async (a) => { const t = await node.op('add', withProject(a)); return `Created ${t.id}: ${t.title}`; },
  },
  {
    name: 'board_split',
    description: 'Split a task that is too big into subtasks. The parent card then shows progress and finishes automatically when all subtasks are done.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, subtasks: { type: 'array', items: subtaskSchema } }, required: ['id', 'subtasks'] },
    run: async (a) => formatCreated(await node.op('split', a)),
  },
  {
    name: 'board_start',
    description: 'Move a task to In Progress and set who is working on it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, assignee: { type: 'string', description: 'Worker name, e.g. "Bob"' }, note: { type: 'string' } }, required: ['id', 'assignee'] },
    run: async (a) => { const t = await node.op('start', a); return `${t.id} in progress (${t.assignee})`; },
  },
  {
    name: 'board_finish',
    description: 'Move a task to Finished. Only the user removes finished tasks from the board.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'Short result summary' } }, required: ['id'] },
    run: async (a) => { const t = await node.op('finish', a); return `${t.id} finished`; },
  },
  {
    name: 'board_update',
    description: 'Change a task: title, description, status (todo | in_progress | blocked | done), assignee or note. Use status "blocked" with a note to flag a blocker.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] }, assignee: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    },
    run: async (a) => { const t = await node.op('update', a); return `${t.id} updated (${t.status}${t.assignee ? `, ${t.assignee}` : ''})`; },
  },
  {
    name: 'board_ask',
    description: 'Ask the user ONE question on the taskboard; they answer in the browser with Accept / Reject (of your recommendation), an option button, or free text. Use for every decision or missing information you need from the user while the board is in use. Give a recommendation whenever you have one. By default waits for the answer (up to timeoutSeconds); if it times out, the answer is delivered automatically on your next turn, or fetch it with board_answers. For several questions use board_ask_many.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One clear question' },
        details: { type: 'string', description: 'Context the user needs to answer' },
        recommendation: { type: 'string', description: 'What you recommend; the user can Accept or Reject it' },
        externalId: { type: 'string', description: 'Your own id for the question (e.g. from a questions file); asking again with the same id updates instead of duplicating' },
        options: {
          type: 'array',
          description: 'Answer options shown as buttons. Each: label, type (accept = green, reject = red, neutral = blue for anything in between), recommended (highlighted), optional description for complex choices.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short button text' },
              type: { type: 'string', enum: ['accept', 'reject', 'neutral'] },
              recommended: { type: 'boolean' },
              description: { type: 'string', description: 'What this option means / its consequences (shown under the label)' },
            },
            required: ['label'],
          },
        },
        taskId: { type: 'string', description: 'Task the question belongs to' },
        askedBy: { type: 'string', description: 'Who asks, e.g. "Bob"' },
        wait: { type: 'boolean', description: 'Wait for the answer (default true)' },
        timeoutSeconds: { type: 'number', description: 'How long to wait, default 300, max 1800' },
        project: projectProp,
      },
      required: ['question'],
    },
    run: async (a, ctx) => {
      const q = await node.op('ask', { ...withProject(a), askerPid: process.ppid });
      if (q.existing && q.status === 'answered') return `${q.id}${q.externalId ? ` [${q.externalId}]` : ''} was already answered: ${q.answer}`;
      const head = `Question ${q.id} is on the taskboard (${node.url}).`;
      if (a.wait === false) return `${head} Answer will be delivered automatically; or call board_answers.`;
      const deadline = Date.now() + Math.min(Math.max(Number(a.timeoutSeconds) || 300, 5), 1800) * 1000;
      const started = Date.now();
      let lastProgress = started;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (ctx.cancelled) return `${head} Waiting was cancelled.`;
        const cur = await node.op('getQuestion', { id: q.id });
        if (cur.status === 'answered') {
          await node.op('markDelivered', { id: q.id });
          return `${q.id}${cur.externalId ? ` [${cur.externalId}]` : ''} — user answer: ${cur.answer}`;
        }
        if (ctx.progressToken != null && Date.now() - lastProgress > 10000) {
          lastProgress = Date.now();
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: ctx.progressToken, progress: Math.round((Date.now() - started) / 1000), message: 'waiting for the user on the taskboard' } });
        }
      }
      return `${head} No answer yet. Continue with other work if you can; the answer will be delivered automatically on your next turn, or call board_answers.`;
    },
  },
  {
    name: 'board_ask_many',
    description: 'Push several open questions to the taskboard at once, without waiting. Use this for questions collected in a file (e.g. OPEN_QUESTIONS.md / questions.json with id, description, recommendation) or when you have more than one question. Each entry keeps your id: pushing the same id again updates it instead of duplicating, and already answered ones come back with their answer. Answers arrive automatically on your next turn, or call board_answers.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Question id from your file/list, e.g. "Q-12" or "OQ-3"' },
              question: { type: 'string', description: 'The question (or use description)' },
              description: { type: 'string', description: 'Description / context' },
              recommendation: { type: 'string', description: 'Your recommendation; the user can Accept or Reject it' },
              options: {
                type: 'array',
                description: 'Answer options shown as buttons. Each: label, type (accept = green, reject = red, neutral = blue for anything in between), recommended (highlighted), optional description for complex choices.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short button text' },
                    type: { type: 'string', enum: ['accept', 'reject', 'neutral'] },
                    recommended: { type: 'boolean' },
                    description: { type: 'string', description: 'What this option means / its consequences (shown under the label)' },
                  },
                  required: ['label'],
                },
              },
              taskId: { type: 'string', description: 'Related board task' },
            },
          },
        },
        askedBy: { type: 'string' },
        project: projectProp,
      },
      required: ['questions'],
    },
    run: async (a) => {
      const r = await node.op('askMany', { ...withProject(a), askerPid: process.ppid });
      const lines = r.questions.map((q) => `${q.id}${q.externalId ? ` [${q.externalId}]` : ''}: ${q.status === 'answered' ? `already answered → ${q.answer}` : q.existing ? 'open (updated)' : 'open (new)'}`);
      return `On the taskboard (${node.url}):\n${lines.join('\n')}\nAnswers are delivered automatically on your next turn, or call board_answers. Update your questions file when they arrive.`;
    },
  },
  {
    name: 'board_answers',
    description: 'Fetch answers the user gave on the taskboard that you have not received yet (with your question ids and the decision: ACCEPTED / REJECTED / CHOSE / free text). Use includeOpen to see which questions are still waiting.',
    inputSchema: { type: 'object', properties: { includeOpen: { type: 'boolean' } } },
    run: async (a) => {
      const r = await node.op('takeAnswers', { pids: [process.ppid], project: project.path });
      const out = r.answers.length
        ? r.answers.map((q) => `${q.id}${q.externalId ? ` [${q.externalId}]` : ''} "${q.question}"\n→ ${q.answer}`).join('\n\n')
        : 'No new answers.';
      if (!a.includeOpen) return out;
      const l = await node.op('listQuestions', { project: project.path });
      const open = l.questions.filter((q) => q.status === 'open');
      return `${out}\n\nStill open (${open.length}):${open.length ? `\n${open.map((q) => `${q.id}${q.externalId ? ` [${q.externalId}]` : ''}: ${q.question}`).join('\n')}` : ' none'}`;
    },
  },
  {
    name: 'board_usage',
    description: 'Token usage and API-equivalent cost estimate from Claude Code session logs: today, current 5-hour block, last 7/30 days, for this project and in total.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const u = await node.op('usage', {});
      return formatUsage({ ...(u || { pending: true }), limits: await node.op('limitsGet', {}) });
    },
  },
];

function money(v) { return `$${(v || 0).toFixed(v >= 100 ? 0 : 2)}`; }
function tok(v) { return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v || 0); }

function formatUsage(u) {
  const line = (label, x) => `${label}: ${money(x.cost)} · ${tok(x.tokens)} tokens (${tok(x.out)} output)`;
  const out = [];
  const lim = u.limits;
  const winTxt = (label, w) => {
    if (!w) return null;
    const reset = w.resetsAt && w.resetsAt <= Date.now();
    return `${label}: ${reset ? 0 : Math.round(w.used)}% used, ${reset ? 100 : Math.max(0, 100 - Math.round(w.used))}% left${w.resetsAt && !reset ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ''}`;
  };
  if (lim) {
    out.push(`Plan limits (via ${lim.source === 'api' ? 'usage API' : 'status line'}, ${new Date(lim.updatedAt).toLocaleTimeString()}):`);
    for (const l of [winTxt('5-hour window', lim.five_hour), winTxt('Weekly', lim.seven_day), winTxt('Spend limit', lim.spend_limit)]) if (l) out.push(`  ${l}`);
  } else {
    out.push('Plan limits: not available yet. Choose a source in the board\'s usage panel (status line via /taskboard-limits, or usage API).');
  }
  out.push('Token cost below is an API-equivalent estimate:');
  if (!u || u.pending) { out.push('Usage is still being read from the session logs; try again in a few seconds.'); return out.join('\n'); }
  if (!u.hasData) { out.push('No Claude Code session logs found.'); return out.join('\n'); }
  const all = u.scopes.__all;
  const mine = u.scopes[project.path];
  if (u.block) out.push(`Current 5h block: ${money(u.block.cost)}, ends ${new Date(u.block.end).toLocaleTimeString()}, burn ${money(u.block.burnPerHour)}/h`);
  out.push(line('All projects today', all.today), line('All projects 7 days', all.last7), line('All projects 30 days', all.last30));
  if (mine) out.push(line(`${project.name} today`, mine.today), line(`${project.name} 7 days`, mine.last7));
  return out.join('\n');
}

function withProject(a) {
  if (a.project) return { ...a, projectName: undefined };
  return { ...a, project: project.path, projectName: project.name };
}

function formatCreated(r) {
  const lines = r.created.map((t) => `${t.id}${t.parentId ? ` (under ${t.parentId})` : ''}: ${t.title}`);
  return `Created ${r.created.length} task(s):\n${lines.join('\n')}`;
}

function formatList(r) {
  if (!r.tasks.length) return `No matching tasks${r.project ? ` for ${r.project}` : ''}.`;
  const order = { in_progress: 0, blocked: 1, todo: 2, done: 3 };
  const tasks = [...r.tasks].sort((x, y) => order[x.status] - order[y.status] || Number(x.id.slice(2)) - Number(y.id.slice(2)));
  const lines = tasks.map((t) => {
    const bits = [`[${t.status}]`, t.id];
    if (t.parentId) bits.push(`(sub of ${t.parentId})`);
    bits.push(t.title);
    if (t.assignee) bits.push(`— ${t.assignee}`);
    if (t.project) bits.push(`{${t.project}}`);
    let s = bits.join(' ');
    if (t.note) s += `\n    note: ${t.note}`;
    return s;
  });
  return `${r.project ? `Project ${r.project}\n` : ''}${lines.join('\n')}`;
}

/** Keep the installed status line bridge (~/.claude/taskboard/statusline.js) in sync after plugin updates. */
function refreshStatuslineBridge() {
  try {
    const fs = require('fs');
    const path = require('path');
    const target = path.join(HOME, 'statusline.js');
    if (!fs.existsSync(target)) return;
    const src = path.join(__dirname, '..', 'scripts', 'statusline.js');
    if (fs.readFileSync(src, 'utf8') !== fs.readFileSync(target, 'utf8')) fs.copyFileSync(src, target);
  } catch { /* ignore */ }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ JSON-RPC

const running = new Map();
function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        result = {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'taskboard', version: VERSION },
          instructions: `Kanban taskboard at http://localhost:${PORT}. Use the taskboard skill for the workflow.`,
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list':
        result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        break;
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 });
        await ready;
        const ctx = { progressToken: params._meta && params._meta.progressToken, cancelled: false };
        running.set(id, ctx);
        try {
          const text = await tool.run(params.arguments || {}, ctx);
          result = { content: [{ type: 'text', text }] };
        } catch (e) {
          result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        } finally {
          running.delete(id);
        }
        break;
      }
      case 'notifications/cancelled': {
        const ctx = params && running.get(params.requestId);
        if (ctx) ctx.cancelled = true;
        return;
      }
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, …)
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  handle(msg);
});

function shutdown() {
  node.shutdown();
  process.exit(0);
}
rl.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
