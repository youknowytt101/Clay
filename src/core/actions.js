import {
  createCheckpointStore,
  createWorldEnvelope,
  loadWorldEnvelope,
} from './serialization.js';

const ACTION_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const actionRegistryState = new WeakMap();
const engineState = new WeakMap();
const previewState = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
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

function validateSchemaDefinition(schema, path = 'paramsSchema') {
  if (!isPlainObject(schema)) fail(`${path} must be an object`);
  if (!JSON_SCHEMA_TYPES.has(schema.type)) {
    fail(`${path} has unsupported JSON Schema type ${String(schema.type)}`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) fail(`${path}.enum must be a non-empty array`);
    immutableJson(schema.enum, `${path}.enum`);
  }
  for (const keyword of ['minimum', 'maximum']) {
    if (schema[keyword] !== undefined && !Number.isFinite(schema[keyword])) {
      fail(`${path}.${keyword} must be a finite number`);
    }
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[keyword] !== undefined && (!Number.isSafeInteger(schema[keyword]) || schema[keyword] < 0)) {
      fail(`${path}.${keyword} must be a non-negative safe integer`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') fail(`${path}.pattern must be a string`);
    try {
      new RegExp(schema.pattern);
    } catch (error) {
      throw new TypeError(`${path}.pattern must be a valid regular expression: ${error.message}`, { cause: error });
    }
  }
  if (schema.type === 'object') {
    if (!isPlainObject(schema.properties ?? {})) fail(`${path}.properties must be an object`);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      validateSchemaDefinition(child, `${path}.properties.${name}`);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
        fail(`${path}.required must be an array of strings`);
      }
      for (const name of schema.required) {
        if (!Object.hasOwn(schema.properties ?? {}, name)) fail(`${path}.required references unknown property ${name}`);
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties must be boolean`);
    }
  }
  if (schema.type === 'array') {
    if (!schema.items) fail(`${path}.items is required for arrays`);
    validateSchemaDefinition(schema.items, `${path}.items`);
  }
  return immutableJson(schema, path);
}

function valueMatchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(schema, value, path = 'params') {
  if (!valueMatchesType(value, schema.type)) {
    throw new Error(`${path} must be ${schema.type}`);
  }
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${path} must be one of the declared enum values`);
  }
  if ((schema.type === 'number' || schema.type === 'integer')) {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} must be <= ${schema.maximum}`);
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path} is too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} does not match pattern`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`));
  }
  if (schema.type === 'object') {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) throw new Error(`${path}.${name} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[name];
      if (!childSchema) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${name} is not allowed`);
        continue;
      }
      validateValue(childSchema, child, `${path}.${name}`);
    }
  }
}

function normalizeStringList(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`${path} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) fail(`${path} must not be empty`);
  return Object.freeze([...new Set(value)].sort(compareAscii));
}

function normalizeDefinition(input) {
  if (!isPlainObject(input)) fail('Action definition must be an object');
  assertNonEmptyString(input.id, 'Action id');
  if (!ACTION_ID.test(input.id)) fail(`Action id "${input.id}" must be a stable lowercase identifier`);
  const paramsSchema = validateSchemaDefinition(input.paramsSchema);
  if (typeof input.precondition !== 'function') fail(`${input.id}.precondition must be a function`);
  if (typeof input.affects !== 'function') fail(`${input.id}.affects must be a function`);
  if (typeof input.apply !== 'function') fail(`${input.id}.apply must be a function`);
  if (typeof input.reversible !== 'boolean') fail(`${input.id}.reversible must be boolean`);
  if (!isPlainObject(input.describe)) fail(`${input.id}.describe must be an object`);
  assertNonEmptyString(input.describe.title, `${input.id}.describe.title`);
  assertNonEmptyString(input.describe.summary, `${input.id}.describe.summary`);
  const tags = normalizeStringList(input.describe.tags ?? [], `${input.id}.describe.tags`);
  return Object.freeze({
    id: input.id,
    paramsSchema,
    precondition: input.precondition,
    affects: input.affects,
    reversible: input.reversible,
    describe: immutableJson({ ...input.describe, tags }, `${input.id}.describe`),
    apply: input.apply,
  });
}

class ActionRegistry {
  constructor() {
    actionRegistryState.set(this, new Map());
  }

  register(input) {
    const definition = normalizeDefinition(input);
    const actions = actionRegistryState.get(this);
    if (actions.has(definition.id)) throw new Error(`Action ${definition.id} is already registered`);
    actions.set(definition.id, definition);
    return this;
  }

  get(id) {
    return actionRegistryState.get(this).get(id);
  }

  describe(id) {
    const definition = this.get(id);
    if (!definition) throw new Error(`Action ${id} is not registered`);
    return deepFreeze({
      id: definition.id,
      paramsSchema: definition.paramsSchema,
      reversible: definition.reversible,
      ...definition.describe,
    });
  }

  listAvailableActions(context) {
    const available = [];
    for (const definition of [...actionRegistryState.get(this).values()].sort((a, b) => compareAscii(a.id, b.id))) {
      let result;
      try {
        result = definition.precondition(context, {});
      } catch {
        result = false;
      }
      if (result !== true) continue;
      available.push(this.describe(definition.id));
    }
    return Object.freeze(available);
  }
}

export function createActionRegistry() {
  return new ActionRegistry();
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function diffJson(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const beforeObject = before !== null && typeof before === 'object';
  const afterObject = after !== null && typeof after === 'object';
  if (!beforeObject || !afterObject || Array.isArray(before) !== Array.isArray(after)) {
    return [{ op: 'replace', path: path || '/', before: canonicalize(before), after: canonicalize(after) }];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareAscii);
  const changes = [];
  for (const key of keys) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (!Object.hasOwn(before, key)) {
      changes.push({ op: 'add', path: childPath, before: null, after: canonicalize(after[key]) });
    } else if (!Object.hasOwn(after, key)) {
      changes.push({ op: 'remove', path: childPath, before: canonicalize(before[key]), after: null });
    } else {
      changes.push(...diffJson(before[key], after[key], childPath));
    }
  }
  return changes;
}

function worldRecords(envelope) {
  const records = new Map();
  for (const chunk of envelope.chunks) {
    for (const entity of chunk.entities) {
      records.set(entity.id, {
        chunkId: chunk.id,
        components: new Map(entity.components.map((component) => [component.id, component])),
      });
    }
  }
  return records;
}

function worldDiff(beforeEnvelope, afterEnvelope) {
  const before = worldRecords(beforeEnvelope);
  const after = worldRecords(afterEnvelope);
  const entityIds = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  const changes = [];
  for (const entityId of entityIds) {
    const previous = before.get(entityId);
    const next = after.get(entityId);
    const entityPath = `/entities/${entityId}`;
    if (!previous) {
      changes.push({ op: 'add', path: entityPath, before: null, after: { chunkId: next.chunkId } });
      continue;
    }
    if (!next) {
      changes.push({ op: 'remove', path: entityPath, before: { chunkId: previous.chunkId }, after: null });
      continue;
    }
    if (previous.chunkId !== next.chunkId) {
      changes.push({ op: 'replace', path: `${entityPath}/chunk`, before: previous.chunkId, after: next.chunkId });
    }
    const componentIds = [...new Set([...previous.components.keys(), ...next.components.keys()])].sort(compareAscii);
    for (const componentId of componentIds) {
      const previousComponent = previous.components.get(componentId);
      const nextComponent = next.components.get(componentId);
      const componentPath = `${entityPath}/components/${escapePointer(componentId)}`;
      if (!previousComponent) {
        changes.push({ op: 'add', path: componentPath, before: null, after: canonicalize(nextComponent) });
      } else if (!nextComponent) {
        changes.push({ op: 'remove', path: componentPath, before: canonicalize(previousComponent), after: null });
      } else {
        if (previousComponent.version !== nextComponent.version) {
          changes.push({
            op: 'replace',
            path: `${componentPath}/version`,
            before: previousComponent.version,
            after: nextComponent.version,
          });
        }
        changes.push(...diffJson(previousComponent.data, nextComponent.data, `${componentPath}/data`));
      }
    }
  }
  return changes;
}

function effectForChange(change) {
  const parts = change.path.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const entityId = parts[1];
  let effect = `entity:${entityId}`;
  if (parts[2] === 'components') effect += `/component:${parts[3]}`;
  if (parts[4] === 'data' && parts[5] !== undefined) effect += `/field:${parts[5]}`;
  else if (parts[4] === 'version') effect += '/version';
  else if (parts[2] === 'chunk') effect += '/chunk';
  return effect;
}

function globMatches(pattern, value) {
  const source = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${source}$`).test(value);
}

function requestIdentity(request) {
  return JSON.stringify(canonicalize({
    runId: request.runId,
    stepId: request.stepId,
    baseRevision: request.baseRevision,
    beforeRevision: request.beforeRevision,
    idempotencyKey: request.idempotencyKey,
    mode: request.mode ?? 'execute',
    allowedActions: request.allowedActions,
    allowedAffects: request.allowedAffects,
    actions: request.actions,
  }));
}

function normalizeRequest(input) {
  if (!isPlainObject(input)) fail('step request must be an object');
  for (const field of ['runId', 'stepId', 'baseRevision', 'beforeRevision', 'idempotencyKey']) {
    assertNonEmptyString(input[field], `step.${field}`);
  }
  const mode = input.mode ?? 'execute';
  if (mode !== 'execute' && mode !== 'repair') fail('step.mode must be execute or repair');
  const allowedActions = normalizeStringList(input.allowedActions, 'step.allowedActions', { nonEmpty: true });
  const allowedAffects = normalizeStringList(input.allowedAffects, 'step.allowedAffects', { nonEmpty: true });
  if (!Array.isArray(input.actions) || input.actions.length === 0) fail('step.actions must be a non-empty array');
  const actions = input.actions.map((action, index) => {
    if (!isPlainObject(action)) fail(`step.actions[${index}] must be an object`);
    assertNonEmptyString(action.id, `step.actions[${index}].id`);
    if (!isPlainObject(action.params)) fail(`step.actions[${index}].params must be an object`);
    return immutableJson({ id: action.id, params: action.params }, `step.actions[${index}]`);
  });
  if (input.validate !== undefined && typeof input.validate !== 'function') fail('step.validate must be a function');
  return Object.freeze({
    runId: input.runId,
    stepId: input.stepId,
    baseRevision: input.baseRevision,
    beforeRevision: input.beforeRevision,
    idempotencyKey: input.idempotencyKey,
    mode,
    allowedActions,
    allowedAffects,
    actions: Object.freeze(actions),
    validate: input.validate,
  });
}

function failureReceipt(request, revision, code, message, status = 'failed', extra = {}) {
  return deepFreeze({
    runId: request.runId,
    stepId: request.stepId,
    beforeRevision: revision,
    candidateRevision: revision,
    actions: [],
    actualEffects: [],
    validation: [],
    budgetUsed: { actions: 0 },
    status,
    failure: { code, message, ...extra },
  });
}

function failedPreview(engine, request, receipt, identity) {
  const preview = { receipt, phase: 'failed', replayed: false };
  previewState.set(preview, { engine, request, identity, phase: 'failed' });
  return Object.freeze(preview);
}

function assertRegistry(registry) {
  if (!actionRegistryState.has(registry)) fail('registry must come from createActionRegistry()');
}

function assertEngine(engine) {
  const state = engineState.get(engine);
  if (!state || state.destroyed) throw new Error('Action engine has been destroyed');
  return state;
}

async function envelopeFor(state, world = state.world) {
  return createWorldEnvelope(world, state.serializationOptions);
}

async function cloneEnvelope(state, envelope) {
  return loadWorldEnvelope(envelope, { runtimeRegistry: state.runtimeRegistry });
}

class ActionEngine {
  get world() {
    return assertEngine(this).world;
  }

  get revision() {
    return assertEngine(this).revision;
  }

  get checkpoints() {
    return assertEngine(this).checkpoints;
  }

  get canUndo() {
    return assertEngine(this).undo.length > 0;
  }

  changeLog() {
    return Object.freeze([...assertEngine(this).log]);
  }

  async previewStep(input) {
    const state = assertEngine(this);
    const request = normalizeRequest(input);
    const identity = requestIdentity(request);
    const prior = state.idempotency.get(request.idempotencyKey);
    if (prior) {
      if (prior.identity !== identity || prior.validate !== request.validate) {
        throw new Error(`idempotency key ${request.idempotencyKey} was reused for a different request`);
      }
      return Object.freeze({ ...prior.result, replayed: true });
    }

    const actualEnvelope = await envelopeFor(state);
    const run = state.runs.get(request.runId);
    const expectedRevision = run?.lastRevision ?? request.baseRevision;
    const requestExpected = run ? request.beforeRevision : request.baseRevision;
    if (request.beforeRevision !== expectedRevision
      || requestExpected !== expectedRevision
      || actualEnvelope.revision !== expectedRevision) {
      const receipt = failureReceipt(
        request,
        actualEnvelope.revision,
        'revision-conflict',
        `expected revision ${expectedRevision}, received request ${request.beforeRevision} and world ${actualEnvelope.revision}`,
        'needs-review'
      );
      const result = failedPreview(this, request, receipt, identity);
      state.idempotency.set(request.idempotencyKey, { identity, validate: request.validate, result });
      return result;
    }

    for (const action of request.actions) {
      if (!request.allowedActions.includes(action.id)) {
        const receipt = failureReceipt(
          request,
          actualEnvelope.revision,
          'action-not-allowed',
          `Action ${action.id} is outside this step's approved allowedActions`,
          'needs-review'
        );
        const result = failedPreview(this, request, receipt, identity);
        state.idempotency.set(request.idempotencyKey, { identity, validate: request.validate, result });
        return result;
      }
    }

    let loaded;
    try {
      loaded = await cloneEnvelope(state, actualEnvelope);
      const candidate = loaded.world;
      let previousEnvelope = loaded.envelope;
      const actionReceipts = [];
      const actualEffects = new Set();
      let allReversible = true;

      for (const [index, action] of request.actions.entries()) {
        const definition = state.registry.get(action.id);
        if (!definition) throw new Error(`Action ${action.id} is not registered`);
        validateValue(definition.paramsSchema, action.params, `actions[${index}].params`);
        const context = Object.freeze({ world: candidate, mode: request.mode, runId: request.runId, stepId: request.stepId });
        const precondition = await definition.precondition(context, action.params);
        if (precondition !== true) {
          const feedback = isPlainObject(precondition) ? canonicalize(precondition) : {};
          const error = new Error(`Action ${action.id} precondition failed`);
          error.code = 'precondition-failed';
          error.feedback = feedback;
          throw error;
        }
        const declaredAffects = normalizeStringList(
          await definition.affects(context, action.params),
          `${action.id}.affects`,
          { nonEmpty: true }
        );
        const outOfScope = declaredAffects.find((affect) => !request.allowedAffects.some((allowed) => globMatches(allowed, affect)));
        if (outOfScope) {
          const receipt = failureReceipt(
            request,
            actualEnvelope.revision,
            'affect-not-allowed',
            `Action ${action.id} declares affect ${outOfScope} outside this step's approved affects`,
            'needs-review'
          );
          candidate.destroy();
          const result = failedPreview(this, request, receipt, identity);
          state.idempotency.set(request.idempotencyKey, { identity, validate: request.validate, result });
          return result;
        }

        await definition.apply(context, action.params);
        const nextEnvelope = await envelopeFor(state, candidate);
        const diff = worldDiff(previousEnvelope, nextEnvelope);
        const effects = [...new Set(diff.map(effectForChange))].sort(compareAscii);
        const unexpected = effects.find((effect) => !declaredAffects.some((affect) => globMatches(affect, effect)));
        if (unexpected) {
          const error = new Error(`Action ${action.id} changed undeclared affect ${unexpected}`);
          error.code = 'undeclared-affect';
          throw error;
        }
        for (const effect of effects) actualEffects.add(effect);
        actionReceipts.push(deepFreeze({
          id: action.id,
          params: action.params,
          affects: effects,
          reversible: definition.reversible,
          diff: deepFreeze(diff),
        }));
        allReversible &&= definition.reversible;
        previousEnvelope = nextEnvelope;
      }

      const validation = request.validate
        ? immutableJson(await request.validate({ world: candidate, receipt: actionReceipts }), 'validation')
        : Object.freeze([]);
      if (!Array.isArray(validation)) fail('step validation must return an array');
      const hardFailure = validation.find((result) => result?.severity === 'hard' && result?.status !== 'passed');
      const receipt = deepFreeze({
        runId: request.runId,
        stepId: request.stepId,
        beforeRevision: actualEnvelope.revision,
        candidateRevision: previousEnvelope.revision,
        actions: actionReceipts,
        actualEffects: [...actualEffects].sort(compareAscii),
        validation,
        budgetUsed: { actions: request.actions.length },
        status: hardFailure ? 'failed' : 'passed',
        ...(hardFailure ? { failure: { code: 'hard-validation-failed', message: `hard validation ${hardFailure.id ?? 'unknown'} failed` } } : {}),
      });
      if (hardFailure) {
        candidate.destroy();
        const result = failedPreview(this, request, receipt, identity);
        state.idempotency.set(request.idempotencyKey, { identity, validate: request.validate, result });
        return result;
      }

      const preview = { receipt, phase: 'previewed', replayed: false };
      const details = {
        engine: this,
        request,
        identity,
        phase: 'previewed',
        candidate,
        candidateEnvelope: previousEnvelope,
        beforeEnvelope: actualEnvelope,
        allReversible,
      };
      previewState.set(preview, details);
      state.activePreviews.add(details);
      const result = Object.freeze(preview);
      state.idempotency.set(request.idempotencyKey, { identity, validate: request.validate, result });
      return result;
    } catch (error) {
      loaded?.world?.destroy();
      const receipt = failureReceipt(
        request,
        actualEnvelope.revision,
        error.code ?? 'action-failed',
        error.message,
        error.code === 'undeclared-affect' ? 'needs-review' : 'failed',
        error.feedback ? { feedback: error.feedback } : {}
      );
      const result = failedPreview(this, request, receipt, identity);
      state.idempotency.set(request.idempotencyKey, { identity, validate: request.validate, result });
      return result;
    }
  }

  async commit(preview) {
    const state = assertEngine(this);
    if (preview?.replayed === true) {
      if (preview.phase === 'committed' && preview.commitResult) return preview.commitResult;
      throw new Error(`cannot commit a ${preview.phase} preview`);
    }
    const details = previewState.get(preview);
    if (!details || details.engine !== this) fail('preview does not belong to this Action engine');
    if (details.phase === 'committed') return details.commitResult;
    if (details.phase !== 'previewed' || preview.receipt.status !== 'passed') {
      throw new Error(`cannot commit a ${preview.receipt.status} preview`);
    }
    const current = await envelopeFor(state);
    if (current.revision !== preview.receipt.beforeRevision) {
      throw new Error(`cannot commit after revision conflict: expected ${preview.receipt.beforeRevision}, received ${current.revision}`);
    }

    const checkpoint = `${details.request.runId}/${details.request.stepId}/${preview.receipt.candidateRevision}`;
    await state.checkpoints.save(checkpoint, details.candidate, state.serializationOptions);
    const previousWorld = state.world;
    state.world = details.candidate;
    state.revision = details.candidateEnvelope.revision;
    state.runs.set(details.request.runId, {
      baseRevision: state.runs.get(details.request.runId)?.baseRevision ?? details.request.baseRevision,
      lastRevision: state.revision,
    });
    if (details.allReversible) {
      state.undo.push({ envelope: details.beforeEnvelope, receipt: preview.receipt });
    }
    previousWorld.destroy();
    details.phase = 'committed';
    state.activePreviews.delete(details);
    const result = deepFreeze({ receipt: preview.receipt, checkpoint });
    details.commitResult = result;
    state.log.push(deepFreeze({ kind: 'commit', checkpoint, receipt: preview.receipt }));
    const idempotency = state.idempotency.get(details.request.idempotencyKey);
    idempotency.result = Object.freeze({
      receipt: preview.receipt,
      phase: 'committed',
      replayed: false,
      commitResult: result,
    });
    return result;
  }

  abort(preview) {
    assertEngine(this);
    const details = previewState.get(preview);
    if (!details || details.engine !== this) fail('preview does not belong to this Action engine');
    if (details.phase !== 'previewed') throw new Error(`cannot abort a ${details.phase} preview`);
    details.candidate.destroy();
    details.phase = 'cancelled';
    const state = assertEngine(this);
    state.activePreviews.delete(details);
    const receipt = deepFreeze({ ...preview.receipt, status: 'cancelled' });
    const idempotency = state.idempotency.get(details.request.idempotencyKey);
    idempotency.result = Object.freeze({ receipt, phase: 'cancelled', replayed: false });
    return receipt;
  }

  async undo() {
    const state = assertEngine(this);
    const entry = state.undo.at(-1);
    if (!entry) throw new Error('there is no reversible step to undo');
    const restored = await cloneEnvelope(state, entry.envelope);
    state.undo.pop();
    const previous = state.world;
    state.world = restored.world;
    state.revision = restored.revision;
    previous.destroy();
    const result = deepFreeze({ revision: state.revision, undone: entry.receipt });
    state.log.push(deepFreeze({ kind: 'undo', ...result }));
    return result;
  }

  destroy() {
    const state = assertEngine(this);
    for (const preview of state.activePreviews) preview.candidate.destroy();
    state.activePreviews.clear();
    state.world.destroy();
    state.destroyed = true;
  }
}

export async function createActionEngine({
  registry,
  world,
  runtimes,
  runtimeRegistry,
  chunkForEntity = () => 'main',
  chunkPayloads = {},
} = {}) {
  assertRegistry(registry);
  if (!world || typeof world.query !== 'function' || typeof world.destroy !== 'function') {
    fail('world must come from createWorld()');
  }
  if (!runtimeRegistry || typeof runtimeRegistry.resolve !== 'function') {
    fail('runtimeRegistry must come from createRuntimeRegistry()');
  }
  if (typeof chunkForEntity !== 'function') fail('chunkForEntity must be a function');
  const normalizedChunkPayloads = chunkPayloads instanceof Map
    ? new Map([...chunkPayloads.entries()].map(([id, payload]) => [id, immutableJson(payload, `chunkPayloads.${id}`)]))
    : immutableJson(chunkPayloads, 'chunkPayloads');
  const serializationOptions = Object.freeze({
    runtimes: Object.freeze(runtimes.map((runtime) => Object.freeze({ ...runtime }))),
    chunkForEntity,
    chunkPayloads: normalizedChunkPayloads,
  });
  const initialEnvelope = await createWorldEnvelope(world, serializationOptions);
  const checkpoints = createCheckpointStore({ runtimeRegistry });
  const engine = new ActionEngine();
  engineState.set(engine, {
    registry,
    world,
    runtimes: serializationOptions.runtimes,
    serializationOptions,
    runtimeRegistry,
    checkpoints,
    revision: initialEnvelope.revision,
    runs: new Map(),
    idempotency: new Map(),
    undo: [],
    log: [],
    activePreviews: new Set(),
    destroyed: false,
  });
  return engine;
}
