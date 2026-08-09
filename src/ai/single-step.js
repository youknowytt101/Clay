const assistantState = new WeakMap();
const proposalState = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalize(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must not contain a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail(`${path} must contain only JSON values`);
  if (seen.has(value)) fail(`${path} must not contain a cycle`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) fail(`${path} must contain only plain objects`);
    result = {};
    for (const key of Object.keys(value).sort(compareAscii)) {
      result[key] = canonicalize(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value, path) {
  return deepFreeze(canonicalize(value, path));
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function normalizeAllowedActions(value, registry) {
  if (!Array.isArray(value) || value.length === 0) fail('allowedActions must be a non-empty array');
  const actions = [...new Set(value)].sort(compareAscii);
  for (const id of actions) {
    nonEmptyString(id, 'allowedActions item');
    registry.describe(id);
  }
  return Object.freeze(actions);
}

function normalizeAffects(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('instruction is outside the host-approved affect scope');
  }
  const affects = [...new Set(value)].sort(compareAscii);
  if (affects.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('authorize must return non-empty affect strings');
  }
  return Object.freeze(affects);
}

function createProposalHandle(state, record) {
  const handle = Object.freeze({
    get requestId() { return record.requestId; },
    get instruction() { return record.instruction; },
    get context() { return record.context; },
    get action() { return record.action; },
    get description() { return record.description; },
    get receipt() { return record.terminalReceipt ?? record.preview.receipt; },
    get phase() { return record.phase; },
  });
  proposalState.set(handle, { state, record });
  return handle;
}

async function buildProposal(state, input) {
  const interpreted = await state.interpret(Object.freeze({
    instruction: input.instruction,
    context: input.context,
    availableActions: state.descriptions,
  }));
  if (!isPlainObject(interpreted)) fail('interpret must return an object');
  const actionId = nonEmptyString(interpreted.actionId, 'interpret.actionId');
  if (!state.allowedActions.includes(actionId)) {
    throw new Error(`Action ${actionId} is outside the single-step allowlist`);
  }
  if (!isPlainObject(interpreted.params)) fail('interpret.params must be an object');

  const action = immutableJson({ id: actionId, params: interpreted.params }, 'interpret result');
  const description = state.registry.describe(actionId);
  const authorization = await state.authorize(Object.freeze({
    instruction: input.instruction,
    context: input.context,
    action,
    description,
  }));
  const allowedAffects = normalizeAffects(authorization);
  const runId = `ai-single/${input.requestId}`;
  const stepId = 'single-action';
  const preview = await state.engine.previewStep({
    runId,
    stepId,
    baseRevision: state.engine.revision,
    beforeRevision: state.engine.revision,
    idempotencyKey: `${runId}/${stepId}`,
    allowedActions: state.allowedActions,
    allowedAffects,
    actions: [action],
  });
  const record = {
    requestId: input.requestId,
    instruction: input.instruction,
    context: input.context,
    action,
    description,
    preview,
    phase: preview.phase === 'previewed' && preview.receipt.status === 'passed'
      ? 'awaiting-confirmation'
      : 'failed',
    commitResult: null,
    terminalReceipt: null,
    transition: null,
  };
  record.handle = createProposalHandle(state, record);
  return record.handle;
}

class SingleStepAssistant {
  async propose(input) {
    const state = assistantState.get(this);
    if (!isPlainObject(input)) fail('single-step request must be an object');
    const requestId = nonEmptyString(input.requestId, 'requestId');
    const instruction = nonEmptyString(input.instruction, 'instruction').trim();
    const context = immutableJson(input.context ?? {}, 'context');
    const identity = JSON.stringify(canonicalize({ instruction, context }));
    const prior = state.requests.get(requestId);
    if (prior) {
      if (prior.identity !== identity) throw new Error(`request id ${requestId} was reused for different input`);
      return prior.promise;
    }
    const promise = buildProposal(state, { requestId, instruction, context });
    state.requests.set(requestId, { identity, promise });
    return promise;
  }

  async confirm(proposal) {
    const state = assistantState.get(this);
    const details = proposalState.get(proposal);
    if (!details || details.state !== state) fail('proposal does not belong to this single-step assistant');
    const { record } = details;
    if (record.phase === 'committed') return record.commitResult;
    if (record.transition) {
      if (record.transition.kind !== 'commit') throw new Error('cannot confirm a cancelling proposal');
      return record.transition.promise;
    }
    if (record.phase !== 'awaiting-confirmation') throw new Error(`cannot confirm a ${record.phase} proposal`);
    const promise = state.engine.commit(record.preview).then((result) => {
      record.commitResult = result;
      record.phase = 'committed';
      return result;
    }).catch((error) => {
      record.transition = null;
      throw error;
    });
    record.transition = { kind: 'commit', promise };
    return promise;
  }

  async abort(proposal) {
    const state = assistantState.get(this);
    const details = proposalState.get(proposal);
    if (!details || details.state !== state) fail('proposal does not belong to this single-step assistant');
    const { record } = details;
    if (record.phase === 'cancelled') return record.terminalReceipt;
    if (record.transition) {
      if (record.transition.kind !== 'abort') throw new Error('cannot abort a committing proposal');
      return record.transition.promise;
    }
    if (record.phase !== 'awaiting-confirmation') throw new Error(`cannot abort a ${record.phase} proposal`);
    const promise = Promise.resolve().then(() => state.engine.abort(record.preview)).then((receipt) => {
      record.terminalReceipt = receipt;
      record.phase = 'cancelled';
      return receipt;
    }).catch((error) => {
      record.transition = null;
      throw error;
    });
    record.transition = { kind: 'abort', promise };
    return promise;
  }
}

export function createSingleStepAssistant({ engine, registry, allowedActions, interpret, authorize } = {}) {
  if (!engine || typeof engine.previewStep !== 'function' || typeof engine.commit !== 'function' || typeof engine.abort !== 'function') {
    fail('engine must come from createActionEngine()');
  }
  if (!registry || typeof registry.describe !== 'function') fail('registry must come from createActionRegistry()');
  if (typeof interpret !== 'function') fail('interpret must be a function');
  if (typeof authorize !== 'function') fail('authorize must be a function');
  const normalizedActions = normalizeAllowedActions(allowedActions, registry);
  const assistant = new SingleStepAssistant();
  assistantState.set(assistant, {
    engine,
    registry,
    allowedActions: normalizedActions,
    descriptions: Object.freeze(normalizedActions.map((id) => registry.describe(id))),
    interpret,
    authorize,
    requests: new Map(),
  });
  return Object.freeze(assistant);
}
