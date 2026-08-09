import { getComponent, listComponents } from '../core/ecs.js';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { Transform, resolveWorldTransforms } from '../core/transform.js';

export const EDITOR_PATCH_ACTION = 'editor.patch-components';

function fail(message) {
  throw new TypeError(message);
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableIds(values) {
  if (!Array.isArray(values)) fail('selection must be an array of stable entity ids');
  const result = new Set();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1) fail('selection ids must be positive safe integers');
    result.add(value);
  }
  return [...result].sort((a, b) => a - b);
}

function entityMap(world) {
  if (!world || typeof world.query !== 'function') fail('world must come from createWorld()');
  return new Map(world.query().map((entity) => [entity.id, entity]));
}

function normalizePatches(input) {
  if (!Array.isArray(input) || input.length === 0) fail('patches must be a non-empty array');
  const ids = new Set();
  const patches = input.map((patch, index) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(`patches[${index}] must be an object`);
    if (!Number.isSafeInteger(patch.entityId) || patch.entityId < 1) {
      fail(`patches[${index}].entityId must be a positive safe integer`);
    }
    if (ids.has(patch.entityId)) fail(`patches contains duplicate entity ${patch.entityId}`);
    ids.add(patch.entityId);
    if (!patch.values || typeof patch.values !== 'object' || Array.isArray(patch.values)) {
      fail(`patches[${index}].values must be an object`);
    }
    const fields = Object.keys(patch.values).sort(compareAscii);
    if (fields.length === 0) fail(`patches[${index}].values must contain at least one field`);
    return {
      entityId: patch.entityId,
      values: Object.fromEntries(fields.map((field) => [field, patch.values[field]])),
    };
  });
  patches.sort((a, b) => a.entityId - b.entityId);
  return patches;
}

function decodeValues(component, values, entities) {
  const decoded = { ...values };
  for (const [fieldName, value] of Object.entries(decoded)) {
    const field = component.schema[fieldName];
    if (field?.type !== 'entity' || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 1 || !entities.has(value)) {
      fail(`${component.id}.${fieldName} must reference a live stable entity id or null`);
    }
    decoded[fieldName] = entities.get(value);
  }
  return decoded;
}

export function editorAffects({ componentId, patches } = {}) {
  if (typeof componentId !== 'string' || componentId.length === 0) fail('componentId must be a non-empty string');
  const affects = [];
  for (const patch of normalizePatches(patches)) {
    for (const field of Object.keys(patch.values)) {
      affects.push(`entity:${patch.entityId}/component:${componentId}/field:${field}`);
    }
  }
  return Object.freeze(affects.sort(compareAscii));
}

export function createEditorPatchAction() {
  return {
    id: EDITOR_PATCH_ACTION,
    paramsSchema: {
      type: 'object',
      properties: {
        componentId: { type: 'string', minLength: 1 },
        patches: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              entityId: { type: 'integer', minimum: 1 },
              values: { type: 'object', properties: {}, additionalProperties: true },
            },
            required: ['entityId', 'values'],
            additionalProperties: false,
          },
        },
      },
      required: ['componentId', 'patches'],
      additionalProperties: false,
    },
    precondition: ({ world }, params) => {
      const component = getComponent(params.componentId);
      if (!component) {
        return {
          at: `component:${params.componentId}`,
          observed: 'missing',
          limit: 'component must be registered',
          alternatives: [],
        };
      }
      const entities = entityMap(world);
      for (const patch of normalizePatches(params.patches)) {
        const entity = entities.get(patch.entityId);
        if (!entity || !entity.has(component)) {
          return {
            at: `entity:${patch.entityId}/component:${params.componentId}`,
            observed: entity ? 'component-missing' : 'entity-missing',
            limit: 'every patched entity must own the component',
            alternatives: [],
          };
        }
      }
      return true;
    },
    affects: (_context, params) => editorAffects(params),
    reversible: true,
    describe: {
      title: 'Patch component fields',
      summary: 'Apply one atomic schema-validated field patch to one or more entities.',
      tags: ['editor', 'component', 'inspector'],
    },
    apply: ({ world }, params) => {
      const component = getComponent(params.componentId);
      const entities = entityMap(world);
      for (const patch of normalizePatches(params.patches)) {
        entities.get(patch.entityId).set(component, decodeValues(component, patch.values, entities));
      }
      if (component === Transform) resolveWorldTransforms(world);
    },
  };
}

function comparable(value) {
  if (value && typeof value === 'object' && Number.isSafeInteger(value.id)) return `entity:${value.id}`;
  return value;
}

function matrixFrom(value, path) {
  if (value instanceof Matrix4) return value;
  if (!Array.isArray(value) || value.length !== 16 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    fail(`${path} must be a Matrix4 or 16 finite matrix elements`);
  }
  return new Matrix4().fromArray(value);
}

export function transformPatchesFromWorldDelta(world, inputIds, inputDelta) {
  const ids = stableIds(inputIds);
  const delta = matrixFrom(inputDelta, 'world delta');
  const entities = entityMap(world);
  const worldMatrices = resolveWorldTransforms(world);
  const selected = new Set(ids);
  const targetWorldMatrices = new Map(
    ids
      .filter((id) => worldMatrices.has(id))
      .map((id) => [id, delta.clone().multiply(worldMatrices.get(id))])
  );
  const patches = [];
  for (const id of ids) {
    const entity = entities.get(id);
    if (!entity?.has(Transform)) continue;
    const current = entity.get(Transform);
    const worldMatrix = targetWorldMatrices.get(id);
    const localMatrix = current.parent
      ? (selected.has(current.parent.id) ? targetWorldMatrices : worldMatrices)
          .get(current.parent.id).clone().invert().multiply(worldMatrix)
      : worldMatrix;
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    localMatrix.decompose(position, quaternion, scale);
    quaternion.normalize();
    const values = {
      x: position.x, y: position.y, z: position.z,
      qx: quaternion.x, qy: quaternion.y, qz: quaternion.z, qw: quaternion.w,
      sx: Math.max(scale.x, Number.MIN_VALUE),
      sy: Math.max(scale.y, Number.MIN_VALUE),
      sz: Math.max(scale.z, Number.MIN_VALUE),
    };
    if (Object.entries(values).some(([field, value]) => Math.abs(current[field] - value) > 1e-9)) {
      patches.push(Object.freeze({ entityId: id, values: Object.freeze(values) }));
    }
  }
  return Object.freeze(patches);
}

export function describeSelection(world, inputIds) {
  const ids = stableIds(inputIds);
  const byId = entityMap(world);
  const entities = ids.map((id) => byId.get(id)).filter(Boolean);
  if (entities.length === 0) return Object.freeze({ count: 0, ids: Object.freeze([]), components: Object.freeze([]) });

  const components = listComponents()
    .filter((component) => entities.every((entity) => entity.has(component)))
    .map((component) => {
      const fields = Object.entries(component.schema).map(([name, schema]) => {
        const values = entities.map((entity) => entity.get(component)[name]);
        const first = comparable(values[0]);
        const mixed = values.some((value) => !Object.is(comparable(value), first));
        return Object.freeze({
          name,
          schema,
          mixed,
          value: mixed ? undefined : values[0],
        });
      });
      return Object.freeze({ id: component.id, version: component.version, component, fields: Object.freeze(fields) });
    });
  return Object.freeze({
    count: entities.length,
    ids: Object.freeze(entities.map((entity) => entity.id)),
    components: Object.freeze(components),
  });
}

export function createEditorSession({ engine, bridge = null, onChange = null } = {}) {
  if (!engine || typeof engine.previewStep !== 'function' || typeof engine.commit !== 'function') {
    fail('engine must come from createActionEngine()');
  }
  if (bridge && (typeof bridge.setWorld !== 'function' || typeof bridge.sync !== 'function')) {
    fail('bridge must support setWorld() and sync()');
  }
  if (onChange !== null && typeof onChange !== 'function') fail('onChange must be a function');

  let selection = [];
  let sequence = 0;
  const listeners = new Set(onChange ? [onChange] : []);

  function emit(kind, data = {}) {
    const event = Object.freeze({ kind, selection: Object.freeze([...selection]), world: engine.world, ...data });
    for (const listener of listeners) listener(event);
  }

  function refreshBridge() {
    if (!bridge) return;
    bridge.setWorld(engine.world);
    bridge.sync();
  }

  const session = {
    get world() {
      return engine.world;
    },

    get revision() {
      return engine.revision;
    },

    get canUndo() {
      return engine.canUndo;
    },

    get selection() {
      return Object.freeze([...selection]);
    },

    subscribe(listener) {
      if (typeof listener !== 'function') fail('selection listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setSelection(ids, { mode = 'replace' } = {}) {
      const next = stableIds(ids);
      if (mode === 'replace') selection = next;
      else if (mode === 'add') selection = stableIds([...selection, ...next]);
      else if (mode === 'toggle') {
        const toggled = new Set(selection);
        for (const id of next) toggled.has(id) ? toggled.delete(id) : toggled.add(id);
        selection = [...toggled].sort((a, b) => a - b);
      } else fail('selection mode must be replace, add, or toggle');
      emit('selection');
      return session.selection;
    },

    clearSelection() {
      selection = [];
      emit('selection');
    },

    pruneSelection() {
      const live = new Set(engine.world.query().map((entity) => entity.id));
      const next = selection.filter((id) => live.has(id));
      if (next.length !== selection.length) {
        selection = next;
        emit('selection');
      }
      return session.selection;
    },

    describeSelection() {
      return describeSelection(engine.world, selection);
    },

    async patchComponent(componentId, inputPatches) {
      const patches = normalizePatches(inputPatches);
      const params = { componentId, patches };
      const serial = ++sequence;
      const runId = `editor-${serial}`;
      const stepId = 'patch-components';
      const preview = await engine.previewStep({
        runId,
        stepId,
        baseRevision: engine.revision,
        beforeRevision: engine.revision,
        idempotencyKey: `${runId}/${stepId}`,
        allowedActions: [EDITOR_PATCH_ACTION],
        allowedAffects: editorAffects(params),
        actions: [{ id: EDITOR_PATCH_ACTION, params }],
      });
      if (preview.receipt.status !== 'passed') {
        emit('failed', { receipt: preview.receipt });
        return preview;
      }
      const result = await engine.commit(preview);
      refreshBridge();
      session.pruneSelection();
      emit('commit', { receipt: result.receipt, checkpoint: result.checkpoint });
      return result;
    },

    async undo() {
      const result = await engine.undo();
      refreshBridge();
      session.pruneSelection();
      emit('undo', { result });
      return result;
    },
  };
  return Object.freeze(session);
}
