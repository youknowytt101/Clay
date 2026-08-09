/**
 * Rapier 确定性 spike —— Clay M1-e
 *
 * 验两件事：
 *   1. 逐 tick 刚体状态哈希一致（原验收内容）
 *   2. 逐 tick 接触事件序列一致（ADR-002 推演缺口 D 新增的验收内容）
 *
 * 用法：
 *   node spike.mjs            跑两个独立 world，比对
 *   node spike.mjs --emit     额外把指纹写到 fingerprint.json，供跨机器比对
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const STEPS = 600;
const DT = 1 / 60;

// ---- 场景：刻意制造大量接触事件与堆叠，放大非确定性 ------------------------
function buildWorld(perturb = 0) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;

  // 地面
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    groundBody
  );

  // 一堆盒子，网格排布 + 微小错位，落下后互相碰撞并堆叠
  const bodies = [];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      for (let k = 0; k < 2; k++) {
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(
            i * 1.05 - 2.1 + (n === 0 ? perturb : 0),
            3 + k * 1.4,
            j * 1.05 - 2.1
          )
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
            .setRestitution(0.35),
          body
        );
        bodies.push(body);
        n++;
      }
    }
  }
  return { world, bodies, count: n };
}

// ---- 逐 tick 采集 -----------------------------------------------------------
function run(perturb = 0) {
  const { world, bodies } = buildWorld(perturb);
  const eventQueue = new RAPIER.EventQueue(true);

  const stateHashes = [];
  const eventHashes = [];
  let totalEvents = 0;

  for (let step = 0; step < STEPS; step++) {
    world.step(eventQueue);

    // 事件序列：按 Rapier 交回的原始顺序记录，不排序 —— 这正是要测的东西
    const events = [];
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      events.push(`${h1},${h2},${started ? 1 : 0}`);
    });
    totalEvents += events.length;
    eventHashes.push(sha(events.join('|')));

    // 刚体状态：精确到位模式，不做量化 —— 量化会掩盖真实的跨平台漂移
    const buf = Buffer.allocUnsafe(bodies.length * 7 * 8);
    let off = 0;
    for (const b of bodies) {
      const t = b.translation();
      const r = b.rotation();
      for (const v of [t.x, t.y, t.z, r.x, r.y, r.z, r.w]) {
        buf.writeDoubleLE(v, off);
        off += 8;
      }
    }
    stateHashes.push(sha(buf));
  }

  world.free();
  eventQueue.free();
  return { stateHashes, eventHashes, totalEvents };
}

const sha = (d) => createHash('sha256').update(d).digest('hex').slice(0, 16);

// ---- 比对 -------------------------------------------------------------------
function firstDivergence(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

await RAPIER.init();

console.log(`Rapier spike · ${STEPS} steps @ ${DT.toFixed(5)}s`);
console.log(`平台：${os.platform()} ${os.arch()} · node ${process.version}`);

const A = run();
const B = run();

const stateDiv = firstDivergence(A.stateHashes, B.stateHashes);
const eventDiv = firstDivergence(A.eventHashes, B.eventHashes);

console.log(`\n接触事件总数：${A.totalEvents} / ${B.totalEvents}`);
console.log(`状态序列一致：${stateDiv === -1 ? '是' : `否，首次分叉于 step ${stateDiv}`}`);
console.log(`事件序列一致：${eventDiv === -1 ? '是' : `否，首次分叉于 step ${eventDiv}`}`);

const finalState = sha(A.stateHashes.join(''));
const finalEvent = sha(A.eventHashes.join(''));
console.log(`\n跨机器比对指纹：`);
console.log(`  state = ${finalState}`);
console.log(`  event = ${finalEvent}`);

if (process.argv.includes('--emit')) {
  writeFileSync(
    'fingerprint.json',
    JSON.stringify(
      {
        platform: `${os.platform()} ${os.arch()}`,
        node: process.version,
        steps: STEPS,
        totalEvents: A.totalEvents,
        stateFingerprint: finalState,
        eventFingerprint: finalEvent,
      },
      null,
      2
    )
  );
  console.log('\n已写出 fingerprint.json');
}

// ---- 植入负例：证明这套指纹确实能检测到差异 ---------------------------------
// 不做这一步，「通过」有可能只是因为哈希根本没在测东西。
// Rapier 内部是 f32：小于 f32 epsilon 的扰动会被直接吞掉，检不出不代表指纹失效。
// 扫描量级，找出「多大的初始差异会被放大成状态分叉」——这个阈值本身就是 lockstep 的输入。
console.log(`\n植入负例扫描（首个盒子 x 偏移，Rapier 为 f32）：`);
let detectedAny = false;
for (const eps of [1e-12, 1e-9, 1e-7, 1e-6, 1e-5, 1e-3]) {
  const P = run(eps);
  const dState = sha(P.stateHashes.join('')) !== finalState;
  const dEvent = sha(P.eventHashes.join('')) !== finalEvent;
  const div = firstDivergence(A.stateHashes, P.stateHashes);
  if (dState) detectedAny = true;
  console.log(
    `  ${eps.toExponential(0).padStart(7)} → 状态 ${dState ? '分叉' : ' 一致'}` +
      ` · 事件 ${dEvent ? '分叉' : ' 一致'}` +
      (div === -1 ? '' : ` · 首次分叉 step ${div}`)
  );
}

const ok = stateDiv === -1 && eventDiv === -1 && detectedAny;
console.log(`\n同机重跑判定：${ok ? '通过' : '不通过'}`);
process.exit(ok ? 0 : 1);
