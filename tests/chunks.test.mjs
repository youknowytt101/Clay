/**
 * M1-g 分块策略与表现流式加载验收。
 *
 * @package M1-g
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createActionEngine, createActionRegistry } from '../src/core/actions.js';
import { createChunkPolicy } from '../src/core/chunks.js';
import { createWorld, defineComponent } from '../src/core/ecs.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/core/runtime-versions.js';
import { createRuntimeRegistry, createWorldEnvelope } from '../src/core/serialization.js';
import { createGridSpatialIndex } from '../src/core/spatial-index.js';
import { Transform } from '../src/core/transform.js';
import { createEditorPatchAction, createEditorSession } from '../src/editor/session.js';
import { createChunkStreamer, createTransformChunkResolver } from '../src/render/chunk-streamer.js';
import { createRenderBridge } from '../src/render/bridge.js';

const GameplayState = defineComponent({
  id: 'test.chunks.gameplay-state',
  version: 1,
  schema: { ticks: { type: 'number', default: 0, min: 0 } },
});

const LOCAL_BOUNDS = Object.freeze({
  min: Object.freeze({ x: -0.5, y: -0.5, z: -0.5 }),
  max: Object.freeze({ x: 0.5, y: 0.5, z: 0.5 }),
});

function runtimeRegistry() {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    { name: 'test-rapier' }
  );
}

function bridgeHarness(world, policy) {
  const scene = new THREE.Scene();
  const index = createGridSpatialIndex({ cellSize: 4 });
  const bridge = createRenderBridge({
    world,
    scene,
    spatialIndex: index,
    createObject: (entity) => {
      const object = new THREE.Object3D();
      object.name = `entity-${entity.id}`;
      return object;
    },
    boundsForEntity: () => LOCAL_BOUNDS,
  });
  const streamer = createChunkStreamer({ bridge, policy });
  return { bridge, index, scene, streamer };
}

// @covers I2 I6 决策30 M1-g:chunk-policy meta:oracle-sensitivity
test('空间块边界与实体无关，负坐标、原点偏移和加载半径都产生稳定 id', () => {
  const policy = createChunkPolicy({ size: 16, origin: { x: 8, y: 0, z: -8 } });
  assert.equal(policy.idForPoint({ x: 8, y: 0, z: -8 }), 'chunk:0:0:0');
  assert.equal(policy.idForPoint({ x: 7.999, y: -0.001, z: -8.001 }), 'chunk:-1:-1:-1');
  assert.deepEqual(policy.boundsForId('chunk:-1:0:1'), {
    min: { x: -8, y: 0, z: 8 },
    max: { x: 8, y: 16, z: 24 },
  });
  const around = policy.idsAroundPoint({ x: 8, y: 0, z: -8 }, { radius: 1 });
  assert.equal(around.length, 27);
  assert.equal(around[0], 'chunk:-1:-1:-1');
  assert.equal(around.at(-1), 'chunk:1:1:1');
  assert.throws(() => policy.idForPoint({ x: Number.NaN, y: 0, z: 0 }), /point.x must be finite/);
});

// @covers I2 I5 I7 决策30 M1-g:S1 M1-g:S2 M1-g:projection-lifecycle meta:oracle-sensitivity
test('请求顺序不影响活动块，卸载只移除投影与索引，玩法实体持续存活', () => {
  const policy = createChunkPolicy({ size: 16 });
  const world = createWorld();
  const near = world.spawn(Transform({ x: 1 }), GameplayState({ ticks: 2 }));
  const far = world.spawn(Transform({ x: 17 }), GameplayState({ ticks: 3 }));
  const { bridge, index, streamer } = bridgeHarness(world, policy);

  const both = streamer.transition(['chunk:1:0:0', 'chunk:0:0:0', 'chunk:1:0:0']);
  assert.deepEqual(both.afterChunks, ['chunk:0:0:0', 'chunk:1:0:0']);
  assert.deepEqual(both.loaded, ['chunk:0:0:0', 'chunk:1:0:0']);
  assert.equal(bridge.getObject(near) !== null, true);
  assert.equal(bridge.getObject(far) !== null, true);
  assert.equal(index.size, 2);

  const unloaded = streamer.transition(['chunk:0:0:0']);
  assert.deepEqual(unloaded.unloaded, ['chunk:1:0:0']);
  assert.equal(bridge.getObject(far), null);
  assert.equal(index.size, 1);
  assert.equal(world.query(GameplayState).length, 2, '负例：表现卸载不得销毁权威玩法实体');
  assert.equal(far.alive, true);
  far.set(GameplayState, { ticks: 4 });
  assert.equal(far.get(GameplayState).ticks, 4);

  far.set(Transform, { x: 2 });
  assert.deepEqual(streamer.refresh(), { created: 1, updated: 0, removed: 0 });
  assert.equal(bridge.getObject(far) !== null, true, '隐藏实体进入活动块后应重新投影');
  assert.equal(index.size, 2);
  bridge.destroy();
  world.destroy();
});

// @covers I2 I5 I7 I11 决策30 M1-g:S3 M1-g:deterministic-reload meta:oracle-sensitivity
test('卸载重载前后相同输入得到相同完整世界 revision，植入差异可检出', async () => {
  const policy = createChunkPolicy({ size: 16 });
  const resolver = createTransformChunkResolver(policy);
  const makeWorld = () => {
    const world = createWorld();
    world.spawn(Transform({ x: 1 }), GameplayState({ ticks: 0 }));
    world.spawn(Transform({ x: 17 }), GameplayState({ ticks: 0 }));
    world.spawn(GameplayState({ ticks: 0 }));
    return world;
  };
  const baseline = makeWorld();
  const streamed = makeWorld();
  const { bridge, streamer } = bridgeHarness(streamed, policy);
  streamer.transition(['chunk:0:0:0', 'chunk:1:0:0']);
  streamer.transition(['chunk:0:0:0']);

  for (const entity of baseline.query(GameplayState)) entity.set(GameplayState, { ticks: entity.get(GameplayState).ticks + 1 });
  for (const entity of streamed.query(GameplayState)) entity.set(GameplayState, { ticks: entity.get(GameplayState).ticks + 1 });
  streamer.transition(['chunk:1:0:0', 'chunk:0:0:0']);

  const options = { runtimes: [PHYSICS_RUNTIME_REQUIREMENT], chunkForEntity: resolver };
  const baselineEnvelope = await createWorldEnvelope(baseline, options);
  const streamedEnvelope = await createWorldEnvelope(streamed, options);
  assert.equal(streamedEnvelope.revision, baselineEnvelope.revision);
  assert.deepEqual(
    streamedEnvelope.chunks.map(({ id }) => id),
    ['chunk:0:0:0', 'chunk:1:0:0', 'resident'],
    '负例：无 Transform 的全局玩法状态必须进入常驻块，不能被流式层丢弃'
  );

  streamed.query(GameplayState).at(1).set(GameplayState, { ticks: 2 });
  const plantedDifference = await createWorldEnvelope(streamed, options);
  assert.notEqual(plantedDifference.revision, baselineEnvelope.revision, '负例：玩法差异必须改变世界 revision');
  bridge.destroy();
  baseline.destroy();
  streamed.destroy();
});

// @covers I1 I3 I8 决策30 M1-g:action-chunk-affects M1-h:action-channel meta:oracle-sensitivity
test('父实体移动导致后代跨块时，Action 收据声明并记录后代 chunk 影响', async () => {
  const policy = createChunkPolicy({ size: 16 });
  const chunkForEntity = createTransformChunkResolver(policy);
  const world = createWorld();
  const parent = world.spawn(Transform({ x: 15 }));
  const child = world.spawn(Transform({ x: 2, parent }));
  const registry = createActionRegistry().register(createEditorPatchAction());
  const engine = await createActionEngine({
    registry,
    world,
    runtimes: [PHYSICS_RUNTIME_REQUIREMENT],
    runtimeRegistry: runtimeRegistry(),
    chunkForEntity,
  });
  const session = createEditorSession({ engine });
  const result = await session.patchComponent(Transform.id, [
    { entityId: parent.id, values: { x: 1 } },
  ]);

  assert.equal(result.receipt.status, 'passed');
  assert.deepEqual(result.receipt.actualEffects, [
    `entity:${parent.id}/component:${Transform.id}/field:x`,
    `entity:${child.id}/chunk`,
  ]);
  assert.equal(engine.world.query().length, 2);
  engine.destroy();
});
