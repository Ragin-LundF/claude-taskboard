'use strict';
/**
 * A2UI v1.0 support with the taskboard catalog.
 *
 * Each question is one A2UI surface (surfaceId = the agent's own question id) whose root
 * component is one of the catalog components below. The board renders these components
 * itself; agents only send content, never layout. Answers go back as A2UI `action` messages.
 *
 * Storage stays compatible: a question keeps all existing fields and only gains
 * `kind` (component name) and `spec` (its validated properties).
 */

const VERSION = '1.0';
const CATALOG_ID = 'https://github.com/Ragin-LundF/claude-taskboard/catalog/v1';
const BASIC_CATALOG_IDS = new Set(['https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json']);
const COMPONENTS = ['Decision', 'Confirm', 'MultiChoice', 'Checklist', 'Form', 'Range', 'DateTime', 'Ranking', 'Info'];
const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'boolean'];
const DATE_MODES = ['date', 'time', 'datetime'];

class A2uiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (msg) => { throw new A2uiError('VALIDATION_FAILED', msg); };

function str(v, max, name, required) {
  if (v == null || v === '') { if (required) fail(`${name} is required`); return null; }
  if (typeof v !== 'string' && typeof v !== 'number') fail(`${name} must be a string`);
  return String(v).slice(0, max).trim() || (required ? fail(`${name} is required`) : null);
}
function num(v, name, required) {
  if (v == null || v === '') { if (required) fail(`${name} is required`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${name} must be a number`);
  return n;
}
function arr(v, name, min, max) {
  if (!Array.isArray(v)) fail(`${name} must be an array`);
  if (v.length < min) fail(`${name} needs at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
  return v.slice(0, max);
}
const labelOf = (o, name) => (typeof o === 'string' ? str(o, 300, name, true) : str(o && (o.label || o.title || o.value), 300, `${name}.label`, true));

/** Validate one root component of the taskboard catalog; returns { kind, spec } with normalized properties. */
function validateComponent(c) {
  if (!c || typeof c !== 'object') fail('component must be an object');
  const kind = c.component;
  if (!COMPONENTS.includes(kind)) fail(`component "${kind}" is not in the taskboard catalog (allowed: ${COMPONENTS.join(', ')})`);
  const base = {
    question: str(c.question || c.title || (kind === 'Info' ? 'Note' : null), 2000, 'question', true),
    details: str(c.details || c.description, 4000, 'details', false),
  };
  let spec;
  switch (kind) {
    case 'Decision':
      spec = {
        ...base,
        recommendation: str(c.recommendation, 2000, 'recommendation', false),
        options: arr(c.options || [], 'options', 0, 10).map((o, i) => ({
          label: labelOf(o, `options[${i}]`),
          type: o && ['accept', 'reject', 'neutral'].includes(o.type) ? o.type : 'neutral',
          recommended: !!(o && o.recommended),
          description: o && typeof o === 'object' ? str(o.description, 1500, `options[${i}].description`, false) : null,
        })),
      };
      break;
    case 'Confirm':
      spec = {
        ...base,
        recommendation: str(c.recommendation, 2000, 'recommendation', true),
        acceptLabel: str(c.acceptLabel, 60, 'acceptLabel', false),
        rejectLabel: str(c.rejectLabel, 60, 'rejectLabel', false),
      };
      break;
    case 'MultiChoice':
      spec = {
        ...base,
        options: arr(c.options, 'options', 2, 20).map((o, i) => ({
          label: labelOf(o, `options[${i}]`),
          description: o && typeof o === 'object' ? str(o.description, 1000, `options[${i}].description`, false) : null,
          recommended: !!(o && o.recommended),
        })),
        min: num(c.min, 'min', false),
        max: num(c.max, 'max', false),
      };
      break;
    case 'Checklist':
      spec = {
        ...base,
        items: arr(c.items, 'items', 1, 30).map((o, i) => ({ label: labelOf(o, `items[${i}]`), checked: !!(o && o.checked) })),
      };
      break;
    case 'Form':
      spec = {
        ...base,
        fields: arr(c.fields, 'fields', 1, 12).map((f, i) => {
          if (!f || typeof f !== 'object') fail(`fields[${i}] must be an object`);
          const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
          const field = {
            name: str(f.name, 60, `fields[${i}].name`, true),
            label: str(f.label || f.name, 120, `fields[${i}].label`, true),
            type,
            required: !!f.required,
            placeholder: str(f.placeholder, 200, `fields[${i}].placeholder`, false),
            default: f.default == null ? null : (type === 'boolean' ? !!f.default : String(f.default).slice(0, 500)),
          };
          if (type === 'select') field.options = arr(f.options, `fields[${i}].options`, 1, 20).map((o, j) => labelOf(o, `fields[${i}].options[${j}]`));
          return field;
        }),
      };
      if (new Set(spec.fields.map((f) => f.name)).size !== spec.fields.length) fail('Form field names must be unique');
      break;
    case 'Range':
      spec = {
        ...base,
        min: num(c.min, 'min', true),
        max: num(c.max, 'max', true),
        step: num(c.step, 'step', false) || 1,
        unit: str(c.unit, 20, 'unit', false),
        default: num(c.default, 'default', false),
        recommended: num(c.recommended, 'recommended', false),
      };
      if (spec.max <= spec.min) fail('Range max must be greater than min');
      break;
    case 'DateTime':
      spec = {
        ...base,
        mode: DATE_MODES.includes(c.mode) ? c.mode : 'date',
        default: str(c.default, 40, 'default', false),
        min: str(c.min, 40, 'min', false),
        max: str(c.max, 40, 'max', false),
      };
      break;
    case 'Ranking':
      spec = { ...base, items: arr(c.items, 'items', 2, 20).map((o, i) => labelOf(o, `items[${i}]`)) };
      break;
    case 'Info':
      spec = { ...base, text: str(c.text || c.details, 6000, 'text', false) };
      break;
    default:
      fail(`unsupported component ${kind}`);
  }
  return { kind, spec };
}

function rootOf(components) {
  const list = arr(components, 'components', 1, 50);
  const root = list.find((c) => c && c.id === 'root');
  if (!root) fail('components need one component with "id": "root"');
  if (list.length > 1) fail('the taskboard catalog uses exactly one component per surface (the root)');
  return root;
}

/**
 * Turn A2UI agent→renderer messages into board operations.
 * Returns [{ op, args, surfaceId }] or throws A2uiError.
 */
function messagesToOps(messages, defaults) {
  const list = Array.isArray(messages) ? messages : [messages];
  return list.map((m, idx) => {
    try {
      if (!m || typeof m !== 'object') fail('message must be an object');
      if (m.version != null && String(m.version) !== VERSION) fail(`unsupported A2UI version "${m.version}" (expected "${VERSION}")`);
      const keys = ['createSurface', 'updateComponents', 'deleteSurface', 'updateDataModel'].filter((k) => m[k]);
      if (keys.length !== 1) fail('each message needs exactly one of createSurface, updateComponents, deleteSurface');
      const key = keys[0];
      const body = m[key];
      const surfaceId = str(body.surfaceId, 80, 'surfaceId', true);
      if (key === 'createSurface') {
        if (body.catalogId && body.catalogId !== CATALOG_ID) {
          fail(BASIC_CATALOG_IDS.has(body.catalogId)
            ? `the basic catalog is not supported; use catalogId "${CATALOG_ID}"`
            : `unknown catalogId "${body.catalogId}" (use "${CATALOG_ID}")`);
        }
        const { kind, spec } = validateComponent(rootOf(body.components));
        const md = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
        return { op: 'askComponent', surfaceId, args: { ...defaults, externalId: surfaceId, kind, spec, taskId: md.taskId || null, askedBy: md.askedBy || defaults.askedBy || null } };
      }
      if (key === 'updateComponents') {
        const { kind, spec } = validateComponent(rootOf(body.components));
        return { op: 'updateComponent', surfaceId, args: { project: defaults.project, externalId: surfaceId, kind, spec } };
      }
      if (key === 'deleteSurface') return { op: 'deleteSurface', surfaceId, args: { project: defaults.project, externalId: surfaceId } };
      fail('updateDataModel is not used by the taskboard catalog (components carry their own values)');
    } catch (e) {
      if (e instanceof A2uiError) e.message = `message ${idx + 1}: ${e.message}`;
      throw e;
    }
    return null;
  });
}

/** The A2UI action message the board sends back for an answered question. */
function actionMessage(q) {
  if (q.status !== 'answered') return null;
  return {
    version: VERSION,
    action: {
      name: q.dismissed ? 'dismiss' : (q.kind === 'Info' ? 'acknowledge' : 'answer'),
      surfaceId: q.externalId || q.id,
      sourceComponentId: 'root',
      timestamp: q.answeredAt,
      context: q.answerContext || { decision: q.decision, ...(q.chosenOption ? { choice: q.chosenOption } : {}), ...(q.comment ? { comment: q.comment } : {}) },
    },
  };
}

/** Component kind of a question stored before kinds existed (v1.7.x and older). */
function legacyKind(q) {
  if (q.kind) return q.kind;
  if ((!q.options || !q.options.length) && q.recommendation) return 'Confirm';
  return 'Decision';
}

module.exports = { VERSION, CATALOG_ID, COMPONENTS, A2uiError, validateComponent, messagesToOps, actionMessage, legacyKind };
