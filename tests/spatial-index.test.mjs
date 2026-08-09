/**
 * M1-f 网格哈希、框选与射线拾取验收。
 *
 * @package M1-f
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/core/ecs.js';
import { Transform } from '../src/core/transform.js';
import {
  createGridSpatialIndex,
  pickNearest,
} from '../src/core/spatial-index.js';

function bounds(minX, minY, minZ, maxX, maxY, maxZ) {
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

function ids(items) {
  return items.map((entity) => entity.id);
}

// @covers I7 I11 决策29 M1-f:grid-index meta:oracle-sensitivity
test('AABB 查询与插入历史无关，结果始终按稳定实体 id 排序', () => {
  function run(order) {
    const world = createWorld();
    const entities = [world.spawn(Transform()), world.spawn(Transform()), world.spawn(Transform())];
    const index = createGridSpatialIndex({ cellSize: 2 });
    const boxes = [
      bounds(0, 0, 0, 1, 1, 1),
      bounds(1, 0, 0, 2, 1, 1),
      bounds(8, 0, 0, 9, 1, 1),
    ];
    for (const item of order) index.insert(entities[item], boxes[item]);
    const result = ids(index.queryAabb(bounds(-1, -1, -1, 3, 3, 3)));
    world.destroy();
    return result;
  }

  assert.deepEqual(run([0, 1, 2]), [1, 2]);
  assert.deepEqual(run([2, 1, 0]), [1, 2]);
  assert.notDeepEqual(run([0, 1, 2]), [2, 1], '负例必须检出未排序结果');
});

// @covers I2 I7 M1-f:grid-index M1-f:index-lifecycle
test('移动与删除实体会清除旧网格单元，非法更新不污染原索引', () => {
  const world = createWorld();
  const entity = world.spawn(Transform());
  const index = createGridSpatialIndex({ cellSize: 1 });
  assert.throws(() => index.insert(entity.id, bounds(0, 0, 0, 1, 1, 1)), /entity object/);
  index.insert(entity, bounds(0, 0, 0, 0.5, 0.5, 0.5));
  index.update(entity, bounds(10, 0, 0, 10.5, 0.5, 0.5));
  assert.deepEqual(index.queryAabb(bounds(-1, -1, -1, 1, 1, 1)), []);
  assert.deepEqual(ids(index.queryAabb(bounds(9, -1, -1, 11, 1, 1))), [entity.id]);

  assert.throws(
    () => index.update(entity, bounds(12, 0, 0, 11, 1, 1)),
    /min.x must be <= max.x/
  );
  assert.deepEqual(ids(index.queryAabb(bounds(9, -1, -1, 11, 1, 1))), [entity.id]);
  assert.equal(index.remove(entity), true);
  assert.equal(index.remove(entity), false);
  assert.equal(index.size, 0);
  world.destroy();
});

// @covers I7 I11 M1-f:ray-picking meta:oracle-sensitivity
test('射线拾取返回最近命中，同距按稳定 id，miss 与零方向可判定', () => {
  const world = createWorld();
  const first = world.spawn(Transform());
  const second = world.spawn(Transform());
  const far = world.spawn(Transform());
  const index = createGridSpatialIndex({ cellSize: 2 });
  index.insert(second, bounds(-1, -1, 4, 1, 1, 6));
  index.insert(first, bounds(-1, -1, 4, 1, 1, 6));
  index.insert(far, bounds(-1, -1, 9, 1, 1, 11));

  const hits = index.raycast(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 2 },
    { maxDistance: 20 }
  );
  assert.deepEqual(hits.map((hit) => [hit.entity.id, hit.distance]), [[1, 4], [2, 4], [3, 9]]);
  assert.equal(pickNearest(index, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 20).entity, first);
  assert.equal(pickNearest(index, { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 20), null);
  assert.throws(() => index.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), /direction must not be zero/);
  world.destroy();
});
