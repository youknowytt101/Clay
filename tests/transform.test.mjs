/**
 * M1-f Transform 层级验收。
 *
 * @package M1-f
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/core/ecs.js';
import {
  createRuntimeRegistry,
  createWorldEnvelope,
  loadWorldEnvelope,
} from '../src/core/serialization.js';
import {
  Transform,
  getWorldTransform,
  resolveWorldTransforms,
} from '../src/core/transform.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/sim/world.js';

function runtimes() {
  return [PHYSICS_RUNTIME_REQUIREMENT];
}

function runtimeRegistry() {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    { name: 'transform-rapier' }
  );
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);
}

// @covers I7 I11 M1-f:transform-hierarchy
test('Transform 是 ECS 本地 TRS，父级缩放与旋转确定地产生子级世界变换', () => {
  const world = createWorld();
  const root = world.spawn(Transform({
    x: 10,
    qy: Math.sin(Math.PI / 4),
    qw: Math.cos(Math.PI / 4),
    sx: 2,
    sy: 2,
    sz: 2,
  }));
  const child = world.spawn(Transform({ x: 1, parent: root }));

  const resolved = getWorldTransform(child);
  close(resolved.position.x, 10, 'world x');
  close(resolved.position.y, 0, 'world y');
  close(resolved.position.z, -2, 'world z');
  close(resolved.scale.x, 2, 'world scale x');
  close(resolved.quaternion.y, Math.sin(Math.PI / 4), 'world rotation y');
  assert.deepEqual([...resolveWorldTransforms(world).keys()], [root.id, child.id]);
  world.destroy();
});

// @covers I2 I7 M1-f:transform-validation meta:oracle-sensitivity
test('零四元数、自引用、祖先环与已销毁父级都稳定失败', () => {
  const world = createWorld();
  const zero = world.spawn(Transform({ qx: 0, qy: 0, qz: 0, qw: 0 }));
  assert.throws(() => getWorldTransform(zero), /quaternion must not be zero/);
  zero.destroy();

  const self = world.spawn(Transform());
  self.set(Transform, { parent: self });
  assert.throws(() => getWorldTransform(self), /cycle.*entity 2/);

  const a = world.spawn(Transform());
  const b = world.spawn(Transform({ parent: a }));
  a.set(Transform, { parent: b });
  assert.throws(() => resolveWorldTransforms(world), /cycle/);

  const parent = world.spawn(Transform());
  const orphan = world.spawn(Transform({ parent }));
  parent.destroy();
  assert.throws(() => getWorldTransform(orphan), /destroyed parent/);
  world.destroy();
});

// @covers I7 I11 M1-c:roundtrip M1-f:transform-serialization
test('Transform 父实体引用与本地 TRS 经确定性信封完整往返', async () => {
  const world = createWorld();
  const parent = world.spawn(Transform({ x: 4, y: 5, z: 6 }));
  world.spawn(Transform({ x: 2, parent }));
  const envelope = await createWorldEnvelope(world, { runtimes: runtimes() });
  const loaded = await loadWorldEnvelope(envelope, { runtimeRegistry: runtimeRegistry() });
  const entities = loaded.world.query(Transform).map((entity) => entity);

  assert.equal(entities[1].get(Transform).parent, entities[0]);
  assert.deepEqual(entities[0].get(Transform), parent.get(Transform));
  close(getWorldTransform(entities[1]).position.x, 6, 'loaded child world x');
  loaded.world.destroy();
  world.destroy();
});
