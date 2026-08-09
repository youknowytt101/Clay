/**
 * M1-h 编辑器会话、通用详情与 Action 写通道验收。
 *
 * @package M1-h
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { createActionEngine, createActionRegistry } from '../src/core/actions.js';
import { createWorld, defineComponent } from '../src/core/ecs.js';
import {
  createRuntimeRegistry,
  createWorldEnvelope,
} from '../src/core/serialization.js';
import {
  createEditorPatchAction,
  createEditorSession,
  describeSelection,
  editorAffects,
  transformPatchesFromWorldDelta,
} from '../src/editor/session.js';
import { Transform } from '../src/core/transform.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from '../src/sim/world.js';

const EditorProbe = defineComponent({
  id: 'test.editor.probe',
  version: 1,
  schema: {
    x: { type: 'number', default: 0, unit: 'm', min: -100, max: 100, description: 'X position.' },
    enabled: { type: 'boolean', default: true, description: 'Whether the probe is enabled.' },
    mode: { type: 'enum', default: 'idle', values: ['idle', 'active'], description: 'Probe mode.' },
  },
});

function runtimes() {
  return [PHYSICS_RUNTIME_REQUIREMENT];
}

function runtimeRegistry() {
  return createRuntimeRegistry().register(
    PHYSICS_RUNTIME_REQUIREMENT.id,
    PHYSICS_RUNTIME_REQUIREMENT.version,
    { name: 'test-rapier' }
  );
}

function entityById(world, id) {
  return world.query().map((entity) => entity).find((entity) => entity.id === id);
}

async function harness(values = [1, 2]) {
  const registry = createActionRegistry().register(createEditorPatchAction());
  const world = createWorld();
  for (const x of values) world.spawn(EditorProbe({ x }));
  const engine = await createActionEngine({
    registry,
    world,
    runtimes: runtimes(),
    runtimeRegistry: runtimeRegistry(),
  });
  return { engine, registry };
}

// @covers I3 I7 I8 M1-h:selection M1-h:schema-details meta:oracle-sensitivity
test('选择只保存稳定 id，不进入快照；详情按 schema 描述共同字段与混合值', async () => {
  const { engine } = await harness();
  const before = await createWorldEnvelope(engine.world, { runtimes: runtimes() });
  const session = createEditorSession({ engine });

  session.setSelection([2, 1, 2]);
  assert.deepEqual(session.selection, [1, 2]);
  const details = describeSelection(engine.world, session.selection);
  const probe = details.components.find((component) => component.id === EditorProbe.id);
  assert.equal(details.count, 2);
  assert.equal(probe.fields.find((field) => field.name === 'x').mixed, true);
  assert.equal(probe.fields.find((field) => field.name === 'enabled').value, true);
  assert.equal(probe.fields.find((field) => field.name === 'mode').schema.type, 'enum');

  const after = await createWorldEnvelope(engine.world, { runtimes: runtimes() });
  assert.equal(after.revision, before.revision, '负例：改变编辑器选择不得改变世界 revision');
  engine.destroy();
});

// @covers I1 I3 I8 I11 M1-h:action-channel M1-h:gui-action-parity meta:oracle-sensitivity
test('编辑器会话与直接 Action 产生逐字节相同的世界 revision', async () => {
  const fromGui = await harness();
  const session = createEditorSession({ engine: fromGui.engine });
  const guiResult = await session.patchComponent(EditorProbe.id, [
    { entityId: 2, values: { x: 12 } },
    { entityId: 1, values: { x: 11 } },
  ]);

  const direct = await harness();
  const params = {
    componentId: EditorProbe.id,
    patches: [
      { entityId: 1, values: { x: 11 } },
      { entityId: 2, values: { x: 12 } },
    ],
  };
  const preview = await direct.engine.previewStep({
    runId: 'direct-run',
    stepId: 'direct-step',
    baseRevision: direct.engine.revision,
    beforeRevision: direct.engine.revision,
    idempotencyKey: 'direct-run/direct-step',
    allowedActions: ['editor.patch-components'],
    allowedAffects: editorAffects(params),
    actions: [{ id: 'editor.patch-components', params }],
  });
  await direct.engine.commit(preview);

  assert.equal(guiResult.receipt.status, 'passed');
  assert.equal(fromGui.engine.revision, direct.engine.revision);
  assert.deepEqual(entityById(fromGui.engine.world, 1).get(EditorProbe).x, 11);
  assert.notEqual(fromGui.engine.revision, guiResult.receipt.beforeRevision, '负例：真实 GUI 编辑必须改变 revision');
  fromGui.engine.destroy();
  direct.engine.destroy();
});

// @covers I1 I2 M1-h:batch-atomicity M1-h:action-channel meta:oracle-sensitivity
test('多选批量编辑任一值非法时整批回滚且不改变选择', async () => {
  const { engine } = await harness();
  const session = createEditorSession({ engine });
  session.setSelection([1, 2]);
  const before = engine.revision;

  await assert.rejects(
    session.patchComponent(EditorProbe.id, [
      { entityId: 1, values: { x: 20 } },
      { entityId: 2, values: { x: Number.POSITIVE_INFINITY } },
    ]),
    /must not contain a non-finite number/
  );
  assert.equal(engine.revision, before);
  assert.deepEqual(engine.world.query(EditorProbe).map((entity) => entity.get(EditorProbe).x), [1, 2]);
  assert.deepEqual(session.selection, [1, 2]);
  engine.destroy();
});

// @covers I1 I8 M1-b:undo M1-h:undo M1-h:world-replacement
test('一次详情编辑形成一次可撤销事务，并在世界替换后按 id 保留选择', async () => {
  const { engine } = await harness();
  const session = createEditorSession({ engine });
  session.setSelection([2]);
  const before = engine.revision;

  await session.patchComponent(EditorProbe.id, [{ entityId: 2, values: { mode: 'active' } }]);
  assert.equal(entityById(engine.world, 2).get(EditorProbe).mode, 'active');
  assert.deepEqual(session.selection, [2]);

  await session.undo();
  assert.equal(engine.revision, before);
  assert.equal(entityById(engine.world, 2).get(EditorProbe).mode, 'idle');
  assert.deepEqual(session.selection, [2]);
  engine.destroy();
});

// @covers I1 I7 I11 M1-h:gizmo M1-h:multi-transform meta:oracle-sensitivity
test('gizmo 世界位移为父子实体生成稳定本地 Transform 补丁并过滤无变化', () => {
  const world = createWorld();
  const parent = world.spawn(Transform({ x: 2 }));
  const child = world.spawn(Transform({ x: 3, parent }));
  const identity = transformPatchesFromWorldDelta(world, [child.id, parent.id], new Matrix4());
  assert.deepEqual(identity, [], '负例：无变化拖拽不得制造空撤销事务');

  const delta = new Matrix4().makeTranslation(5, 0, 0);
  const patches = transformPatchesFromWorldDelta(world, [child.id, parent.id], delta);
  assert.deepEqual(patches.map((patch) => patch.entityId), [parent.id]);
  assert.equal(patches[0].values.x, 7);
  assert.equal(child.get(Transform).x, 3, '父子同选时世界位移不得把父级位移重复写进子级 local x');

  const rotate = new Matrix4().makeRotationAxis(new Vector3(0, 1, 0), Math.PI / 2);
  const rotated = transformPatchesFromWorldDelta(world, [parent.id], rotate);
  assert.ok(Math.abs(rotated[0].values.qy) > 0.7);
  assert.ok(Math.abs(rotated[0].values.qw) > 0.7);
  world.destroy();
});

// @covers I1 I2 I7 M1-h:batch-atomicity M1-h:transform-validation meta:oracle-sensitivity
test('Transform 父级补丁在候选世界校验层级环，失败不得进入主世界', async () => {
  const registry = createActionRegistry().register(createEditorPatchAction());
  const world = createWorld();
  world.spawn(Transform());
  const engine = await createActionEngine({
    registry,
    world,
    runtimes: runtimes(),
    runtimeRegistry: runtimeRegistry(),
  });
  const session = createEditorSession({ engine });
  const before = engine.revision;
  const failed = await session.patchComponent(Transform.id, [{ entityId: 1, values: { parent: 1 } }]);

  assert.equal(failed.receipt.status, 'failed');
  assert.match(failed.receipt.failure.message, /cycle detected/);
  assert.equal(engine.revision, before);
  assert.equal(entityById(engine.world, 1).get(Transform).parent, null);
  engine.destroy();
});
