/**
 * M1-i 最小 AI 单步指令通道验收。
 *
 * @package M1-i
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleStepAssistant } from '../src/ai/single-step.js';
import { createActionEngine, createActionRegistry } from '../src/core/actions.js';
import { createWorld, defineComponent } from '../src/core/ecs.js';
import { createRuntimeRegistry } from '../src/core/serialization.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/sim/world.js';
import { Transform } from '../src/core/transform.js';
import { Name } from '../src/editor/components.js';
import { EDITOR_PATCH_ACTION } from '../src/editor/session.js';
import {
  authorizeEditorSingleStep,
  interpretEditorSingleStep,
} from '../src/editor/single-step-command.js';

const Position = defineComponent({
  id: 'test.ai.position',
  version: 1,
  schema: { x: { type: 'number', default: 0 } },
});

function entityById(world, id) {
  return world.query(Position).map((entity) => entity).find((entity) => entity.id === id);
}

function runtimeRegistry() {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    { name: 'test-rapier' }
  );
}

async function harness({ interpreterCalls = { count: 0 }, applyCalls = { count: 0 }, proposedEntityId = null } = {}) {
  const action = {
    id: 'test.ai.set-x',
    paramsSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'integer', minimum: 1 },
        value: { type: 'number', minimum: -100, maximum: 100 },
      },
      required: ['entityId', 'value'],
      additionalProperties: false,
    },
    precondition: ({ world }, params) => entityById(world, params.entityId) ? true : false,
    affects: (_context, params) => [`entity:${params.entityId}/component:${Position.id}/field:x`],
    reversible: true,
    describe: {
      title: 'Set X position',
      summary: 'Set one entity X position.',
      tags: ['position'],
    },
    apply: ({ world }, params) => {
      applyCalls.count++;
      entityById(world, params.entityId).set(Position, { x: params.value });
    },
  };
  const registry = createActionRegistry().register(action);
  const world = createWorld();
  world.spawn(Position({ x: 1 }));
  const engine = await createActionEngine({
    registry,
    world,
    runtimes: [PHYSICS_RUNTIME_REQUIREMENT],
    runtimeRegistry: runtimeRegistry(),
  });
  const assistant = createSingleStepAssistant({
    engine,
    registry,
    allowedActions: [action.id],
    interpret: async ({ instruction, availableActions, context }) => {
      interpreterCalls.count++;
      assert.equal(instruction, '把 X 位置设为 7');
      assert.deepEqual(availableActions.map(({ id }) => id), [action.id]);
      return { actionId: action.id, params: { entityId: proposedEntityId ?? context.entityId, value: 7 } };
    },
    authorize: ({ action: proposed, context }) => proposed.params.entityId === context.entityId
      ? [`entity:${context.entityId}/component:${Position.id}/field:x`]
      : false,
  });
  return { assistant, engine, interpreterCalls, applyCalls };
}

// @covers I1 I3 I8 M1-i:single-action M1-i:preview-confirm M1-b:preview-commit-abort meta:oracle-sensitivity
test('单步指令只生成一个隔离候选，显式确认后才经既有 Action 收据提交', async () => {
  const { assistant, engine, interpreterCalls, applyCalls } = await harness();
  const beforeRevision = engine.revision;
  const proposal = await assistant.propose({
    requestId: 'request-1',
    instruction: '把 X 位置设为 7',
    context: { entityId: 1 },
  });

  assert.equal(proposal.phase, 'awaiting-confirmation');
  assert.equal(proposal.action.id, 'test.ai.set-x');
  assert.equal(proposal.description.title, 'Set X position');
  assert.equal(proposal.receipt.status, 'passed');
  assert.equal(proposal.receipt.actions.length, 1);
  assert.equal(entityById(engine.world, 1).get(Position).x, 1, '负例：preview 不得提前修改主世界');
  assert.equal(engine.revision, beforeRevision);

  const committed = await assistant.confirm(proposal);
  assert.equal(proposal.phase, 'committed');
  assert.equal(committed.receipt.candidateRevision, engine.revision);
  assert.equal(entityById(engine.world, 1).get(Position).x, 7);
  assert.equal(interpreterCalls.count, 1);
  assert.equal(applyCalls.count, 1);
  engine.destroy();
});

// @covers I5 I11 ADR-003:3.2 M1-i:idempotency M1-b:idempotency meta:oracle-sensitivity
test('相同请求重放复用同一提案与提交结果，复用 id 改输入会被拒绝', async () => {
  const { assistant, engine, interpreterCalls, applyCalls } = await harness();
  const input = { requestId: 'request-repeat', instruction: '把 X 位置设为 7', context: { entityId: 1 } };
  const first = await assistant.propose(input);
  const replay = await assistant.propose(input);
  assert.strictEqual(replay, first);

  const [firstCommit, replayCommit] = await Promise.all([
    assistant.confirm(first),
    assistant.confirm(replay),
  ]);
  assert.strictEqual(replayCommit, firstCommit);
  assert.strictEqual(await assistant.confirm(first), firstCommit);
  assert.equal(interpreterCalls.count, 1);
  assert.equal(applyCalls.count, 1, '负例：重复请求不得再次执行 Action');
  assert.equal(entityById(engine.world, 1).get(Position).x, 7, '并发确认后主世界仍必须存活');
  await assert.rejects(
    assistant.propose({ ...input, instruction: '把 X 位置设为 8' }),
    /request id request-repeat was reused/
  );
  engine.destroy();
});

// @covers I5 I8 ADR-003:P2 M1-i:abort M1-i:authority-boundary meta:oracle-sensitivity
test('取消会丢弃候选，宿主拒绝的影响域不得进入 preview', async () => {
  const allowed = await harness();
  const proposal = await allowed.assistant.propose({
    requestId: 'request-abort',
    instruction: '把 X 位置设为 7',
    context: { entityId: 1 },
  });
  const cancelled = await allowed.assistant.abort(proposal);
  assert.equal(proposal.phase, 'cancelled');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(entityById(allowed.engine.world, 1).get(Position).x, 1, '负例：abort 后主世界必须保持原值');

  const denied = await harness({ proposedEntityId: 1 });
  await assert.rejects(
    denied.assistant.propose({
      requestId: 'request-denied',
      instruction: '把 X 位置设为 7',
      context: { entityId: 2 },
    }),
    /instruction is outside the host-approved affect scope/
  );
  assert.equal(allowed.applyCalls.count, 1, '已取消候选只执行过一次隔离 apply');
  assert.equal(denied.applyCalls.count, 0, '负例：宿主拒绝项不得进入 Action preview');
  allowed.engine.destroy();
  denied.engine.destroy();
});

// @covers I3 I8 I10 M1-i:provider-boundary M1-i:editor-adapter meta:oracle-sensitivity
test('编辑器本地适配器只翻译受支持的一条 Action，影响域由选择边界授权', async () => {
  const move = await interpretEditorSingleStep({
    instruction: '把选中物体的 X 位置设为 3.5',
    context: { selection: [2, 1] },
  });
  assert.deepEqual(move, {
    actionId: EDITOR_PATCH_ACTION,
    params: {
      componentId: Transform.id,
      patches: [
        { entityId: 1, values: { x: 3.5 } },
        { entityId: 2, values: { x: 3.5 } },
      ],
    },
  });
  assert.deepEqual(authorizeEditorSingleStep({
    action: { id: move.actionId, params: move.params },
    context: { selection: [1, 2] },
  }), [
    `entity:1/component:${Transform.id}/field:x`,
    `entity:2/component:${Transform.id}/field:x`,
  ]);

  const rename = await interpretEditorSingleStep({
    instruction: '把选中实体重命名为 北门',
    context: { selection: [1] },
  });
  assert.equal(rename.params.componentId, Name.id);
  assert.equal(rename.params.patches[0].values.value, '北门');
  assert.equal(authorizeEditorSingleStep({
    action: { id: EDITOR_PATCH_ACTION, params: { ...move.params, patches: [{ entityId: 3, values: { x: 3.5 } }] } },
    context: { selection: [1] },
  }), false, '负例：解释器不得修改选择范围外的实体');
  await assert.rejects(
    interpretEditorSingleStep({ instruction: '删除全部实体', context: { selection: [1] } }),
    /当前单步适配器支持/
  );
});
