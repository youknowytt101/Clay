/**
 * M0-b 的验收测试。
 *
 * 这是**试飞台的第一块砖**：不开界面跑完整场景并断言结果（不变量 I7）。
 * 它验的不是"能不能渲染"，是"玩法层能不能在 headless 下确定地跑"。
 *
 * @package M0-b
 *
 * 下面每个 test 用 `@covers` 声明它到底守住了哪条不变量 / 决策 / 闸门判据。
 * `tools/status.py` 靠这些标记算进度——**没有测试守着的判据，不计入进度**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, World, TICK_DT } from '../src/sim/world.js';

const rapier = await initPhysics();

function buildScene() {
  const w = new World(rapier);
  w.addGround();
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) w.addBox(i * 1.05 - 1.6, 3 + j * 1.4, j * 1.05 - 1.1);
  }
  return w;
}

function run(steps = 240) {
  const w = buildScene();
  const eventLog = [];
  for (let i = 0; i < steps; i++) {
    for (const e of w.step()) eventLog.push(`${w.tick}:${e.kind},${e.a},${e.b}`);
  }
  const out = { state: w.stateFingerprint(), events: eventLog.join('|') };
  w.free();
  return out;
}

// @covers ADR-002:tick
test('固定步长是 1/60', () => {
  assert.equal(TICK_DT, 1 / 60);
});

// @covers I7
test('玩法层无渲染依赖即可跑（I7）', () => {
  const r = run(10);
  assert.ok(r.state.length > 0, '应当产生玩法状态指纹');
});

// @covers I7 决策29
test('相同输入产生逐 tick 相同的玩法状态', () => {
  const a = run(), b = run();
  assert.equal(a.state, b.state, '状态指纹必须一致——决策 29 不允许降级');
});

// @covers 决策29 ADR-002:D4
test('相同输入产生相同的事件序列（ADR-002 r2 · D4）', () => {
  const a = run(), b = run();
  assert.equal(a.events, b.events, '事件序列必须一致，否则触发规则的执行顺序会分叉');
});

// @covers ADR-002:D4
test('事件在入队前已按 (类型, 主 id, 次 id) 稳定排序（D4）', () => {
  const w = buildScene();
  let checked = 0;
  for (let i = 0; i < 240; i++) {
    const evs = w.step();
    for (let k = 1; k < evs.length; k++) {
      const p = evs[k - 1], c = evs[k];
      const pk = [p.kind, Math.min(p.a, p.b), Math.max(p.a, p.b)];
      const ck = [c.kind, Math.min(c.a, c.b), Math.max(c.a, c.b)];
      assert.ok(
        pk[0] < ck[0] || (pk[0] === ck[0] && (pk[1] < ck[1] || (pk[1] === ck[1] && pk[2] <= ck[2]))),
        `第 ${i} tick 的事件未按 D4 排序`
      );
      checked++;
    }
  }
  w.free();
  assert.ok(checked > 0, '这一轮应当至少产生一对可比较的同 tick 事件');
});

// @covers meta:oracle-sensitivity
test('指纹对 f32 量级的差异敏感（否则上面的断言是空的）', () => {
  // Rapier 是 f32：小于 ~2.4e-7 的扰动会被直接吞掉，检不出不代表指纹失效。
  const base = buildScene();
  for (let i = 0; i < 120; i++) base.step();
  const a = base.stateFingerprint();
  base.free();

  const w = new World(rapier);
  w.addGround();
  let n = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      w.addBox(i * 1.05 - 1.6 + (n++ === 0 ? 1e-5 : 0), 3 + j * 1.4, j * 1.05 - 1.1);
    }
  }
  for (let i = 0; i < 120; i++) w.step();
  const b = w.stateFingerprint();
  w.free();

  assert.notEqual(a, b, '1e-5 的扰动必须被指纹检出，否则确定性断言形同虚设');
});
