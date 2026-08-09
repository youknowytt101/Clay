/**
 * ADR-004 governance replay r1 evidence acceptance.
 *
 * @package ADR-004-r1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const evidence = JSON.parse(readFileSync(
  new URL('../docs/design/evidence/adr-004-replay-r1.json', import.meta.url),
  'utf8'
));

// @covers ADR-004:G1 ADR-004:G2 ADR-004:G3 U-047 meta:oracle-sensitivity
test('治理回放证据保留 G2 漏判，不把部分通过伪装成 ADR-004 已验证', () => {
  assert.equal(evidence.isolatedContexts, true);
  assert.equal(evidence.g1.discoveredCritical, evidence.g1.plantedCritical);
  assert.equal(evidence.g1.unauthorizedChanges, 0);
  assert.equal(evidence.g2.discovered.length, 5);
  assert.equal(evidence.g2.planted.length, 6);
  assert.deepEqual(evidence.g2.missed, ['or-composition-semantics']);
  assert.equal(evidence.g2.unauthorizedChanges, 0);
  assert.equal(evidence.g3.champion.discoveredCritical, evidence.g3.criticalOmissions);
  assert.equal(evidence.g3.lean8.discoveredCritical, 2);
  assert.equal(evidence.g3.decision, 'reject-lean8');
  assert.equal(evidence.overall, 'failed-g2-missed-or-semantics');

  const plantedFalsePass = structuredClone(evidence);
  plantedFalsePass.overall = 'passed';
  assert.notDeepEqual(plantedFalsePass, evidence, '负例必须检出对回放总判定的篡改');
});
