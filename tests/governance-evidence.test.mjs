/**
 * ADR-004 governance replay evidence acceptance.
 *
 * @package M0-d
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function loadEvidence(name) {
  return JSON.parse(readFileSync(
    new URL(`../docs/design/evidence/${name}`, import.meta.url),
    'utf8'
  ));
}

const r1 = loadEvidence('adr-004-replay-r1.json');
const r2 = loadEvidence('adr-004-replay-r2.json');

// @covers ADR-004:G1 ADR-004:G2 ADR-004:G3 U-047 meta:oracle-sensitivity
test('治理回放证据保留 G2 漏判，不把部分通过伪装成 ADR-004 已验证', () => {
  assert.equal(r1.isolatedContexts, true);
  assert.equal(r1.g1.discoveredCritical, r1.g1.plantedCritical);
  assert.equal(r1.g1.unauthorizedChanges, 0);
  assert.equal(r1.g2.discovered.length, 5);
  assert.equal(r1.g2.planted.length, 6);
  assert.deepEqual(r1.g2.missed, ['or-composition-semantics']);
  assert.equal(r1.g2.unauthorizedChanges, 0);
  assert.equal(r1.g3.champion.discoveredCritical, r1.g3.criticalOmissions);
  assert.equal(r1.g3.lean8.discoveredCritical, 2);
  assert.equal(r1.g3.decision, 'reject-lean8');
  assert.equal(r1.overall, 'failed-g2-missed-or-semantics');

  const plantedFalsePass = structuredClone(r1);
  plantedFalsePass.overall = 'passed';
  assert.notDeepEqual(plantedFalsePass, r1, '负例必须检出对回放总判定的篡改');
});

function acceptsR2(evidence) {
  const controlsInvalid = evidence.controls.reduce(
    (total, control) => total + control.invalidChallenges,
    0
  );
  return evidence.isolatedContext === true
    && evidence.readOnly === true
    && evidence.challenger.universalD13 === false
    && evidence.g2.discovered.length === evidence.g2.planted.length
    && evidence.g2.missed.length === 0
    && evidence.g2.previouslyMissedDiscovered.includes('or-composition-semantics')
    && evidence.g2.unauthorizedChanges === 0
    && controlsInvalid === 0
    && evidence.burden.addedReviewJudgments === 9
    && evidence.adoption.ownerApproved === true
    && evidence.overall === 'passed-g2-r2-conditional-logic-probe';
}

// @covers ADR-004:G2 ADR-004:logic-probe U-032 U-047 meta:oracle-sensitivity
test('G2 r2 条件式逻辑探针补回 OR，且不向无问题对照扩散挑战', () => {
  assert.equal(acceptsR2(r2), true);

  const plantedMiss = structuredClone(r2);
  plantedMiss.g2.discovered = plantedMiss.g2.discovered.filter(
    (item) => item !== 'or-composition-semantics'
  );
  plantedMiss.g2.missed = ['or-composition-semantics'];
  assert.equal(acceptsR2(plantedMiss), false, '负例必须检出 OR 再次逃逸');

  const plantedInvalidChallenge = structuredClone(r2);
  plantedInvalidChallenge.controls[0].invalidChallenges = 1;
  assert.equal(acceptsR2(plantedInvalidChallenge), false, '负例必须检出对照任务误报');

  const plantedUnauthorizedChange = structuredClone(r2);
  plantedUnauthorizedChange.g2.unauthorizedChanges = 1;
  assert.equal(acceptsR2(plantedUnauthorizedChange), false, '负例必须检出越权修改');
});
