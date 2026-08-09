import {
  createWorldEnvelope,
  loadWorldEnvelope,
} from './serialization.js';

const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const TEST_KINDS = new Set(['schema', 'constraint', 'state', 'interaction', 'visual']);
const TEST_SEVERITIES = new Set(['hard', 'soft']);
const INPUT_LAYERS = new Set(['intent', 'device']);
const testSpecRegistryState = new WeakMap();
const oracleRegistryState = new WeakMap();
const testbedState = new WeakMap();

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

function assertStableId(value, path) {
  assertNonEmptyString(value, path);
  if (!STABLE_ID.test(value)) fail(`${path} must be a stable lowercase identifier`);
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

function normalizeStringList(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`${path} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) fail(`${path} must not be empty`);
  return Object.freeze([...new Set(value)].sort(compareAscii));
}

function normalizeInputTrace(input, path) {
  if (input === undefined) return undefined;
  if (!isPlainObject(input) || !INPUT_LAYERS.has(input.layer)) {
    fail(`${path} must declare intent or device layer`);
  }
  const field = input.layer === 'intent' ? 'intents' : 'events';
  if (!Array.isArray(input[field])) fail(`${path}.${field} must be an array`);
  return immutableJson({ layer: input.layer, [field]: input[field] }, path);
}

function normalizeTestSpec(input) {
  if (!isPlainObject(input)) fail('TestSpec must be an object');
  assertStableId(input.id, 'TestSpec.id');
  if (!TEST_KINDS.has(input.kind)) fail(`TestSpec.kind ${String(input.kind)} is not supported`);
  if (!isPlainObject(input.oracle)) fail('TestSpec.oracle must be an object');
  assertStableId(input.oracle.id, 'TestSpec.oracle.id');
  if (!TEST_SEVERITIES.has(input.severity)) fail('TestSpec.severity must be hard or soft');
  if (input.kind === 'visual' && input.severity === 'hard') {
    fail('visual TestSpec must be soft until an explicit decidable-oracle approval path exists');
  }
  const seed = input.seed ?? 0;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    fail('TestSpec.seed must be an unsigned 32-bit integer');
  }
  const timeoutTicks = input.timeoutTicks ?? 0;
  if (!Number.isSafeInteger(timeoutTicks) || timeoutTicks < 0) {
    fail('TestSpec.timeoutTicks must be a non-negative safe integer');
  }
  const normalized = {
    id: input.id,
    kind: input.kind,
    oracle: immutableJson(input.oracle, 'TestSpec.oracle'),
    seed,
    covers: normalizeStringList(input.covers, 'TestSpec.covers', { nonEmpty: true }),
    timeoutTicks,
    severity: input.severity,
  };
  const inputTrace = normalizeInputTrace(input.inputTrace, 'TestSpec.inputTrace');
  if (inputTrace) normalized.inputTrace = inputTrace;
  return Object.freeze(normalized);
}

function globMatches(pattern, value) {
  const source = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${source}$`).test(value);
}

class TestSpecRegistry {
  constructor() {
    testSpecRegistryState.set(this, new Map());
  }

  register(input) {
    const spec = normalizeTestSpec(input);
    const specs = testSpecRegistryState.get(this);
    if (specs.has(spec.id)) throw new Error(`TestSpec ${spec.id} is already registered`);
    specs.set(spec.id, spec);
    return this;
  }

  get(id) {
    return testSpecRegistryState.get(this).get(id);
  }

  list() {
    return Object.freeze([...testSpecRegistryState.get(this).values()].sort((a, b) => compareAscii(a.id, b.id)));
  }

  selectRegressionTests(actualEffects, { suggestedIds = [] } = {}) {
    const effects = normalizeStringList(actualEffects, 'actualEffects');
    const suggestions = normalizeStringList(suggestedIds, 'suggestedIds');
    const selected = new Set();
    for (const spec of testSpecRegistryState.get(this).values()) {
      if (spec.covers.some((cover) => effects.some((effect) => globMatches(cover, effect)))) {
        selected.add(spec.id);
      }
    }
    for (const id of suggestions) {
      if (!this.get(id)) throw new Error(`suggested TestSpec ${id} is not registered`);
      selected.add(id);
    }
    return Object.freeze([...selected].sort(compareAscii).map((id) => this.get(id)));
  }
}

export function createTestSpecRegistry() {
  return new TestSpecRegistry();
}

class OracleRegistry {
  constructor() {
    oracleRegistryState.set(this, new Map());
  }

  register(id, evaluate) {
    assertStableId(id, 'oracle id');
    if (typeof evaluate !== 'function') fail(`${id} evaluator must be a function`);
    const oracles = oracleRegistryState.get(this);
    if (oracles.has(id)) throw new Error(`oracle ${id} is already registered`);
    oracles.set(id, evaluate);
    return this;
  }

  get(id) {
    return oracleRegistryState.get(this).get(id);
  }
}

export function createOracleRegistry() {
  return new OracleRegistry();
}

function createRng(seed) {
  let state = seed >>> 0;
  function uint32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
  return Object.freeze({
    uint32,
    next: () => uint32() / 0x100000000,
  });
}

function testbedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertTestbed(testbed) {
  const state = testbedState.get(testbed);
  if (!state) fail('testbed must come from createHeadlessTestbed()');
  return state;
}

function chunkMap(envelope) {
  const chunks = new Map();
  for (const chunk of envelope.chunks) {
    for (const entity of chunk.entities) chunks.set(entity.id, chunk.id);
  }
  return chunks;
}

function traceItems(trace) {
  if (!trace) return [];
  return trace.layer === 'intent' ? trace.intents : trace.events;
}

function structuredFailure(error) {
  return deepFreeze({
    code: error.code ?? 'runner-failed',
    message: error.message,
  });
}

class HeadlessTestbed {
  async run(inputSpec, {
    world,
    runtimes,
    chunkForEntity = () => 'main',
    chunkPayloads = {},
    checkpoint = null,
  } = {}) {
    const state = assertTestbed(this);
    const spec = normalizeTestSpec(inputSpec);
    if (!world || typeof world.query !== 'function' || typeof world.destroy !== 'function') {
      fail('world must come from createWorld()');
    }
    if (!Array.isArray(runtimes)) fail('runtimes must be an array');
    if (typeof chunkForEntity !== 'function') fail('chunkForEntity must be a function');

    const sourceEnvelope = await createWorldEnvelope(world, { runtimes, chunkForEntity, chunkPayloads });
    const loaded = await loadWorldEnvelope(sourceEnvelope, { runtimeRegistry: state.runtimeRegistry });
    const sandbox = loaded.world;
    const originalChunks = chunkMap(sourceEnvelope);
    const snapshotOptions = {
      runtimes: sourceEnvelope.runtimes,
      chunkForEntity: (entity) => originalChunks.get(entity.id) ?? chunkForEntity(entity),
      chunkPayloads: loaded.chunkPayloads,
    };
    const rng = createRng(spec.seed);
    const logs = [];
    let tick = -1;
    let oracleEvidence;
    let failure;

    function log(source, data) {
      logs.push(deepFreeze({ tick, source, data: immutableJson(data, `log.${source}`) }));
    }

    try {
      let controller;
      if (spec.inputTrace) {
        const factory = state.inputDrivers[spec.inputTrace.layer];
        if (!factory) {
          throw testbedError(
            'input-driver-missing',
            `no ${spec.inputTrace.layer} input driver is registered`
          );
        }
        controller = await factory({
          items: traceItems(spec.inputTrace),
          trace: spec.inputTrace,
          spec,
          seed: spec.seed,
        });
        if (!controller || typeof controller.beforeTick !== 'function') {
          throw testbedError('input-driver-invalid', `${spec.inputTrace.layer} input driver must return beforeTick()`);
        }
      }

      for (tick = 0; tick < spec.timeoutTicks; tick++) {
        if (controller) {
          await controller.beforeTick({
            world: sandbox,
            tick,
            rng,
            log: (data) => log('input', data),
          });
        }
        await state.step({
          world: sandbox,
          tick,
          rng,
          log: (data) => log('step', data),
        });
      }
      tick = spec.timeoutTicks;

      const evaluate = state.oracles.get(spec.oracle.id);
      if (!evaluate) throw testbedError('oracle-missing', `oracle ${spec.oracle.id} is not registered`);
      const beforeOracle = await createWorldEnvelope(sandbox, snapshotOptions);
      const outcome = await evaluate({
        world: sandbox,
        oracle: spec.oracle,
        spec,
        rng,
        log: (data) => log('oracle', data),
      });
      const afterOracle = await createWorldEnvelope(sandbox, snapshotOptions);
      if (afterOracle.revision !== beforeOracle.revision) {
        throw testbedError('oracle-mutated-world', `oracle ${spec.oracle.id} mutated the verified world`);
      }
      if (!isPlainObject(outcome) || typeof outcome.pass !== 'boolean') {
        throw testbedError('oracle-invalid', `oracle ${spec.oracle.id} must return { pass: boolean }`);
      }
      oracleEvidence = immutableJson(outcome, 'oracle result');
      if (!outcome.pass) {
        failure = deepFreeze({ code: 'oracle-failed', message: `oracle ${spec.oracle.id} failed` });
      }
    } catch (error) {
      failure = structuredFailure(error);
    }

    let finalEnvelope;
    try {
      finalEnvelope = await createWorldEnvelope(sandbox, snapshotOptions);
    } finally {
      sandbox.destroy();
    }

    const evidence = deepFreeze({
      checkpoint,
      sourceRevision: sourceEnvelope.revision,
      finalRevision: finalEnvelope.revision,
      seed: spec.seed,
      ticks: Math.max(0, Math.min(tick, spec.timeoutTicks)),
      inputTrace: spec.inputTrace ?? null,
      logs,
      oracle: oracleEvidence ?? null,
    });
    return deepFreeze({
      specId: spec.id,
      kind: spec.kind,
      severity: spec.severity,
      status: failure ? 'failed' : 'passed',
      evidence,
      ...(failure ? { failure } : {}),
    });
  }

  async runSuite(inputSpecs, context) {
    assertTestbed(this);
    if (!Array.isArray(inputSpecs) || inputSpecs.length === 0) fail('suite must contain at least one TestSpec');
    const specs = inputSpecs.map(normalizeTestSpec).sort((a, b) => compareAscii(a.id, b.id));
    const ids = new Set();
    for (const spec of specs) {
      if (ids.has(spec.id)) fail(`suite contains duplicate TestSpec ${spec.id}`);
      ids.add(spec.id);
    }
    const results = [];
    for (const spec of specs) results.push(await this.run(spec, context));
    const hardFailures = results
      .filter((result) => result.status === 'failed' && result.severity === 'hard')
      .map((result) => result.specId);
    const softFailures = results
      .filter((result) => result.status === 'failed' && result.severity === 'soft')
      .map((result) => result.specId);
    return deepFreeze({
      status: hardFailures.length === 0 ? 'passed' : 'failed',
      results,
      hardFailures,
      softFailures,
    });
  }

  asValidator(specs, context) {
    assertTestbed(this);
    if (!Array.isArray(specs) || specs.length === 0) fail('validator must contain at least one TestSpec');
    const normalized = Object.freeze(specs.map(normalizeTestSpec));
    return async ({ world }) => {
      const suite = await this.runSuite(normalized, { ...context, world });
      return suite.results.map((result) => deepFreeze({
        id: result.specId,
        severity: result.severity,
        status: result.status,
        evidence: result.evidence,
        ...(result.failure ? { failure: result.failure } : {}),
      }));
    };
  }

  async runFromCheckpoint(spec, { checkpointStore, checkpoint } = {}) {
    assertTestbed(this);
    if (!checkpointStore || typeof checkpointStore.restore !== 'function') {
      fail('checkpointStore must come from createCheckpointStore()');
    }
    assertNonEmptyString(checkpoint, 'checkpoint');
    const restored = await checkpointStore.restore(checkpoint);
    const existingChunks = chunkMap(restored.envelope);
    try {
      return await this.run(spec, {
        world: restored.world,
        runtimes: restored.envelope.runtimes,
        chunkForEntity: (entity) => existingChunks.get(entity.id) ?? 'main',
        chunkPayloads: restored.chunkPayloads,
        checkpoint,
      });
    } finally {
      restored.world.destroy();
    }
  }
}

export function createHeadlessTestbed({
  runtimeRegistry,
  oracles = createOracleRegistry(),
  inputDrivers = {},
  step = () => {},
} = {}) {
  if (!runtimeRegistry || typeof runtimeRegistry.resolve !== 'function') {
    fail('runtimeRegistry must come from createRuntimeRegistry()');
  }
  if (!oracleRegistryState.has(oracles)) fail('oracles must come from createOracleRegistry()');
  if (!isPlainObject(inputDrivers)) fail('inputDrivers must be an object');
  for (const [layer, driver] of Object.entries(inputDrivers)) {
    if (!INPUT_LAYERS.has(layer)) fail(`input driver layer ${layer} is not supported`);
    if (typeof driver !== 'function') fail(`${layer} input driver must be a function`);
  }
  if (typeof step !== 'function') fail('step must be a function');
  const testbed = new HeadlessTestbed();
  testbedState.set(testbed, {
    runtimeRegistry,
    oracles,
    inputDrivers: Object.freeze({ ...inputDrivers }),
    step,
  });
  return testbed;
}
