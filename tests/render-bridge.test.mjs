/**
 * M1-f Three.js 增量渲染桥验收。
 *
 * @package M1-f
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorld } from '../src/core/ecs.js';
import { createGridSpatialIndex } from '../src/core/spatial-index.js';
import { Transform } from '../src/core/transform.js';
import { createRenderBridge } from '../src/render/bridge.js';

const LOCAL_BOUNDS = {
  min: { x: -0.5, y: -0.5, z: -0.5 },
  max: { x: 0.5, y: 0.5, z: 0.5 },
};

function position(object) {
  return new THREE.Vector3().setFromMatrixPosition(object.matrix);
}

// @covers I7 I9 M1-f:render-bridge M1-f:incremental-sync
test('渲染桥增量创建/更新/移除 Object3D，场景图不成为 Transform 真源', () => {
  const world = createWorld();
  const parent = world.spawn(Transform({ x: 4 }));
  const child = world.spawn(Transform({ x: 2, parent }));
  const scene = new THREE.Scene();
  const index = createGridSpatialIndex({ cellSize: 2 });
  const bridge = createRenderBridge({
    world,
    scene,
    spatialIndex: index,
    createObject: (entity) => {
      const group = new THREE.Group();
      group.name = `entity-${entity.id}`;
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      return group;
    },
    boundsForEntity: () => LOCAL_BOUNDS,
  });

  assert.deepEqual(bridge.sync(), { created: 2, updated: 0, removed: 0 });
  assert.equal(scene.children.length, 2);
  const childObject = bridge.getObject(child);
  assert.equal(position(childObject).x, 6);
  assert.equal(bridge.getEntityForObject(childObject.children[0]), child);
  assert.deepEqual(bridge.sync(), { created: 0, updated: 0, removed: 0 });

  childObject.position.set(999, 999, 999);
  childObject.updateMatrix();
  assert.deepEqual(child.get(Transform).x, 2, 'Three.js 对象修改不得回写 ECS');
  child.set(Transform, { x: 3 });
  assert.deepEqual(bridge.sync(), { created: 0, updated: 1, removed: 0 });
  assert.equal(bridge.getObject(child), childObject, '增量更新必须保留 Object3D 身份');
  assert.equal(position(childObject).x, 7);

  child.destroy();
  assert.deepEqual(bridge.sync(), { created: 0, updated: 0, removed: 1 });
  assert.equal(scene.children.includes(childObject), false);
  assert.deepEqual(index.queryAabb({ min: { x: 6, y: -1, z: -1 }, max: { x: 8, y: 1, z: 1 } }), []);
  bridge.destroy();
  world.destroy();
});

// @covers I7 I11 M1-f:render-picking M1-f:world-bounds meta:oracle-sensitivity
test('渲染桥把本地 bounds 投影到世界并返回稳定实体拾取结果', () => {
  const world = createWorld();
  const near = world.spawn(Transform({ z: 4 }));
  const far = world.spawn(Transform({ z: 9 }));
  const scene = new THREE.Scene();
  const pickable = new Set([near.id, far.id]);
  const bridge = createRenderBridge({
    world,
    scene,
    spatialIndex: createGridSpatialIndex({ cellSize: 2 }),
    createObject: () => new THREE.Object3D(),
    boundsForEntity: (entity) => pickable.has(entity.id) ? LOCAL_BOUNDS : null,
  });
  bridge.sync();

  const hit = bridge.pick(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { maxDistance: 20 }
  );
  assert.equal(hit.entity, near);
  assert.equal(hit.distance, 3.5);
  pickable.delete(near.id);
  bridge.sync();
  assert.equal(bridge.pick(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { maxDistance: 20 }
  ).entity, far);
  pickable.add(near.id);
  bridge.sync();
  near.set(Transform, { x: 20 });
  bridge.sync();
  assert.equal(bridge.pick(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { maxDistance: 20 }
  ).entity, far, '负例：移动后不得命中旧 bounds');
  bridge.destroy();
  world.destroy();
});

// @covers I2 I7 M1-f:render-bridge M1-f:factory-failure
test('新投影工厂失败不会删除既有 Object3D', () => {
  const world = createWorld();
  const existing = world.spawn(Transform());
  const scene = new THREE.Scene();
  let fail = false;
  const bridge = createRenderBridge({
    world,
    scene,
    createObject: () => {
      if (fail) throw new Error('planted factory failure');
      return new THREE.Object3D();
    },
  });
  bridge.sync();
  const object = bridge.getObject(existing);
  world.spawn(Transform({ x: 2 }));
  fail = true;
  assert.throws(() => bridge.sync(), /planted factory failure/);
  assert.equal(bridge.getObject(existing), object);
  assert.equal(scene.children.includes(object), true);
  bridge.destroy();
  world.destroy();
});

// @covers I3 I7 M1-h:world-replacement M1-h:projection-rebind
test('世界替换后按稳定 id 重绑定实体并保留 Object3D 身份', () => {
  const firstWorld = createWorld();
  const firstEntity = firstWorld.spawn(Transform({ x: 1 }));
  const secondWorld = createWorld();
  const secondEntity = secondWorld.spawn(Transform({ x: 9 }));
  const scene = new THREE.Scene();
  const index = createGridSpatialIndex({ cellSize: 2 });
  const bridge = createRenderBridge({
    world: firstWorld,
    scene,
    spatialIndex: index,
    createObject: () => new THREE.Object3D(),
    boundsForEntity: () => LOCAL_BOUNDS,
  });
  bridge.sync();
  const object = bridge.getObject(firstEntity);

  bridge.setWorld(secondWorld);
  assert.deepEqual(bridge.sync(), { created: 0, updated: 1, removed: 0 });
  assert.equal(bridge.getObject(secondEntity), object);
  assert.equal(position(object).x, 9);
  assert.equal(bridge.pick({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }).entity, secondEntity);
  assert.notEqual(secondEntity, firstEntity, '负例：重绑定必须返回新世界实体而不是旧对象引用');
  bridge.destroy();
  firstWorld.destroy();
  secondWorld.destroy();
});
