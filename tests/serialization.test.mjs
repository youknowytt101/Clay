/**
 * M1-c 序列化、revision 与 checkpoint 验收。
 *
 * @package M1-c
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorld, defineComponent } from '../src/core/ecs.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/sim/world.js';
import {
  createCheckpointStore,
  createRuntimeRegistry,
  createWorldEnvelope,
  getEnvelopeChunk,
  loadWorldEnvelope,
  migrateEnvelope,
  parseEnvelope,
  sealEnvelope,
  stringifyEnvelope,
} from '../src/core/serialization.js';

const Position = defineComponent({
  id: 'test.position',
  version: 2,
  migrations: { 1: (data) => ({ ...data, y: 0 }) },
  schema: {
    x: { type: 'number', default: 0, unit: 'm' },
    y: { type: 'number', default: 0, unit: 'm' },
  },
});

const LinkedTo = defineComponent({
  id: 'test.linked-to',
  version: 1,
  schema: {
    target: { type: 'entity', default: null },
  },
});

const RuntimeHandle = defineComponent({
  id: 'test.runtime-handle',
  version: 1,
  schema: {
    value: { type: 'reference', default: null, transient: true },
  },
});

function currentRuntimes() {
  return [PHYSICS_RUNTIME_REQUIREMENT];
}

function currentRegistry(runtime = { name: 'rapier-current' }) {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    runtime
  );
}

async function sampleEnvelope() {
  const world = createWorld();
  const target = world.spawn(Position({ x: 1, y: 2 }));
  world.spawn(
    Position({ x: 3, y: 4 }),
    LinkedTo({ target }),
    RuntimeHandle({ value: { gpu: 'not-serializable' } })
  );
  const envelope = await createWorldEnvelope(world, {
    runtimes: currentRuntimes(),
    chunkForEntity: (entity) => (entity.id === 1 ? 'scene/main/a' : 'scene/main/b'),
    chunkPayloads: {
      'scene/main/b': { voxels: { palette: ['stone'], cells: [1, 0, 1] } },
      'scene/main/a': { nav: null },
    },
  });
  world.destroy();
  return envelope;
}

// @covers I7 I11 决策29 M1-c:deterministic-envelope meta:oracle-sensitivity
test('相同状态不受组件添加顺序和块输入顺序影响，产生完全相同的字节与 revision', async () => {
  const a = createWorld();
  const a1 = a.spawn(Position({ x: 1 }));
  a.spawn(Position({ x: 2 }), LinkedTo({ target: a1 }));

  const b = createWorld();
  const b1 = b.spawn(Position({ x: 1 }));
  const b2 = b.spawn(LinkedTo({ target: b1 }));
  b2.add(Position({ x: 2 }));

  const optionsA = {
    runtimes: currentRuntimes(),
    chunkForEntity: (entity) => (entity.id === 1 ? 'b' : 'a'),
    chunkPayloads: { b: { z: 2, a: 1 }, a: { empty: true } },
  };
  const optionsB = {
    runtimes: [...currentRuntimes()].reverse(),
    chunkForEntity: optionsA.chunkForEntity,
    chunkPayloads: { a: { empty: true }, b: { a: 1, z: 2 } },
  };

  const envelopeA = await createWorldEnvelope(a, optionsA);
  const envelopeB = await createWorldEnvelope(b, optionsB);
  assert.equal(envelopeA.revision, envelopeB.revision);
  assert.equal(stringifyEnvelope(envelopeA), stringifyEnvelope(envelopeB));

  b2.set(Position, { x: 99 });
  const changed = await createWorldEnvelope(b, optionsB);
  assert.notEqual(envelopeA.revision, changed.revision, '负例必须改变 revision');
  a.destroy();
  b.destroy();
});

// @covers I5 I11 M1-c:roundtrip M1-c:chunks
test('跨块实体引用、稳定 id、组件版本与非实体块载荷完整往返', async () => {
  assert.throws(
    () => defineComponent({
      id: 'test.persistent-object-reference',
      version: 1,
      schema: { value: { type: 'reference', default: null } },
    }),
    /transient must be true/
  );
  const envelope = await sampleEnvelope();
  const loaded = await loadWorldEnvelope(envelope, { runtimeRegistry: currentRegistry() });
  const entities = loaded.world.query(Position);

  assert.deepEqual(entities.map((entity) => entity.id), [1, 2]);
  assert.equal(entities.at(1).get(LinkedTo).target, entities.at(0));
  assert.equal(entities.at(1).get(RuntimeHandle).value, null, 'transient 引用不得进入快照');
  assert.equal(loaded.world.spawn(Position).id, 3, '恢复后稳定 id 必须从最大值继续增长');
  assert.deepEqual(getEnvelopeChunk(envelope, 'scene/main/b').payload, {
    voxels: { cells: [1, 0, 1], palette: ['stone'] },
  });
  loaded.world.destroy();
});

// @covers I11 M1-c:migration meta:oracle-sensitivity
test('组件旧版本在加载时迁移，信封迁移链缺一步就拒绝', async () => {
  const envelope = await sampleEnvelope();
  const old = JSON.parse(stringifyEnvelope(envelope));
  const component = old.chunks[0].entities[0].components.find((item) => item.id === Position.id);
  component.version = 1;
  delete component.data.y;
  delete old.revision;
  const oldEnvelope = await sealEnvelope(old);
  const loaded = await loadWorldEnvelope(oldEnvelope, { runtimeRegistry: currentRegistry() });
  assert.deepEqual(loaded.world.query(Position).at(0).get(Position), { x: 1, y: 0 });
  assert.equal(loaded.sourceRevision, oldEnvelope.revision);
  assert.notEqual(loaded.revision, loaded.sourceRevision, '组件迁移后必须为当前状态生成新 revision');
  loaded.world.destroy();

  const migrated = migrateEnvelope(
    { format: 'test', version: 1, data: { value: 1 } },
    { targetVersion: 3, migrations: {
      1: (value) => ({ ...value, version: 2, data: { value: 2 } }),
      2: (value) => ({ ...value, version: 3, data: { value: 3 } }),
    } }
  );
  assert.equal(migrated.data.value, 3);
  assert.throws(
    () => migrateEnvelope({ format: 'test', version: 1 }, { targetVersion: 3, migrations: { 1: (v) => ({ ...v, version: 2 }) } }),
    /missing envelope migration 2 -> 3/
  );
});

// @covers I11 U-039 meta:oracle-sensitivity
test('快照按精确物理版本解析，绝不回退到注册表中的最新版', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.dependencies[PHYSICS_RUNTIME_REQUIREMENT.id],
    PHYSICS_RUNTIME_REQUIREMENT.version,
    '快照运行时常量必须与精确安装版本同步'
  );
  const oldRuntime = { name: 'rapier-old' };
  const currentRuntime = { name: 'rapier-current' };
  const registry = createRuntimeRegistry()
    .register(PHYSICS_RUNTIME_REQUIREMENT.id, '0.19.3', oldRuntime)
    .register(PHYSICS_RUNTIME_REQUIREMENT.id, '0.20.0', currentRuntime);

  const world = createWorld();
  world.spawn(Position);
  await assert.rejects(
    createWorldEnvelope(world, { runtimes: [] }),
    /must include runtime @dimforge\/rapier3d-compat/
  );
  const envelope = await createWorldEnvelope(world, {
    runtimes: [{ id: PHYSICS_RUNTIME_REQUIREMENT.id, version: '0.19.3' }],
  });
  const loaded = await loadWorldEnvelope(envelope, { runtimeRegistry: registry });
  assert.equal(loaded.runtimes.get(PHYSICS_RUNTIME_REQUIREMENT.id), oldRuntime);
  loaded.world.destroy();

  const currentOnly = createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    '0.20.0',
    currentRuntime
  );
  await assert.rejects(
    loadWorldEnvelope(envelope, { runtimeRegistry: currentOnly }),
    /requires @dimforge\/rapier3d-compat 0\.19\.3.*not registered/
  );
  world.destroy();
});

// @covers I11 M1-c:revision meta:oracle-sensitivity
test('revision 覆盖信封内容，JSON 被篡改后在加载前拒绝', async () => {
  const envelope = await sampleEnvelope();
  const json = stringifyEnvelope(envelope);
  const parsed = await parseEnvelope(json);
  assert.equal(parsed.revision, envelope.revision);

  const tampered = json.replace('"x":1', '"x":8');
  assert.notEqual(tampered, json, '负例必须实际修改序列化内容');
  await assert.rejects(parseEnvelope(tampered), /revision mismatch/);
});

// @covers M1-c:checkpoint ADR-003:recovery
test('命名 checkpoint 保存不可变快照并以零补偿恢复', async () => {
  const registry = currentRegistry();
  const store = createCheckpointStore({ runtimeRegistry: registry });
  const world = createWorld();
  const entity = world.spawn(Position({ x: 1 }));

  const base = await store.save('base', world, { runtimes: currentRuntimes() });
  entity.set(Position, { x: 9 });
  const changed = await store.save('changed', world, { runtimes: currentRuntimes() });

  assert.notEqual(base.revision, changed.revision);
  assert.deepEqual(store.list().map((item) => item.name), ['base', 'changed']);
  await assert.rejects(store.save('base', world, { runtimes: currentRuntimes() }), /already exists/);

  const restored = await store.restore('base');
  assert.equal(restored.world.query(Position)[Symbol.iterator]().next().value.get(Position).x, 1);
  assert.equal(restored.revision, base.revision);
  restored.world.destroy();
  world.destroy();
});
