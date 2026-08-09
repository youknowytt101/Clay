/**
 * M1-d headless 试飞台与 TestSpec 验收。
 *
 * @package M1-d
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionEngine, createActionRegistry } from '../src/core/actions.js';
import { createWorld, defineComponent } from '../src/core/ecs.js';
import {
  createCheckpointStore,
  createRuntimeRegistry,
} from '../src/core/serialization.js';
import {
  createHeadlessTestbed,
  createOracleRegistry,
  createTestSpecRegistry,
} from '../src/core/testbed.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/sim/world.js';

const Probe = defineComponent({
  id: 'test.testbed.probe',
  version: 1,
  schema: {
    value: { type: 'number', default: 0 },
    steps: { type: 'number', default: 0, min: 0 },
  },
});

const VALUE_AFFECT = 'entity:*/component:test.testbed.probe/field:value';

function runtimes() {
  return [PHYSICS_RUNTIME_REQUIREMENT];
}

function runtimeRegistry() {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    { name: 'testbed-rapier' }
  );
}

function entityById(world, id) {
  return world.query(Probe).map((entity) => entity).find((entity) => entity.id === id);
}

function probeWorld(value = 0) {
  const world = createWorld();
  world.spawn(Probe({ value }));
  return world;
}

function stateSpec(overrides = {}) {
  return {
    id: 'test.probe-state',
    kind: 'state',
    oracle: { id: 'test.value-equals', params: { entityId: 1, value: 3 } },
    seed: 7,
    covers: [VALUE_AFFECT],
    timeoutTicks: 2,
    severity: 'hard',
    ...overrides,
  };
}

function oracleRegistry() {
  return createOracleRegistry()
    .register('test.value-equals', ({ world, oracle }) => {
      const observed = entityById(world, oracle.params.entityId)?.get(Probe).value ?? null;
      return {
        pass: observed === oracle.params.value,
        observed,
        expected: oracle.params.value,
      };
    })
    .register('test.observe-value', ({ world, oracle }) => ({
      pass: true,
      observed: entityById(world, oracle.params.entityId)?.get(Probe).value ?? null,
    }));
}

function intentDriver({ items }) {
  return {
    beforeTick({ world, tick, log }) {
      for (const item of items) {
        if (item.at !== tick) continue;
        entityById(world, item.entityId).set(Probe, { value: item.value });
        log({ intent: item.intent, entityId: item.entityId, value: item.value });
      }
    },
  };
}

function createTestbed(options = {}) {
  return createHeadlessTestbed({
    runtimeRegistry: runtimeRegistry(),
    oracles: oracleRegistry(),
    inputDrivers: { intent: intentDriver },
    step: ({ world, rng, log }) => {
      for (const entity of world.query(Probe)) {
        const probe = entity.get(Probe);
        entity.set(Probe, { steps: probe.steps + 1 });
      }
      log({ rng: rng.uint32() });
    },
    ...options,
  });
}

// @covers ADR-003:3.2 ADR-003:3.2.1 M1-d:testspec-registry
test('TestSpec registry 冻结权威字段，并拒绝空 covers 与未批准的 hard visual', () => {
  const registry = createTestSpecRegistry().register(stateSpec());
  assert.throws(() => registry.register(stateSpec()), /already registered/);
  assert.throws(
    () => createTestSpecRegistry().register(stateSpec({ id: 'test.empty-covers', covers: [] })),
    /covers must not be empty/
  );
  assert.throws(
    () => createTestSpecRegistry().register(stateSpec({ id: 'test.hard-visual', kind: 'visual' })),
    /visual TestSpec must be soft/
  );

  const device = stateSpec({
    id: 'test.device-interaction',
    kind: 'interaction',
    inputTrace: { layer: 'device', events: [{ vendorPayload: { x: 12, y: 4 } }] },
  });
  registry.register(device);
  assert.deepEqual(registry.list().map((spec) => spec.id), ['test.device-interaction', 'test.probe-state']);
  assert.equal(Object.isFrozen(registry.get('test.device-interaction').inputTrace.events[0]), true);
});

// @covers ADR-003:3.2.2 U-044 M1-d:regression-selection
test('回归集由引擎按 covers 与实际 affects 求交，调用方只能建议扩大', () => {
  const registry = createTestSpecRegistry()
    .register(stateSpec())
    .register(stateSpec({ id: 'test.unrelated', covers: ['system:ui'] }))
    .register(stateSpec({ id: 'test.suggested', covers: ['system:audio'] }));

  assert.deepEqual(
    registry.selectRegressionTests(['entity:1/component:test.testbed.probe/field:value']).map((spec) => spec.id),
    ['test.probe-state']
  );
  assert.deepEqual(
    registry.selectRegressionTests(
      ['entity:1/component:test.testbed.probe/field:value'],
      { suggestedIds: ['test.suggested'] }
    ).map((spec) => spec.id),
    ['test.probe-state', 'test.suggested']
  );
  assert.throws(
    () => registry.selectRegressionTests([], { suggestedIds: ['test.missing'] }),
    /not registered/
  );
});

// @covers I7 I11 决策29 ADR-003:P3 ADR-003:P5 M1-d:deterministic-evidence meta:oracle-sensitivity
test('相同 checkpoint、TestSpec 与 seed 产生逐字节相同证据，改变 seed 能被检出', async () => {
  const testbed = createTestbed({
    step: ({ world, rng, log }) => {
      const value = rng.uint32();
      entityById(world, 1).set(Probe, { value });
      log({ value });
    },
  });
  const world = probeWorld();
  const spec = stateSpec({
    oracle: { id: 'test.observe-value', params: { entityId: 1 } },
    timeoutTicks: 1,
  });

  const a = await testbed.run(spec, { world, runtimes: runtimes() });
  const b = await testbed.run(spec, { world, runtimes: runtimes() });
  const planted = await testbed.run({ ...spec, seed: 8 }, { world, runtimes: runtimes() });
  assert.deepEqual(a, b);
  assert.notEqual(a.evidence.finalRevision, planted.evidence.finalRevision, '负例必须让证据检出 seed 差异');
  assert.equal(entityById(world, 1).get(Probe).value, 0, '试飞台不得污染源世界');
  assert.equal(JSON.stringify(a).includes('timestamp'), false);
  world.destroy();
});

// @covers I7 I12 ADR-003:3.2.1 M1-d:input-trace M1-d:fixed-ticks
test('意图轨迹由适配器解释，按固定 tick 执行且保留结构化日志', async () => {
  const testbed = createTestbed();
  const world = probeWorld();
  const spec = stateSpec({
    inputTrace: {
      layer: 'intent',
      intents: [{ at: 0, intent: 'set-probe', entityId: 1, value: 3 }],
    },
  });
  const result = await testbed.run(spec, { world, runtimes: runtimes() });

  assert.equal(result.status, 'passed');
  assert.equal(result.evidence.ticks, 2);
  assert.deepEqual(result.evidence.inputTrace, spec.inputTrace);
  assert.deepEqual(result.evidence.oracle, { pass: true, observed: 3, expected: 3 });
  assert.deepEqual(result.evidence.logs[0], {
    tick: 0,
    source: 'input',
    data: { intent: 'set-probe', entityId: 1, value: 3 },
  });
  world.destroy();
});

// @covers I7 I11 M1-c:checkpoint M1-d:checkpoint-load
test('可从命名 checkpoint 独立加载运行，原 checkpoint 保持不可变', async () => {
  const registry = runtimeRegistry();
  const checkpoints = createCheckpointStore({ runtimeRegistry: registry });
  const world = probeWorld(3);
  await checkpoints.save('baseline', world, { runtimes: runtimes() });
  world.destroy();
  const testbed = createHeadlessTestbed({
    runtimeRegistry: registry,
    oracles: oracleRegistry(),
  });

  const result = await testbed.runFromCheckpoint(stateSpec({ timeoutTicks: 0 }), {
    checkpointStore: checkpoints,
    checkpoint: 'baseline',
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.evidence.checkpoint, 'baseline');

  const restored = await checkpoints.restore('baseline');
  assert.equal(entityById(restored.world, 1).get(Probe).value, 3);
  restored.world.destroy();
});

// @covers I2 ADR-003:P3 M1-d:hard-soft M1-d:suite
test('suite 以 hard oracle 决定通过，soft 失败只进入证据且执行顺序稳定', async () => {
  const testbed = createTestbed();
  const world = probeWorld(3);
  const hardPass = stateSpec({ id: 'test.b-hard-pass', timeoutTicks: 0 });
  const softFail = stateSpec({
    id: 'test.a-soft-fail',
    oracle: { id: 'test.value-equals', params: { entityId: 1, value: 99 } },
    timeoutTicks: 0,
    severity: 'soft',
  });
  const suite = await testbed.runSuite([hardPass, softFail], { world, runtimes: runtimes() });
  assert.equal(suite.status, 'passed');
  assert.deepEqual(suite.results.map((result) => result.specId), ['test.a-soft-fail', 'test.b-hard-pass']);
  assert.deepEqual(suite.softFailures, ['test.a-soft-fail']);

  const hardFail = { ...softFail, id: 'test.c-hard-fail', severity: 'hard' };
  const failed = await testbed.runSuite([hardPass, hardFail], { world, runtimes: runtimes() });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.hardFailures, ['test.c-hard-fail']);
  world.destroy();
});

// @covers I2 I7 ADR-003:P2 ADR-003:P3 M1-b:preview-commit-abort M1-d:action-gate
test('M1-d validator 让 hard 失败直接阻止 M1-b commit，成功时才允许提交', async () => {
  const actions = createActionRegistry().register({
    id: 'test.set-probe',
    paramsSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    precondition: () => true,
    affects: () => [VALUE_AFFECT],
    reversible: true,
    describe: { title: 'Set probe', summary: 'Set the probe value.', tags: ['test'] },
    apply: ({ world }, params) => entityById(world, 1).set(Probe, { value: params.value }),
  });
  const world = probeWorld();
  const engine = await createActionEngine({
    registry: actions,
    world,
    runtimes: runtimes(),
    runtimeRegistry: runtimeRegistry(),
  });
  const testbed = createTestbed();
  const baseRequest = {
    runId: 'testbed-run',
    stepId: 'set-probe',
    baseRevision: engine.revision,
    beforeRevision: engine.revision,
    allowedActions: ['test.set-probe'],
    allowedAffects: [VALUE_AFFECT],
    actions: [{ id: 'test.set-probe', params: { value: 3 } }],
  };

  const rejected = await engine.previewStep({
    ...baseRequest,
    idempotencyKey: 'testbed/rejected',
    validate: testbed.asValidator([
      stateSpec({ oracle: { id: 'test.value-equals', params: { entityId: 1, value: 99 } }, timeoutTicks: 0 }),
    ], { runtimes: runtimes() }),
  });
  assert.equal(rejected.receipt.status, 'failed');
  assert.equal(entityById(engine.world, 1).get(Probe).value, 0);

  const accepted = await engine.previewStep({
    ...baseRequest,
    idempotencyKey: 'testbed/accepted',
    validate: testbed.asValidator([stateSpec({ timeoutTicks: 0 })], { runtimes: runtimes() }),
  });
  assert.equal(accepted.receipt.status, 'passed');
  await engine.commit(accepted);
  assert.equal(entityById(engine.world, 1).get(Probe).value, 3);
  engine.destroy();
});

// @covers I2 ADR-003:P3 M1-d:structured-failure
test('缺失输入适配器或 oracle 时返回结构化失败，不伪装成通过', async () => {
  const world = probeWorld();
  const noDrivers = createHeadlessTestbed({
    runtimeRegistry: runtimeRegistry(),
    oracles: oracleRegistry(),
  });
  const missingDriver = await noDrivers.run(stateSpec({
    inputTrace: { layer: 'device', events: [{ opaque: true }] },
  }), { world, runtimes: runtimes() });
  assert.equal(missingDriver.status, 'failed');
  assert.equal(missingDriver.failure.code, 'input-driver-missing');

  const noOracles = createHeadlessTestbed({ runtimeRegistry: runtimeRegistry() });
  const missingOracle = await noOracles.run(stateSpec(), { world, runtimes: runtimes() });
  assert.equal(missingOracle.status, 'failed');
  assert.equal(missingOracle.failure.code, 'oracle-missing');

  const mutatingOracles = createOracleRegistry().register('test.mutating-oracle', ({ world }) => {
    entityById(world, 1).set(Probe, { value: 3 });
    return { pass: true };
  });
  const mutating = createHeadlessTestbed({
    runtimeRegistry: runtimeRegistry(),
    oracles: mutatingOracles,
  });
  const falsePass = await mutating.run(stateSpec({
    oracle: { id: 'test.mutating-oracle' },
    timeoutTicks: 0,
  }), { world, runtimes: runtimes() });
  assert.equal(falsePass.status, 'failed');
  assert.equal(falsePass.failure.code, 'oracle-mutated-world');
  assert.equal(entityById(world, 1).get(Probe).value, 0);
  world.destroy();
});
