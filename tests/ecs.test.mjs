/**
 * M1-a ECS 封装层验收。
 *
 * @package M1-a
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld as createKootaWorld, trait } from 'koota';
import {
  createWorld,
  defineComponent,
  getComponent,
  listComponents,
  migrateComponentData,
} from '../src/core/ecs.js';

const Position = defineComponent({
  id: 'core.position',
  version: 2,
  migrations: {
    1: (data) => ({ ...data, y: 0 }),
  },
  schema: {
    x: { type: 'number', default: 0, min: -1000, max: 1000, unit: 'm', description: 'World X position' },
    y: { type: 'number', default: 0, min: -1000, max: 1000, unit: 'm', description: 'World Y position' },
  },
});

const Targeting = defineComponent({
  id: 'game.targeting',
  version: 1,
  schema: {
    mode: {
      type: 'enum',
      values: ['nearest', 'lowest-health'],
      default: 'nearest',
      description: 'Target selection policy',
    },
    target: { type: 'entity', default: null, description: 'Current target entity' },
  },
});

const Velocity = defineComponent({
  id: 'core.velocity',
  version: 1,
  schema: {
    x: { type: 'number', default: 0, unit: 'm/s' },
    y: { type: 'number', default: 0, unit: 'm/s' },
  },
});

const Selected = defineComponent({ id: 'editor.selected', version: 1, schema: {} });

// @covers I5 U-002
test('组件 schema 可自省，且调用组件定义会产生已校验的初始化值', () => {
  assert.equal(Position.id, 'core.position');
  assert.deepEqual(Position.schema.x, {
    type: 'number',
    default: 0,
    min: -1000,
    max: 1000,
    unit: 'm',
    description: 'World X position',
  });
  assert.equal(Object.isFrozen(Position.schema), true);
  assert.equal(Object.isFrozen(Position.schema.x), true);

  const world = createWorld();
  const target = world.spawn(Position({ x: 4 }));
  const source = world.spawn(Targeting({ mode: 'lowest-health', target }));

  assert.deepEqual(source.get(Targeting), { mode: 'lowest-health', target });
  assert.deepEqual(target.get(Position), { x: 4, y: 0 });
  world.destroy();
});

// @covers U-002 meta:oracle-sensitivity
test('非法 schema 与非法组件值给出稳定诊断，失败写入不污染原值', () => {
  assert.throws(
    () => defineComponent({ id: 'bad.range', version: 1, schema: { value: { type: 'number', default: 5, max: 4 } } }),
    /bad\.range\.value.*default.*max/
  );
  assert.throws(
    () => defineComponent({ id: 'bad.enum', version: 1, schema: { value: { type: 'enum', values: [], default: 'x' } } }),
    /bad\.enum\.value.*values/
  );

  const world = createWorld();
  assert.throws(() => world.spawn(Position({ x: 1001 })), /core\.position\.x.*max/);

  const entity = world.spawn(Targeting());
  assert.throws(() => entity.set(Targeting, { mode: 'random' }), /game\.targeting\.mode.*enum/);
  assert.deepEqual(entity.get(Targeting), { mode: 'nearest', target: null });
  world.destroy();
});

// @covers 决策29 ADR-002:D1
test('query 按封装层稳定 id 升序，而不是 koota 原型内存顺序', () => {
  const rawPosition = trait({ x: 0 });
  const rawVelocity = trait({ x: 0 });
  const rawSelected = trait();
  const rawWorld = createKootaWorld();
  const rawEntities = [];

  for (let i = 0; i < 60; i++) {
    rawEntities.push(
      i % 3 === 0
        ? rawWorld.spawn(rawPosition({ x: i }), rawVelocity, rawSelected)
        : rawWorld.spawn(rawPosition({ x: i }), rawVelocity)
    );
  }
  for (let i = 0; i < rawEntities.length; i += 2) rawEntities[i].destroy();
  for (let i = 0; i < 30; i++) rawWorld.spawn(rawPosition({ x: 1000 + i }), rawVelocity);

  const rawOrder = rawWorld.query(rawPosition, rawVelocity).map((entity) => entity.get(rawPosition).x);
  const rawAscending = [...rawOrder].sort((a, b) => a - b);
  assert.notDeepEqual(rawOrder, rawAscending, '负例必须证明 koota 原始查询在该场景中不是稳定升序');
  rawWorld.destroy();

  const world = createWorld();
  const entities = [];
  for (let i = 0; i < 60; i++) {
    entities.push(
      i % 3 === 0
        ? world.spawn(Position({ x: i }), Velocity, Selected)
        : world.spawn(Position({ x: i }), Velocity)
    );
  }
  for (let i = 0; i < entities.length; i += 2) entities[i].destroy();
  for (let i = 0; i < 30; i++) world.spawn(Position({ x: 1000 - i }), Velocity);

  const result = world.query(Position, Velocity);
  const ids = result.map((entity) => entity.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
  world.destroy();
});

// @covers I11 决策29
test('稳定 id 单调递增，实体销毁后不复用', () => {
  const world = createWorld();
  const first = world.spawn(Position);
  const second = world.spawn(Position);
  first.destroy();
  const replacement = world.spawn(Position);

  assert.deepEqual([first.id, second.id, replacement.id], [1, 2, 3]);
  assert.throws(() => first.get(Position), /entity 1.*destroyed/);
  world.destroy();
});

// @covers I5
test('组件通过封装层运行时注册，并支持查询与更新', () => {
  const world = createWorld();
  const moving = world.spawn(Position({ x: 1 }), Velocity({ x: 2 }));
  world.spawn(Position({ x: 10 }));

  const matches = world.query(Position, Velocity);
  assert.deepEqual(matches.map((entity) => entity.id), [moving.id]);
  matches.updateEach(([position, velocity]) => {
    position.x += velocity.x;
  });
  assert.equal(moving.get(Position).x, 3);
  world.destroy();
});

// @covers I5 U-002 meta:oracle-sensitivity
test('updateEach 任一组件校验失败时不写入同一实体的前半批结果', () => {
  const world = createWorld();
  const moving = world.spawn(Position({ x: 1 }), Velocity({ x: 2 }));

  assert.throws(
    () => world.query(Position, Velocity).updateEach(([position, velocity]) => {
      position.x = 9;
      velocity.x = Number.POSITIVE_INFINITY;
    }),
    /core\.velocity\.x.*finite number/
  );
  assert.deepEqual(moving.get(Position), { x: 1, y: 0 });
  assert.deepEqual(moving.get(Velocity), { x: 2, y: 0 });
  world.destroy();
});

// @covers I5 U-002
test('注册表可确定地枚举组件，批量增删失败保持实体不变', () => {
  assert.equal(getComponent('core.position'), Position);
  const ids = listComponents().map((component) => component.id);
  assert.deepEqual(ids, [...ids].sort());

  const world = createWorld();
  const entity = world.spawn(Position);

  assert.throws(() => entity.add(Velocity, Position), /already has component core\.position/);
  assert.equal(entity.has(Velocity), false, '批量添加校验失败时不得留下前半批组件');

  entity.add(Velocity);
  assert.throws(() => entity.remove(Velocity, Targeting), /does not have component game\.targeting/);
  assert.equal(entity.has(Velocity), true, '批量移除校验失败时不得删除前半批组件');
  world.destroy();
});

// @covers I5 U-002
test('实体引用只能指向同一存活世界，失败 spawn 不消耗稳定 id', () => {
  const worldA = createWorld();
  const worldB = createWorld();
  const foreign = worldB.spawn(Position);

  assert.throws(() => worldA.spawn(Targeting({ target: foreign })), /another world/);
  assert.equal(worldA.spawn(Position).id, 1);

  foreign.destroy();
  assert.throws(() => worldB.spawn(Targeting({ target: foreign })), /destroyed entity 1/);
  worldA.destroy();
  worldB.destroy();
});

// @covers I11 U-002 meta:oracle-sensitivity
test('组件数据按连续版本迁移，并由当前 schema 校验迁移结果', () => {
  assert.equal(Position.version, 2);
  assert.deepEqual(migrateComponentData(Position, 1, { x: 7 }), { x: 7, y: 0 });
  assert.deepEqual(migrateComponentData(Position, 2, { x: 7, y: 3 }), { x: 7, y: 3 });

  assert.throws(() => migrateComponentData(Position, 0, { x: 7 }), /fromVersion.*positive integer/);
  assert.throws(() => migrateComponentData(Position, 3, { x: 7, y: 3 }), /newer than current version 2/);

  const BrokenMigration = defineComponent({
    id: 'test.broken-migration',
    version: 2,
    migrations: { 1: (data) => ({ ...data, x: 2000 }) },
    schema: Position.schema,
  });
  assert.throws(
    () => migrateComponentData(BrokenMigration, 1, { x: 7 }),
    /test\.broken-migration migration 1 -> 2.*x.*max/
  );
});
