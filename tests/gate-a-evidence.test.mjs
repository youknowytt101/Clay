/**
 * M1-e cross-CPU Gate A evidence acceptance.
 *
 * @package M1-e
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function evidence(name) {
  return JSON.parse(readFileSync(new URL(`../docs/design/evidence/${name}`, import.meta.url), 'utf8'));
}

// @covers I7 I11 决策29 U-025 U-046 M1-e:cross-cpu meta:oracle-sensitivity
test('Linux x64 与 ARM64 的 Rapier 状态、事件和 Transform 位模式完全一致', () => {
  const x64 = evidence('gate-a-linux-x64.json');
  const arm64 = evidence('gate-a-linux-arm64.json');

  assert.equal(x64.schema, 'clay.gate-a-determinism/1');
  assert.equal(arm64.schema, x64.schema);
  assert.notEqual(arm64.platform.arch, x64.platform.arch, '证据必须来自不同 CPU 架构');
  assert.deepEqual(arm64.source, x64.source);
  assert.deepEqual(arm64.scenario, x64.scenario);
  assert.deepEqual(arm64.runtimes, x64.runtimes);
  assert.deepEqual(arm64.results, x64.results);
  assert.equal(Object.values(x64.localChecks).every(Boolean), true);
  assert.equal(Object.values(arm64.localChecks).every(Boolean), true);

  const planted = structuredClone(arm64.results);
  planted.transform = 'planted-divergence';
  assert.notDeepEqual(planted, x64.results, '负例必须让证据比较检出指纹差异');
});
