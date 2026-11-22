'use strict';
/**
 * Board state and all mutating operations. Only the leader process applies
 * operations; followers, hooks and the web UI send them to the leader via HTTP.
 */

const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const STATUS_ALIASES = {
  todo: 'todo', pending: 'todo', open: 'todo', backlog: 'todo', 'to do': 'todo',
  in_progress: 'in_progress', 'in-progress': 'in_progress', inprogress: 'in_progress', doing: 'in_progress', wip: 'in_progress', started: 'in_progress',
  blocked: 'blocked', waiting: 'blocked',
  done: 'done', finished: 'done', completed: 'done', complete: 'done',
};

function emptyState() {
  return { version: 1, nextId: 1, nextQid: 1, rev: 0, projects: {}, tasks: {}, questions: {} };
}

function normStatus(s, fallback = 'todo') {
  if (s == null || s === '') return fallback;
  const v = STATUS_ALIASES[String(s).trim().toLowerCase()];
  if (!v) throw new Error(`Unknown status "${s}". Use one of: ${STATUSES.join(', ')}`);
  return v;
}

function now() { return new Date().toISOString(); }

function str(v, max = 4000) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

function resolveId(state, id) {
  if (id == null) throw new Error('Task id is required');
  let key = String(id).trim().toUpperCase();
  if (/^\d+$/.test(key)) key = `T-${key}`;
  if (!state.tasks[key]) throw new Error(`Task ${id} not found`);
  return key;
}

function registerProject(state, project, projectName) {
  if (!project) throw new Error('project is required');
  if (!state.projects[project]) state.projects[project] = { name: projectName || project.split(/[\\/]/).pop() || project };
  else if (projectName && state.projects[project].name !== projectName) state.projects[project].name = projectName;
}

function createTask(state, a) {
  registerProject(state, a.project, a.projectName);
  const title = str(a.title, 300).trim();
  if (!title) throw new Error('title is required');
  let parentId = null;
  if (a.parentId) parentId = resolveId(state, a.parentId);
  const id = `T-${state.nextId++}`;
  const status = normStatus(a.status);
  const t = {
    id,
    project: parentId ? state.tasks[parentId].project : a.project,
    title,
    description: str(a.description),
    status,
    assignee: str(a.assignee, 80).trim() || null,
    parentId,
    note: str(a.note, 1000) || null,
    source: a.source || 'agent',
    externalKey: a.externalKey || null,
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    finishedAt: status === 'done' ? now() : null,
  };
  state.tasks[id] = t;
  return t;
}

function setStatus(t, status) {
  if (t.status === status) return;
  t.status = status;
  t.finishedAt = status === 'done' ? now() : null;
  t.updatedAt = now();
}

function childrenOf(state, id) {
  return Object.values(state.tasks).filter((t) => t.parentId === id);
}

/** Parent cards follow their children: all done → done, any progress → in progress. */
function rollup(state) {
  const parents = new Set(Object.values(state.tasks).filter((t) => t.parentId).map((t) => t.parentId));
  for (const pid of parents) {
    const p = state.tasks[pid];
    if (!p) continue;
    const kids = childrenOf(state, pid);
    if (!kids.length) continue;
    const allDone = kids.every((k) => k.status === 'done');
    const anyMoving = kids.some((k) => k.status === 'in_progress' || k.status === 'done');
    if (allDone) setStatus(p, 'done');
    else if (p.status === 'done' || (p.status === 'todo' && anyMoving)) setStatus(p, 'in_progress');
  }
}

/** The plan limits the board shows, according to the selected source. */
function effectiveLimits(state) {
  const by = state.limitsBySource || {};
  if (!by.statusline && state.limits) by.statusline = state.limits; // data from v1.2
  const source = (state.limitsConfig && state.limitsConfig.source) || 'statusline';
  let pick = null;
  if (source === 'statusline') pick = by.statusline ? ['statusline', by.statusline] : null;
  else if (source === 'api') pick = by.api ? ['api', by.api] : null;
  else {
    const c = [['statusline', by.statusline], ['api', by.api]].filter((x) => x[1]).sort((x, y) => y[1].updatedAt - x[1].updatedAt);
    pick = c[0] || null;
  }
  return pick ? { ...pick[1], source: pick[0] } : null;
}

function brief(t) {
  return { id: t.id, title: t.title, status: t.status, assignee: t.assignee, parentId: t.parentId };
}

function planNodes(state, nodes, base, parentId, out) {
  if (!Array.isArray(nodes)) throw new Error('tasks must be an array');
  for (const n of nodes) {
    const t = createTask(state, { ...base, ...n, parentId, source: base.source });
    out.push(brief(t));
    if (Array.isArray(n.subtasks) && n.subtasks.length) planNodes(state, n.subtasks, base, t.id, out);
  }
}

function findExternal(state, key) {
  return Object.values(state.tasks).find((t) => t.externalKey === key) || null;
}

function resolveQid(state, id) {
  let key = String(id ?? '').trim().toUpperCase();
  if (/^\d+$/.test(key)) key = `Q-${key}`;
  if (!state.questions[key]) throw new Error(`Question ${id} not found`);
  return key;
}

/** Question text for duplicate detection: case, punctuation and a leading "Q148:" style prefix ignored. */
function normQuestion(text) {
  return String(text || '').toLowerCase().replace(/^\s*\[?[a-z]{0,4}-?\d+\]?\s*[:.)-]\s*/, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
}

/** Open questions that duplicate q (pushed again with q's board id or q's own id) get q's answer. */
function settleDuplicates(state, q) {
  const keys = new Set([q.id, (q.externalId || '').toUpperCase()].filter(Boolean));
  for (const d of Object.values(state.questions)) {
    if (d === q || d.status !== 'open' || d.project !== q.project) continue;
    if (!keys.has((d.externalId || '').toUpperCase())) continue;
    Object.assign(d, {
      status: 'answered', decision: q.decision, comment: `Same question as ${q.id}${q.comment ? ` — ${q.comment}` : ''}`,
      chosenOption: q.chosenOption || null, answer: q.answer, dismissed: !!q.dismissed,
      answeredAt: now(), delivered: true, deliveredAt: now(), duplicateOf: q.id,
    });
  }
}

/** Open duplicates of any answered question get its answer (returns how many were settled). */
function settleAllDuplicates(state) {
  let n = 0;
  // open copies of open questions (pushed again with the board id as own id): keep only the original
  for (const d of Object.values(state.questions)) {
    if (d.status !== 'open' || d.hidden || !d.externalId) continue;
    const orig = state.questions[(d.externalId || '').toUpperCase()];
    if (orig && orig !== d && orig.project === d.project && orig.status === 'open' && !orig.hidden) {
      d.hidden = true; d.duplicateOf = orig.id;
      if (d.askerPid) orig.askerPid = d.askerPid; // the answer goes to the session that asked last
      n++;
    }
  }
  for (const q of Object.values(state.questions)) {
    if (q.status !== 'answered' || q.duplicateOf) continue;
    const before = Object.values(state.questions).filter((d) => d.status === 'open').length;
    settleDuplicates(state, q);
    n += before - Object.values(state.questions).filter((d) => d.status === 'open').length;
  }
  return n;
}

function deliver(state, q) {
  if (q.status === 'answered' && !q.delivered) { q.delivered = true; q.deliveredAt = now(); }
  settleDuplicates(state, q);
}

function qBrief(q) {
  return {
    id: q.id, externalId: q.externalId || null, question: q.question, taskId: q.taskId, status: q.status,
    decision: q.decision || null, comment: q.comment || null, answer: q.answer, dismissed: !!q.dismissed,
  };
}

/** Human-readable answer the agent receives. */
function composeAnswer(q, decision, text, option) {
  const t = (text || '').trim();
  switch (decision) {
    case 'accept': return `ACCEPTED${q.recommendation ? ' the recommendation' : ''}${t ? ` — comment: ${t}` : ''}`;
    case 'reject': return `REJECTED${q.recommendation ? ' the recommendation' : ''}${t ? ` — instead: ${t}` : ' — no alternative given, propose another option or ask again'}`;
    case 'option': {
      const o = (q.options || []).map(normOption).find((x) => x && x.label === option);
      const kind = o && o.type !== 'neutral' ? ` (${o.type})` : '';
      return `CHOSE: ${option}${kind}${o && o.recommended ? ' — your recommended option' : ''}${t ? ` — comment: ${t}` : ''}`;
    }
    default: return t;
  }
}

const ACCEPT_RE = /^(yes|ok|okay|accept|approve|agree|go ahead|do it|ja|einverstanden|passt)\b/i;
const REJECT_RE = /^(no|reject|decline|don'?t|do not|cancel|skip|stop|nein|ablehnen)\b/i;
const RECOMMENDED_RE = /\s*[([]\s*(recommended|empfohlen|empfehlung)\s*[)\]]\s*/i;

/** Options are { label, type: accept | reject | neutral, recommended, description }; plain strings are typed by their wording. */
function normOption(o) {
  if (o == null) return null;
  let label;
  let type = null;
  let recommended = false;
  let description = null;
  if (typeof o === 'string') label = o;
  else {
    label = o.label || o.title || o.value || '';
    type = ['accept', 'reject', 'neutral'].includes(o.type) ? o.type : null;
    recommended = !!o.recommended;
    description = str(o.description, 1500).trim() || null;
  }
  label = str(label, 300).trim();
  if (RECOMMENDED_RE.test(label)) { recommended = true; label = label.replace(RECOMMENDED_RE, ' ').trim(); }
  if (!label) return null;
  if (!type) type = ACCEPT_RE.test(label) ? 'accept' : REJECT_RE.test(label) ? 'reject' : 'neutral';
  return { label, type, recommended, description };
}

function questionFields(a) {
  return {
    question: str(a.question || a.description || a.title, 2000).trim(),
    details: str(a.details || (a.question && a.description && a.description !== a.question ? a.description : ''), 4000) || null,
    recommendation: str(a.recommendation, 2000).trim() || null,
    options: Array.isArray(a.options) ? a.options.map(normOption).filter(Boolean).slice(0, 10) : [],
  };
}

const ops = {
  // ---- plan limits forwarded by the status line bridge (account-wide, latest wins) ----

  limits(state, a) {
    const clean = (w) => (w && typeof w.used === 'number' ? {
      used: Math.max(0, Math.min(1000, w.used)),
      resetsAt: Number(w.resetsAt) || null,
      usedUsd: w.usedUsd != null ? Number(w.usedUsd) : undefined,
      limitUsd: w.limitUsd != null ? Number(w.limitUsd) : undefined,
      period: w.period ? str(w.period, 40) : undefined,
    } : null);
    const next = { five_hour: clean(a.five_hour), seven_day: clean(a.seven_day), spend_limit: clean(a.spend_limit) };
    state.limitsBySource = state.limitsBySource || {};
    const prev = state.limitsBySource.statusline || null;
    const at = Number(a.at) || Date.now();
    if (prev && prev.updatedAt > at) return { __noChange: true, ignored: 'older' };
    const same = prev && JSON.stringify([prev.five_hour, prev.seven_day, prev.spend_limit]) === JSON.stringify([next.five_hour, next.seven_day, next.spend_limit]);
    // keep windows the latest report doesn't carry (Claude Code drops a window after it resets)
    for (const k of Object.keys(next)) if (!next[k] && prev && prev[k] && prev[k].resetsAt && prev[k].resetsAt > Date.now()) next[k] = prev[k];
    const entry = { ...next, updatedAt: at };
    state.limitsBySource.statusline = entry;
    state.bridge = { ...(state.bridge || {}), lastSeen: at, hasRateLimits: true };
    if (same && prev && at - (prev.notifiedAt || 0) < 30000) { entry.notifiedAt = prev.notifiedAt; return { __noChange: true }; }
    entry.notifiedAt = at;
    return { ok: true };
  },

  limitsGet(state) { return effectiveLimits(state); },

  /** Result of a usage-API poll (sent by the leader's poller). */
  limitsApiResult(state, a) {
    state.limitsBySource = state.limitsBySource || {};
    state.limitsStatus = state.limitsStatus || {};
    const at = Number(a.at) || Date.now();
    if (!a.ok) {
      const prevErr = state.limitsStatus.api && state.limitsStatus.api.error;
      state.limitsStatus.api = { ok: false, error: str(a.error, 300), at };
      return prevErr === state.limitsStatus.api.error ? { __noChange: true } : { ok: true };
    }
    state.limitsBySource.api = { five_hour: a.five_hour || null, seven_day: a.seven_day || null, spend_limit: null, updatedAt: at };
    state.limitsStatus.api = { ok: true, at };
    return { ok: true };
  },

  setLimitsSource(state, a) {
    const source = ['statusline', 'api', 'both'].includes(a.source) ? a.source : 'statusline';
    state.limitsConfig = { ...(state.limitsConfig || {}), source };
    if (source === 'statusline' && state.limitsStatus) delete state.limitsStatus.api;
    return { source };
  },

  bridgePing(state, a) {
    const prev = state.bridge || {};
    const at = Number(a.at) || Date.now();
    state.bridge = { lastSeen: at, hasRateLimits: !!a.hasRateLimits, version: a.version ? str(a.version, 40) : prev.version || null };
    if (prev.hasRateLimits === state.bridge.hasRateLimits && at - (prev.lastSeen || 0) < 30000) return { __noChange: true };
    return { ok: true };
  },

  // ---- questions: agents ask, the user answers in the UI ----

  ask(state, a) {
    registerProject(state, a.project, a.projectName);
    const f = questionFields(a);
    if (!f.question) throw new Error('question (or description) is required');
    const taskId = a.taskId ? resolveId(state, a.taskId) : null;
    const project = taskId ? state.tasks[taskId].project : a.project;
    const externalId = str(a.externalId, 80).trim() || null;
    if (externalId) {
      // same id pushed again (e.g. from a questions file): update an open question, never duplicate
      const up = externalId.toUpperCase();
      const existing = Object.values(state.questions).find((q) => q.project === project && !q.hidden && ((q.externalId || '').toUpperCase() === up || q.id === up));
      if (existing) {
        if (existing.status === 'open') {
          Object.assign(existing, f, { taskId: taskId || existing.taskId, askerPid: Number(a.askerPid) || existing.askerPid });
          return { ...qBrief(existing), existing: true };
        }
        deliver(state, existing); // the agent receives the answer right here
        return { ...qBrief(existing), existing: true };
      }
    }
    // same question text in the same project (re-asked without an id, e.g. after a restart): reuse it
    const norm = normQuestion(f.question);
    if (norm.length >= 8) {
      const same = Object.values(state.questions).find((q) => q.project === project && !q.hidden && normQuestion(q.question) === norm);
      if (same) {
        if (same.status === 'open') { Object.assign(same, { ...f, question: same.question }, { askerPid: Number(a.askerPid) || same.askerPid }); if (externalId && !same.externalId) same.externalId = externalId; }
        else deliver(state, same);
        return { ...qBrief(same), existing: true };
      }
    }
    const id = `Q-${state.nextQid++}`;
    state.questions[id] = {
      id, externalId, project, taskId, ...f,
      askedBy: str(a.askedBy, 80).trim() || null, askerPid: Number(a.askerPid) || null,
      status: 'open', decision: null, comment: null, answer: null, dismissed: false, delivered: false, hidden: false,
      createdAt: now(), answeredAt: null, deliveredAt: null,
    };
    return qBrief(state.questions[id]);
  },

  askMany(state, a) {
    if (!Array.isArray(a.questions) || !a.questions.length) throw new Error('questions must be a non-empty array');
    const out = [];
    for (const q of a.questions.slice(0, 50)) {
      out.push(ops.ask(state, { ...q, externalId: q.externalId || q.id, project: a.project, projectName: a.projectName, askedBy: q.askedBy || a.askedBy, askerPid: a.askerPid }));
    }
    return { questions: out };
  },

  /** Status and answers of specific questions (board ids like Q-3 or the agent's own ids), delivered before or not. */
  questionStatus(state, a) {
    const want = (a.ids || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    const out = [];
    for (const w of want) {
      const q = state.questions[w] || state.questions[/^\d+$/.test(w) ? `Q-${w}` : '']
        || Object.values(state.questions).find((x) => (x.externalId || '').toUpperCase() === w && (!a.project || x.project === a.project))
        || Object.values(state.questions).find((x) => (x.externalId || '').toUpperCase() === w);
      if (!q) { out.push({ id: w, missing: true }); continue; }
      deliver(state, q);
      out.push(qBrief(q));
    }
    return { questions: out };
  },

  /** Open and answered questions of a project (for syncing a local questions file). */
  listQuestions(state, a) {
    return { questions: Object.values(state.questions).filter((q) => !a.project || q.project === a.project).map(qBrief) };
  },

  answer(state, a) {
    const q = state.questions[resolveQid(state, a.id)];
    const decision = ['accept', 'reject', 'option', 'answer'].includes(a.decision) ? a.decision : 'answer';
    const text = str(a.text != null ? a.text : a.answer, 4000).trim();
    const option = str(a.option, 300).trim();
    if (decision === 'answer' && !text) throw new Error('answer text is required');
    if (decision === 'option' && !option) throw new Error('option is required');
    Object.assign(q, {
      status: 'answered', decision, comment: text || null, chosenOption: option || null,
      answer: composeAnswer(q, decision, text, option),
      dismissed: false, answeredAt: now(), delivered: false, deliveredAt: null,
    });
    return qBrief(q);
  },

  /** Reopen an answered question (the user changed their mind). */
  reopen(state, a) {
    const q = state.questions[resolveQid(state, a.id)];
    Object.assign(q, { status: 'open', decision: null, comment: null, chosenOption: null, answer: null, dismissed: false, answeredAt: null, delivered: false, deliveredAt: null });
    return qBrief(q);
  },

  /** Does this project have work on the board? (used by the question nudge) */
  projectActive(state, a) {
    const tasks = Object.values(state.tasks).filter((t) => t.project === a.project && !t.archived);
    return { active: tasks.some((t) => t.status !== 'done'), tasks: tasks.length };
  },

  dismiss(state, a) {
    const q = state.questions[resolveQid(state, a.id)];
    Object.assign(q, { status: 'answered', decision: 'dismissed', answer: 'DISMISSED by the user without an answer. Decide yourself or ask in the chat.', dismissed: true, answeredAt: now(), delivered: false });
    return qBrief(q);
  },

  hideQuestion(state, a) {
    const q = state.questions[resolveQid(state, a.id)];
    q.hidden = true;
    return qBrief(q);
  },

  getQuestion(state, a) {
    return qBrief(state.questions[resolveQid(state, a.id)]);
  },

  cleanup() { return { __noChange: true }; },

  markDelivered(state, a) {
    const q = state.questions[resolveQid(state, a.id)];
    deliver(state, q);
    return qBrief(q);
  },

  /** Hand answered-but-undelivered questions to the asking session (matched by Claude process id, else project). */
  takeAnswers(state, a) {
    const pids = new Set((a.pids || []).map(Number).filter(Boolean));
    const dead = new Set((a.deadPids || []).map(Number));
    const out = [];
    for (const q of Object.values(state.questions)) {
      if (q.status !== 'answered' || q.delivered) continue;
      const sameProject = a.project && q.project === a.project;
      // the asking session matches by process id; if that process is gone (restart, --continue), any session of the project takes it
      const mine = q.askerPid && pids.size ? (pids.has(q.askerPid) || (dead.has(q.askerPid) && sameProject)) : sameProject;
      if (!mine) continue;
      deliver(state, q);
      out.push(qBrief(q));
    }
    return { answers: out };
  },

  add(state, a) {
    return brief(createTask(state, a));
  },

  plan(state, a) {
    const out = [];
    const parentId = a.parentId ? resolveId(state, a.parentId) : null;
    planNodes(state, a.tasks, { project: a.project, projectName: a.projectName, source: a.source || 'agent' }, parentId, out);
    return { created: out };
  },

  split(state, a) {
    const id = resolveId(state, a.id);
    if (!Array.isArray(a.subtasks) || !a.subtasks.length) throw new Error('subtasks must be a non-empty array');
    const out = [];
    planNodes(state, a.subtasks, { project: state.tasks[id].project, source: a.source || 'agent' }, id, out);
    return { parent: id, created: out };
  },

  update(state, a) {
    const t = state.tasks[resolveId(state, a.id)];
    if (a.title != null) t.title = str(a.title, 300).trim() || t.title;
    if (a.description != null) t.description = str(a.description);
    if (a.assignee !== undefined) t.assignee = str(a.assignee, 80).trim() || null;
    if (a.note !== undefined) t.note = str(a.note, 1000) || null;
    if (a.status != null) setStatus(t, normStatus(a.status));
    t.updatedAt = now();
    return brief(t);
  },

  start(state, a) {
    const t = state.tasks[resolveId(state, a.id)];
    if (a.assignee) t.assignee = str(a.assignee, 80).trim();
    if (a.note !== undefined) t.note = str(a.note, 1000) || null;
    setStatus(t, 'in_progress');
    t.archived = false;
    return brief(t);
  },

  finish(state, a) {
    const t = state.tasks[resolveId(state, a.id)];
    if (a.note !== undefined) t.note = str(a.note, 1000) || null;
    setStatus(t, 'done');
    return brief(t);
  },

  block(state, a) {
    const t = state.tasks[resolveId(state, a.id)];
    t.note = str(a.reason, 1000) || t.note;
    setStatus(t, 'blocked');
    return brief(t);
  },

  archive(state, a) {
    const ids = (a.ids || []).map((i) => resolveId(state, i));
    for (const id of ids) {
      state.tasks[id].archived = true;
      state.tasks[id].updatedAt = now();
      // archiving a parent archives its finished children too
      for (const k of childrenOf(state, id)) if (k.status === 'done') k.archived = true;
    }
    return { archived: ids };
  },

  unarchive(state, a) {
    const ids = (a.ids || []).map((i) => resolveId(state, i));
    for (const id of ids) { state.tasks[id].archived = false; state.tasks[id].updatedAt = now(); }
    return { restored: ids };
  },

  remove(state, a) {
    const id = resolveId(state, a.id);
    const kill = (tid) => { for (const k of childrenOf(state, tid)) kill(k.id); delete state.tasks[tid]; };
    kill(id);
    return { removed: id };
  },

  list(state, a) {
    let tasks = Object.values(state.tasks);
    if (a.project && !a.allProjects) tasks = tasks.filter((t) => t.project === a.project);
    if (!a.includeArchived) tasks = tasks.filter((t) => !t.archived);
    if (!a.includeFinished) tasks = tasks.filter((t) => t.status !== 'done');
    return {
      project: a.allProjects ? null : (state.projects[a.project] || {}).name || a.project,
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, status: t.status, assignee: t.assignee, parentId: t.parentId,
        description: t.description || undefined, note: t.note || undefined,
        project: a.allProjects ? (state.projects[t.project] || {}).name : undefined,
      })),
    };
  },

  // ---- mirroring of Claude's own task tools (sent by the PostToolUse hook) ----

  mirrorTodos(state, a) {
    registerProject(state, a.project, a.projectName);
    const prefix = `todo:${a.session}:`;
    const seen = new Set();
    for (const td of a.todos || []) {
      const content = str(td.content, 300).trim();
      if (!content) continue;
      const key = prefix + content;
      seen.add(key);
      const status = normStatus(td.status, 'todo');
      const existing = findExternal(state, key);
      if (existing) {
        setStatus(existing, status);
        if (status === 'in_progress' && !existing.assignee) existing.assignee = a.assignee || null;
      } else {
        createTask(state, { project: a.project, title: content, status, assignee: status === 'in_progress' ? a.assignee : null, source: 'mirror', externalKey: key });
      }
    }
    // items that disappeared from the todo list and were never finished are dropped
    for (const t of Object.values(state.tasks)) {
      if (t.externalKey && t.externalKey.startsWith(prefix) && !seen.has(t.externalKey) && t.status !== 'done') delete state.tasks[t.id];
    }
    return { ok: true };
  },

  mirrorTaskCreate(state, a) {
    const key = `task:${a.session}:${a.extId || a.subject}`;
    const existing = findExternal(state, key);
    if (existing) return brief(existing);
    return brief(createTask(state, { project: a.project, projectName: a.projectName, title: a.subject, description: a.description, source: 'mirror', externalKey: key }));
  },

  mirrorTaskUpdate(state, a) {
    const key = `task:${a.session}:${a.extId}`;
    const t = findExternal(state, key);
    if (!t) return { ok: false };
    if (a.status === 'deleted') { delete state.tasks[t.id]; return { ok: true }; }
    if (a.subject) t.title = str(a.subject, 300);
    if (a.description) t.description = str(a.description);
    if (a.owner) t.assignee = str(a.owner, 80);
    if (a.status) {
      const s = normStatus(a.status, t.status);
      if (s === 'in_progress' && !t.assignee) t.assignee = a.assignee || null;
      setStatus(t, s);
    }
    t.updatedAt = now();
    return brief(t);
  },
};

const READ_ONLY = new Set(['list', 'getQuestion', 'limitsGet', 'listQuestions', 'projectActive']);

function apply(state, op, args) {
  const fn = ops[op];
  if (!fn) throw new Error(`Unknown operation "${op}"`);
  if (!state.questions) { state.questions = {}; state.nextQid = 1; }
  const result = fn(state, args || {});
  const changed = !READ_ONLY.has(op) && !(result && result.__noChange);
  if (changed || op === 'cleanup') {
    const settled = settleAllDuplicates(state);
    if (changed || settled) { rollup(state); state.rev++; }
    return { result, changed: changed || settled > 0 };
  }
  return { result, changed };
}

module.exports = { emptyState, apply, STATUSES, effectiveLimits, normOption };
