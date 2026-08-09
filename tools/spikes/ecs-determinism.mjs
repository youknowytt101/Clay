/**
 * ADR-001 ECS spike —— Clay M1-a
 *
 * 跑 ADR-001 §5 的六条。**第 5 条是杀手判据**：
 * 原型式 ECS 的查询迭代顺序会随组件增删变化，两家文档均未承诺确定性——必须实测。
 *
 * 用法：node tools/spikes/ecs-determinism.mjs
 */
import { createWorld, trait, universe } from 'koota';
import * as bit from 'bitecs';

const N = 1000;
const line = (s = '') => console.log(s);
const mark = (ok) => (ok ? '通过' : '不通过 ←');

// ───────────────────────── koota ─────────────────────────

const Position = trait({ x: 0, y: 0, z: 0 });
const Velocity = trait({ x: 0, y: 0, z: 0 });
const Name = trait({ value: '' });
const MeshRef = trait({ handle: null });   // 对象引用
const Tag = trait();

/**
 * 关键：用**两条不同的操作历史**到达**同一个逻辑状态**，比较查询迭代顺序。
 * 顺序若不同，就说明它取决于历史（原型迁移顺序），而不取决于状态。
 */
function kootaOrder(history) {
  const world = createWorld();
  const ids = [];

  if (history === 'straight') {
    // 历史 A：创建时就带齐两个 trait
    for (let i = 0; i < N; i++) ids.push(world.spawn(Position({ x: i }), Velocity({ x: 1 })));
  } else {
    // 历史 B：先全部只带 Position，再统一补 Velocity —— 逻辑终态与 A 完全相同
    for (let i = 0; i < N; i++) ids.push(world.spawn(Position({ x: i })));
    for (const e of ids) e.add(Velocity({ x: 1 }));
  }

  const seen = [];
  world.query(Position, Velocity).forEach((e) => seen.push(e.get(Position).x));
  world.destroy();
  return seen;
}

/** 增删组件后再恢复，看顺序是否回到原样。 */
function kootaChurn() {
  const world = createWorld();
  const ids = [];
  for (let i = 0; i < N; i++) ids.push(world.spawn(Position({ x: i }), Velocity({ x: 1 })));

  const before = [];
  world.query(Position, Velocity).forEach((e) => before.push(e.get(Position).x));

  // 确定性地摘掉每 7 个里的 1 个再加回来
  for (let i = 0; i < ids.length; i += 7) ids[i].remove(Velocity);
  for (let i = 0; i < ids.length; i += 7) ids[i].add(Velocity({ x: 1 }));

  const after = [];
  world.query(Position, Velocity).forEach((e) => after.push(e.get(Position).x));
  world.destroy();
  return { before, after };
}

line('═══ koota ' + '═'.repeat(52));

// 1 · 三种组件
{
  const world = createWorld();
  const mesh = { id: 'mesh-handle' };
  const e = world.spawn(Position({ x: 1.5 }), Name({ value: '敌人' }), MeshRef({ handle: mesh }));
  const ok =
    e.get(Position).x === 1.5 && e.get(Name).value === '敌人' && e.get(MeshRef).handle === mesh;
  line(`1 · 数值 / 字符串 / 对象引用三种组件         ${mark(ok)}`);
  world.destroy();
}

// 2 · 运行时注册模块组件集
{
  const world = createWorld();
  const moduleTraits = ['hp', 'armor', 'speed'].map((k) => trait({ [k]: 0 }));
  const e = world.spawn(...moduleTraits.map((t) => t()));
  const ok = moduleTraits.every((t) => e.has(t));
  line(`2 · 运行时注册一个模块的组件集               ${mark(ok)}`);
  world.destroy();
}

// 3 · 快照 → 改 100 个 → 回滚
{
  const world = createWorld();
  const ids = [];
  for (let i = 0; i < N; i++) ids.push(world.spawn(Position({ x: i })));

  // koota 无内置快照（ADR-001 §3 已记录），封装层自写——量级就是这几行
  const snapshot = ids.map((e) => ({ ...e.get(Position) }));
  for (let i = 0; i < 100; i++) ids[i].set(Position, { x: -999 });
  const dirty = ids.filter((e) => e.get(Position).x === -999).length;
  ids.forEach((e, i) => e.set(Position, snapshot[i]));
  const restored = ids.every((e, i) => e.get(Position).x === i);

  line(`3 · 快照 → 改 100 → 回滚（自写，${snapshot.length ? '~6 行' : ''}）        ${mark(dirty === 100 && restored)}`);
  world.destroy();
}

// 4 · 10k 实体查询循环
{
  const world = createWorld();
  for (let i = 0; i < 10000; i++) world.spawn(Position({ x: i }), Velocity({ x: 1 }));
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < 300) {
    world.query(Position, Velocity).updateEach(([p, v]) => { p.x += v.x; });
    frames++;
  }
  const ms = (performance.now() - t0) / frames;
  line(`4 · 10k 实体查询循环                        ${ms.toFixed(3)} ms/帧（${mark(ms < 16.6)}）`);
  world.destroy();
}

// 5 · 杀手判据：迭代顺序的确定性
{
  const a = kootaOrder('straight');
  const b = kootaOrder('staged');
  const sameAcrossHistory = a.length === b.length && a.every((v, i) => v === b[i]);

  const { before, after } = kootaChurn();
  const sameAfterChurn = before.length === after.length && before.every((v, i) => v === after[i]);

  const sorted = [...a].sort((x, y) => x - y);
  const isSpawnOrder = a.every((v, i) => v === sorted[i]);

  line(`5 · 迭代顺序（杀手判据）`);
  line(`      同终态 / 不同历史 → 顺序一致          ${mark(sameAcrossHistory)}`);
  line(`      增删组件后再恢复 → 顺序一致           ${mark(sameAfterChurn)}`);
  line(`      顺序恰为 spawn 顺序                   ${isSpawnOrder ? '是' : '否'}`);
  if (!sameAcrossHistory || !sameAfterChurn) {
    line(`      → 需要 ADR-001 §6 升级路径 ①：封装层按稳定 id 排序`);
  }
}

// 5b · 严格版：销毁 + id 复用 + 混合原型
// 上面的 5 太温和（只增删组件、且对称恢复）。原型式 ECS 真正会露馅的地方是
// 实体销毁后 id 被复用、以及同一查询命中多个不同原型。不做这一步，「通过」可能是假的。
{
  function harsh(history) {
    const world = createWorld();
    const ids = [];
    for (let i = 0; i < N; i++) {
      // 混合原型：1/3 的实体多带一个 Tag，命中同一查询但落在不同原型
      const e = i % 3 === 0
        ? world.spawn(Position({ x: i }), Velocity({ x: 1 }), Tag)
        : world.spawn(Position({ x: i }), Velocity({ x: 1 }));
      ids.push(e);
    }

    if (history === 'churn') {
      // 销毁一半（确定性地取偶数位），再补建同样多的新实体，触发 id 复用
      for (let i = 0; i < N; i += 2) ids[i].destroy();
      for (let i = 0; i < N / 2; i++) {
        world.spawn(Position({ x: 100000 + i }), Velocity({ x: 1 }));
      }
    }

    const seen = [];
    world.query(Position, Velocity).forEach((e) => seen.push(e.get(Position).x));
    world.destroy();
    return seen;
  }

  const once = harsh('churn');
  const twice = harsh('churn');
  const replayStable = once.length === twice.length && once.every((v, i) => v === twice[i]);

  const sortedAsc = [...once].sort((x, y) => x - y);
  const isAscending = once.every((v, i) => v === sortedAsc[i]);

  line(`5b · 严格版（销毁 + id 复用 + 混合原型）`);
  line(`      同一操作序列重放两次 → 顺序一致       ${mark(replayStable)}`);
  line(`      顺序是否天然升序                      ${isAscending ? '是' : '否 —— 封装层必须排序'}`);
  if (!isAscending) {
    line(`      → 触发 ADR-001 §6 升级路径 ①（这是预期内的，不是失败）`);
  }
}

// 6 · 书写体验（样例，主观判定留给人）
{
  const world = createWorld();
  world.spawn(Position({ x: 0 }), Velocity({ x: 2 }), Tag);
  world.query(Position, Velocity).updateEach(([p, v]) => { p.x += v.x; });
  line(`6 · 书写体验：world.query(P, V).updateEach(([p, v]) => p.x += v.x)`);
  world.destroy();
}

// ───────────────────────── bitECS 对照 ─────────────────────────

line();
line('═══ bitECS（对照） ' + '═'.repeat(44));

function bitOrder(history) {
  const world = bit.createWorld();
  const P = { x: [] }, V = { x: [] };
  const eids = [];

  if (history === 'straight') {
    for (let i = 0; i < N; i++) {
      const e = bit.addEntity(world);
      bit.addComponent(world, e, P); P.x[e] = i;
      bit.addComponent(world, e, V); V.x[e] = 1;
      eids.push(e);
    }
  } else {
    for (let i = 0; i < N; i++) {
      const e = bit.addEntity(world);
      bit.addComponent(world, e, P); P.x[e] = i;
      eids.push(e);
    }
    for (const e of eids) { bit.addComponent(world, e, V); V.x[e] = 1; }
  }

  const seen = [...bit.query(world, [P, V])].map((e) => P.x[e]);
  return seen;
}

try {
  const a = bitOrder('straight');
  const b = bitOrder('staged');
  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  line(`5 · 同终态 / 不同历史 → 顺序一致            ${mark(same)}`);
  line(`6 · 书写体验：Position.x[eid] = 10（eid 写错会静默改到别的实体）`);
} catch (err) {
  line(`bitECS 对照跑不起来：${err.message}`);
}

line();
line('注：许可证 —— koota ISC / bitECS MPL-2.0（文件级弱著佐权，改动过的源文件须公开）');
