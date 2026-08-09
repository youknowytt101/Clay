/**
 * M1-b Action Registry 与步骤事务验收。
 *
 * @package M1-b
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionEngine, createActionRegistry } from '../src/core/actions.js';
import { createWorld, defineComponent } from '../src/core/ecs.js';
import { createRuntimeRegistry } from '../src/core/serialization.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/sim/world.js';

const Position = defineComponent({
  id: 'test.actions.position',
  version: 1,
  schema: {
    x: { type: 'number', default: 0 },
    y: { type: 'number', default: 0 },
  },
});

const X_AFFECT = 'entity:*/component:test.actions.position/field:x';
const Y_AFFECT = 'entity:*/component:test.actions.position/field:y';

function runtimes() {
  return [PHYSICS_RUNTIME_REQUIREMENT];
}

function runtimeRegistry() {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    { name: 'test-rapier' }
  );
}

function entityById(world, id) {
  return world.query(Position).map((entity) => entity).find((entity) => entity.id === id);
}

function setPositionDefinition(axis, { reversible = true, calls } = {}) {
  return {
    id: `test.set-${axis}`,
    paramsSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'integer', minimum: 1 },
        value: { type: 'number', minimum: -100, maximum: 100 },
      },
      required: ['entityId', 'value'],
      additionalProperties: false,
    },
    precondition: ({ world }, params) => (params.entityId === undefined
      ? world.query(Position).map((entity) => entity).length > 0
      : entityById(world, params.entityId))
      ? true
      : {
          at: `entity:${params.entityId}`,
          observed: 'missing',
          limit: 'entity must exist',
          alternatives: [],
        },
    affects: () => [axis === 'x' ? X_AFFECT : Y_AFFECT],
    reversible,
    describe: {
      title: `Set ${axis.toUpperCase()}`,
      summary: `Set one Position.${axis} field.`,
      tags: ['position'],
    },
    apply: ({ world }, params) => {
      if (calls) calls.count++;
      entityById(world, params.entityId).set(Position, { [axis]: params.value });
    },
  };
}

function request(engine, overrides = {}) {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    baseRevision: engine.revision,
    beforeRevision: engine.revision,
    idempotencyKey: 'run-1/step-1',
    allowedActions: ['test.set-x'],
    allowedAffects: [X_AFFECT],
    actions: [{ id: 'test.set-x', params: { entityId: 1, value: 10 } }],
    ...overrides,
  };
}

async function harness({ registry, position = { x: 0, y: 0 } } = {}) {
  const actions = registry ?? createActionRegistry().register(setPositionDefinition('x'));
  const world = createWorld();
  world.spawn(Position(position));
  const engine = await createActionEngine({
    registry: actions,
    world,
    runtimes: runtimes(),
    runtimeRegistry: runtimeRegistry(),
  });
  return { engine, registry: actions };
}

// @covers I1 I3 M1-b:registry M1-b:schema
test('Registry 校验定义并提供带前置条件的结构化自省', async () => {
  const registry = createActionRegistry().register(setPositionDefinition('x'));
  assert.throws(
    () => registry.register(setPositionDefinition('x')),
    /already registered/
  );
  assert.throws(
    () => createActionRegistry().register({ ...setPositionDefinition('y'), paramsSchema: { type: 'function' } }),
    /unsupported JSON Schema type/
  );

  const world = createWorld();
  const entity = world.spawn(Position());
  const [available] = registry.listAvailableActions({ world });
  assert.equal(available.id, 'test.set-x');
  assert.equal(available.reversible, true);
  assert.deepEqual(available.paramsSchema.required, ['entityId', 'value']);
  assert.equal(registry.describe('test.set-x').title, 'Set X');

  entity.destroy();
  assert.deepEqual(registry.listAvailableActions({ world }), [], '负例：前置条件不满足时不得列为可用');
  world.destroy();
});

// @covers I1 I2 M1-b:atomicity M1-b:schema M1-b:preconditions
test('schema、前置条件或后续 Action 失败时不产生部分写入', async () => {
  const registry = createActionRegistry()
    .register(setPositionDefinition('x'))
    .register({
      ...setPositionDefinition('y'),
      id: 'test.fail-after-write',
      affects: () => [Y_AFFECT],
      apply: ({ world }, params) => {
        entityById(world, params.entityId).set(Position, { y: params.value });
        throw new Error('planted failure');
      },
    });
  const { engine } = await harness({ registry });

  const invalid = await engine.previewStep(request(engine, {
    idempotencyKey: 'invalid-schema',
    actions: [{ id: 'test.set-x', params: { entityId: 1, value: 10, extra: true } }],
  }));
  assert.equal(invalid.receipt.status, 'failed');
  assert.equal(entityById(engine.world, 1).get(Position).x, 0);

  const missing = await engine.previewStep(request(engine, {
    idempotencyKey: 'missing-entity',
    actions: [{ id: 'test.set-x', params: { entityId: 99, value: 10 } }],
  }));
  assert.equal(missing.receipt.status, 'failed');

  const partial = await engine.previewStep(request(engine, {
    idempotencyKey: 'partial-write',
    allowedActions: ['test.set-x', 'test.fail-after-write'],
    allowedAffects: [X_AFFECT, Y_AFFECT],
    actions: [
      { id: 'test.set-x', params: { entityId: 1, value: 10 } },
      { id: 'test.fail-after-write', params: { entityId: 1, value: 20 } },
    ],
  }));
  assert.equal(partial.receipt.status, 'failed');
  assert.match(partial.receipt.failure.message, /planted failure/);
  assert.deepEqual(entityById(engine.world, 1).get(Position), { x: 0, y: 0 });
  engine.destroy();
});

// @covers I2 I7 决策40 ADR-003:P2 M1-b:preview-commit-abort
test('preview 隔离主世界，hard 验证失败不可提交，abort 丢弃候选', async () => {
  const { engine } = await harness();
  const failed = await engine.previewStep(request(engine, {
    idempotencyKey: 'validation-failure',
    validate: async () => [{ id: 'planted-hard-failure', severity: 'hard', status: 'failed' }],
  }));
  assert.equal(failed.receipt.status, 'failed');
  await assert.rejects(engine.commit(failed), /cannot commit/);
  assert.equal(entityById(engine.world, 1).get(Position).x, 0);

  const preview = await engine.previewStep(request(engine, { idempotencyKey: 'abort-preview' }));
  assert.equal(preview.receipt.status, 'passed');
  assert.equal(entityById(engine.world, 1).get(Position).x, 0);
  const cancelled = engine.abort(preview);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(entityById(engine.world, 1).get(Position).x, 0);
  engine.destroy();
});

// @covers I1 I2 I7 ADR-003:P2 ADR-003:P5 M1-b:receipt M1-b:undo
test('commit 返回真实 diff/affects，建立 checkpoint、日志与可逆撤销', async () => {
  const { engine } = await harness();
  const before = engine.revision;
  const preview = await engine.previewStep(request(engine));

  assert.notEqual(preview.receipt.candidateRevision, before, '负例：真实状态变化必须改变 revision');
  assert.deepEqual(preview.receipt.actualEffects, [X_AFFECT.replace('*', '1')]);
  assert.equal(preview.receipt.actions[0].diff[0].after, 10);
  const committed = await engine.commit(preview);
  assert.equal(engine.revision, preview.receipt.candidateRevision);
  assert.equal(entityById(engine.world, 1).get(Position).x, 10);
  assert.match(committed.checkpoint, /^run-1\/step-1\//);
  assert.equal(engine.checkpoints.list().length, 1);
  assert.equal(engine.changeLog().at(-1).kind, 'commit');

  const undone = await engine.undo();
  assert.equal(undone.revision, before);
  assert.equal(entityById(engine.world, 1).get(Position).x, 0);
  assert.equal(engine.changeLog().at(-1).kind, 'undo');
  engine.destroy();
});

// @covers I11 ADR-003:3.1.1 U-041 M1-b:revision-conflict meta:oracle-sensitivity
test('多步骤只接受本 run 推进的 revision，外部修改仍会稳定报冲突', async () => {
  const { engine } = await harness();
  const baseRevision = engine.revision;
  const first = await engine.previewStep(request(engine));
  await engine.commit(first);

  const second = await engine.previewStep(request(engine, {
    stepId: 'step-2',
    baseRevision,
    beforeRevision: first.receipt.candidateRevision,
    idempotencyKey: 'run-1/step-2',
    actions: [{ id: 'test.set-x', params: { entityId: 1, value: 20 } }],
  }));
  assert.equal(second.receipt.status, 'passed', '本 run 的首步 revision 推进不算冲突');
  await engine.commit(second);

  entityById(engine.world, 1).set(Position, { x: 99 });
  const stale = await engine.previewStep(request(engine, {
    stepId: 'step-3',
    baseRevision,
    beforeRevision: second.receipt.candidateRevision,
    idempotencyKey: 'run-1/step-3',
    actions: [{ id: 'test.set-x', params: { entityId: 1, value: 30 } }],
  }));
  assert.equal(stale.receipt.status, 'needs-review');
  assert.equal(stale.receipt.failure.code, 'revision-conflict');
  assert.equal(entityById(engine.world, 1).get(Position).x, 99, '负例保留外部修改，不得自动覆盖');
  engine.destroy();
});

// @covers I2 ADR-003:P2 M1-b:idempotency meta:oracle-sensitivity
test('相同幂等请求只执行一次，复用 key 改参数会被拒绝', async () => {
  const calls = { count: 0 };
  const registry = createActionRegistry().register(setPositionDefinition('x', { calls }));
  const { engine } = await harness({ registry });
  const input = request(engine);
  const first = await engine.previewStep(input);
  await engine.commit(first);

  const replay = await engine.previewStep(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.phase, 'committed');
  assert.equal(calls.count, 1);
  await engine.commit(replay);
  assert.equal(calls.count, 1, '负例：重复 commit 也不得再次执行');

  await assert.rejects(
    engine.previewStep({
      ...input,
      actions: [{ id: 'test.set-x', params: { entityId: 1, value: 11 } }],
    }),
    /idempotency key.*different request/
  );
  await assert.rejects(
    engine.previewStep({ ...input, validate: async () => [] }),
    /idempotency key.*different request/
  );
  engine.destroy();
});

// @covers I2 ADR-003:P2 M1-b:idempotency M1-b:abort
test('abort 的幂等重放保持 cancelled，且不会残留可提交候选', async () => {
  const calls = { count: 0 };
  const registry = createActionRegistry().register(setPositionDefinition('x', { calls }));
  const { engine } = await harness({ registry });
  const input = request(engine, { idempotencyKey: 'abort-idempotency' });
  const preview = await engine.previewStep(input);
  engine.abort(preview);

  const replay = await engine.previewStep(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.phase, 'cancelled');
  assert.equal(replay.receipt.status, 'cancelled');
  assert.equal(calls.count, 1);
  await assert.rejects(engine.commit(replay), /cannot commit a cancelled preview/);
  assert.equal(entityById(engine.world, 1).get(Position).x, 0);
  engine.destroy();
});

// @covers I2 ADR-003:7 U-042 M1-b:repair-permissions
test('repair 只能使用本步骤白名单且不得越过批准影响域', async () => {
  const registry = createActionRegistry()
    .register(setPositionDefinition('x'))
    .register(setPositionDefinition('y'));
  const { engine } = await harness({ registry });

  const expandedAction = await engine.previewStep(request(engine, {
    mode: 'repair',
    idempotencyKey: 'repair-expanded-action',
    actions: [{ id: 'test.set-y', params: { entityId: 1, value: 5 } }],
  }));
  assert.equal(expandedAction.receipt.status, 'needs-review');
  assert.equal(expandedAction.receipt.failure.code, 'action-not-allowed');

  const expandedAffect = await engine.previewStep(request(engine, {
    mode: 'repair',
    idempotencyKey: 'repair-expanded-affect',
    allowedActions: ['test.set-y'],
    actions: [{ id: 'test.set-y', params: { entityId: 1, value: 5 } }],
  }));
  assert.equal(expandedAffect.receipt.status, 'needs-review');
  assert.equal(expandedAffect.receipt.failure.code, 'affect-not-allowed');
  assert.deepEqual(entityById(engine.world, 1).get(Position), { x: 0, y: 0 });
  engine.destroy();
});

// @covers I7 I11 决策29 M1-b:deterministic-receipt meta:oracle-sensitivity
test('相同 Action 序列产生相同 receipt 与 revision，植入差异能被检出', async () => {
  async function run(value) {
    const { engine } = await harness();
    const preview = await engine.previewStep(request(engine, {
      actions: [{ id: 'test.set-x', params: { entityId: 1, value } }],
    }));
    const evidence = {
      candidateRevision: preview.receipt.candidateRevision,
      actions: preview.receipt.actions,
      actualEffects: preview.receipt.actualEffects,
    };
    engine.abort(preview);
    engine.destroy();
    return evidence;
  }

  const a = await run(10);
  const b = await run(10);
  const planted = await run(11);
  assert.deepEqual(a, b);
  assert.notEqual(a.candidateRevision, planted.candidateRevision, '负例必须让 oracle 检出差异');
});

// @covers I2 M1-b:reversibility M1-b:undo
test('不可逆 Action 会记录但不会伪装成可撤销', async () => {
  const registry = createActionRegistry().register(setPositionDefinition('x', { reversible: false }));
  const { engine } = await harness({ registry });
  const preview = await engine.previewStep(request(engine));
  await engine.commit(preview);
  assert.equal(engine.canUndo, false);
  await assert.rejects(engine.undo(), /no reversible step/);
  assert.equal(entityById(engine.world, 1).get(Position).x, 10);
  engine.destroy();
});

// @covers I7 I11 决策30 M1-b:checkpoint M1-c:chunks
test('事务提交与 checkpoint 保留既有分块和非实体 payload', async () => {
  const registry = createActionRegistry().register(setPositionDefinition('x'));
  const world = createWorld();
  world.spawn(Position());
  world.spawn(Position({ x: 2 }));
  const engine = await createActionEngine({
    registry,
    world,
    runtimes: runtimes(),
    runtimeRegistry: runtimeRegistry(),
    chunkForEntity: (entity) => (entity.id === 1 ? 'scene/a' : 'scene/b'),
    chunkPayloads: {
      'scene/a': { nav: { cells: [1, 2] } },
      'scene/b': { voxels: [3, 4] },
    },
  });
  const preview = await engine.previewStep(request(engine));
  const committed = await engine.commit(preview);
  const restored = await engine.checkpoints.restore(committed.checkpoint);

  assert.deepEqual(restored.envelope.chunks.map((chunk) => chunk.id), ['scene/a', 'scene/b']);
  assert.deepEqual(restored.envelope.chunks[0].payload, { nav: { cells: [1, 2] } });
  assert.deepEqual(restored.envelope.chunks[1].payload, { voxels: [3, 4] });
  restored.world.destroy();
  engine.destroy();
});
