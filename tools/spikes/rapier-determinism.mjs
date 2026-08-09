/**
 * 闸门 A 跨架构确定性 spike —— Clay M1-e / U-025 / U-046
 *
 * 验两件事：
 *   1. 逐 tick 刚体状态哈希一致（原验收内容）
 *   2. 逐 tick 接触事件序列一致（ADR-002 推演缺口 D 新增的验收内容）
 *   3. Transform 层级的世界 TRS 位模式一致（U-046）
 *
 * 用法：
 *   npm run spike:gate-a      跑两个独立 world，比对
 *   npm run spike:gate-a -- --emit arm64.json
 *   npm run spike:gate-a -- --compare x64.json
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createWorld } from '../../src/core/ecs.js';
import { Transform, getWorldTransform } from '../../src/core/transform.js';

const STEPS = 600;
const DT = 1 / 60;
const EVIDENCE_SCHEMA = 'clay.gate-a-determinism/1';
const packageLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

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
const sourceFingerprint = Object.freeze({
  spike: sha(readFileSync(new URL(import.meta.url), 'utf8').replaceAll('\r\n', '\n')),
  transform: sha(readFileSync(new URL('../../src/core/transform.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')),
});

// ---- Transform 层级位模式 ---------------------------------------------------
// 输入全部是固定字面量，避免用宿主 Math 先生成输入而污染被测结果。
const TRANSFORM_SCENARIO = Object.freeze([
  { x: 10.125, y: -2.5, z: 7.75, qx: 0.18257418583505536, qy: 0.3651483716701107, qz: -0.18257418583505536, qw: 0.8944271909999159, sx: 1.25, sy: 0.75, sz: 1.5 },
  { x: -3.375, y: 4.25, z: 0.625, qx: -0.2721655269759087, qy: 0.13608276348795434, qz: 0.408248290463863, qw: 0.8616404368553291, sx: 0.8, sy: 1.4, sz: 0.9, parent: 0 },
  { x: 1.03125, y: -0.71875, z: 2.5625, qx: 0.10482848367219183, qy: -0.3144854510165755, qz: 0.20965696734438366, qw: 0.9191450300180578, sx: 1.1, sy: 0.95, sz: 1.2, parent: 1 },
  { x: -0.4375, y: 3.8125, z: -1.15625, qx: 0.3903600291794133, qy: 0.2602400194529422, qz: -0.1301200097264711, qw: 0.873128377660057, sx: 1.3, sy: 0.7, sz: 1.05, parent: 2 },
]);

function transformFingerprint(perturb = 0) {
  const world = createWorld();
  const entities = [];
  for (const [index, values] of TRANSFORM_SCENARIO.entries()) {
    entities.push(world.spawn(Transform({
      ...values,
      x: values.x + (index === 0 ? perturb : 0),
      parent: values.parent === undefined ? null : entities[values.parent],
    })));
  }
  const buffer = Buffer.allocUnsafe(entities.length * 10 * 8);
  let offset = 0;
  for (const entity of entities) {
    const result = getWorldTransform(entity);
    const values = [
      result.position.x, result.position.y, result.position.z,
      result.quaternion.x, result.quaternion.y, result.quaternion.z, result.quaternion.w,
      result.scale.x, result.scale.y, result.scale.z,
    ];
    for (const value of values) {
      buffer.writeDoubleLE(value, offset);
      offset += 8;
    }
  }
  world.destroy();
  return sha(buffer);
}

function argumentValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function compareEvidence(actual, expected) {
  const checks = [
    ['schema', actual.schema, expected.schema],
    ['source', actual.source, expected.source],
    ['scenario', actual.scenario, expected.scenario],
    ['runtimes', actual.runtimes, expected.runtimes],
    ['Rapier state', actual.results.rapierState, expected.results?.rapierState],
    ['Rapier events', actual.results.rapierEvents, expected.results?.rapierEvents],
    ['Rapier event count', actual.results.totalEvents, expected.results?.totalEvents],
    ['Transform', actual.results.transform, expected.results?.transform],
  ];
  const mismatches = checks.filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right));
  for (const [label, left, right] of mismatches) {
    console.error(`  ${label}: current=${JSON.stringify(left)} baseline=${JSON.stringify(right)}`);
  }
  return mismatches.length === 0;
}

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
const transformA = transformFingerprint();
const transformB = transformFingerprint();
console.log(`\n跨机器比对指纹：`);
console.log(`  state = ${finalState}`);
console.log(`  event = ${finalEvent}`);
console.log(`  transform = ${transformA}`);

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

const transformNegative = transformFingerprint(1e-9) !== transformA;
console.log(`\nTransform 同机重跑：${transformA === transformB ? '一致' : '分叉'}`);
console.log(`Transform 植入负例：${transformNegative ? '已检出' : '未检出'}`);

const evidence = {
  schema: EVIDENCE_SCHEMA,
  source: sourceFingerprint,
  scenario: { version: 1, steps: STEPS, dt: DT, transformEntities: TRANSFORM_SCENARIO.length },
  platform: {
    os: os.platform(),
    release: os.release(),
    arch: os.arch(),
    endian: os.endianness(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    node: process.version,
  },
  runtimes: {
    rapier: packageLock.packages['node_modules/@dimforge/rapier3d-compat'].version,
    three: packageLock.packages['node_modules/three'].version,
  },
  results: {
    rapierState: finalState,
    rapierEvents: finalEvent,
    totalEvents: A.totalEvents,
    transform: transformA,
  },
  localChecks: {
    rapierReplay: stateDiv === -1 && eventDiv === -1,
    rapierNegativeDetected: detectedAny,
    transformReplay: transformA === transformB,
    transformNegativeDetected: transformNegative,
  },
};

const emitPath = argumentValue('--emit', 'fingerprint.json');
if (emitPath) {
  writeFileSync(emitPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\n已写出 ${emitPath}`);
}

let comparisonPassed = true;
const comparePath = argumentValue('--compare');
if (process.argv.includes('--compare') && !comparePath) {
  console.error('\n--compare 必须指定另一台机器的证据 JSON');
  comparisonPassed = false;
} else if (comparePath) {
  const baseline = JSON.parse(readFileSync(comparePath, 'utf8'));
  comparisonPassed = compareEvidence(evidence, baseline);
  console.log(`\n跨机器比对：${comparisonPassed ? '通过' : '不通过'}`);
}

const ok = stateDiv === -1 && eventDiv === -1 && detectedAny
  && transformA === transformB && transformNegative && comparisonPassed;
console.log(`\n本次判定：${ok ? '通过' : '不通过'}`);
process.exit(ok ? 0 : 1);
