import { Box3, Matrix4, Object3D, Vector3 } from 'three';
import { pickNearest } from '../core/spatial-index.js';
import { Transform, resolveWorldTransforms } from '../core/transform.js';

const bridgeState = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function matrixSignature(matrix) {
  return matrix.elements.join(',');
}

function boundsSignature(bounds) {
  if (!bounds) return '';
  return [
    bounds.min.x, bounds.min.y, bounds.min.z,
    bounds.max.x, bounds.max.y, bounds.max.z,
  ].join(',');
}

function normalizeLocalBounds(value) {
  if (!value) return null;
  for (const side of ['min', 'max']) {
    if (!value[side] || typeof value[side] !== 'object') fail(`local bounds.${side} must be an object`);
    for (const axis of ['x', 'y', 'z']) {
      if (typeof value[side][axis] !== 'number' || !Number.isFinite(value[side][axis])) {
        fail(`local bounds.${side}.${axis} must be finite`);
      }
    }
  }
  for (const axis of ['x', 'y', 'z']) {
    if (value.min[axis] > value.max[axis]) fail(`local bounds.min.${axis} must be <= max.${axis}`);
  }
  return value;
}

function transformBounds(localBounds, matrix) {
  const local = normalizeLocalBounds(localBounds);
  if (!local) return null;
  const box = new Box3(
    new Vector3(local.min.x, local.min.y, local.min.z),
    new Vector3(local.max.x, local.max.y, local.max.z)
  ).applyMatrix4(matrix);
  return Object.freeze({
    min: Object.freeze({ x: box.min.x, y: box.min.y, z: box.min.z }),
    max: Object.freeze({ x: box.max.x, y: box.max.y, z: box.max.z }),
  });
}

function applyMatrix(object, matrix) {
  object.matrixAutoUpdate = false;
  object.matrix.copy(matrix);
  object.matrixWorldNeedsUpdate = true;
}

function matrixEquals(object, matrix) {
  return object.matrix.elements.every((value, index) => value === matrix.elements[index]);
}

class RenderBridge {
  setWorld(world) {
    const state = bridgeState.get(this);
    if (!state || state.destroyed) throw new Error('render bridge has been destroyed');
    if (!world || typeof world.query !== 'function') fail('world must come from createWorld()');
    state.world = world;
    return this;
  }

  sync() {
    const state = bridgeState.get(this);
    if (!state || state.destroyed) throw new Error('render bridge has been destroyed');
    const entities = state.world.query(Transform).map((entity) => entity);
    const matrices = resolveWorldTransforms(state.world);
    const aliveIds = new Set(entities.map((entity) => entity.id));
    const staged = [];

    try {
      for (const entity of entities) {
        if (state.records.has(entity.id)) continue;
        const object = state.createObject(entity);
        if (!(object instanceof Object3D)) fail(`createObject for entity ${entity.id} must return a Three.js Object3D`);
        const matrix = matrices.get(entity.id);
        const bounds = state.boundsForEntity
          ? transformBounds(state.boundsForEntity(entity), matrix)
          : null;
        staged.push({ entity, object, matrix, bounds });
      }
    } catch (error) {
      for (const item of staged) state.disposeObject(item.object, item.entity);
      throw error;
    }

    let created = 0;
    let updated = 0;
    let removed = 0;
    for (const item of staged) {
      applyMatrix(item.object, item.matrix);
      item.object.userData.clayEntityId = item.entity.id;
      state.scene.add(item.object);
      if (state.spatialIndex && item.bounds) state.spatialIndex.insert(item.entity, item.bounds);
      state.records.set(item.entity.id, {
        entity: item.entity,
        object: item.object,
        matrixSignature: matrixSignature(item.matrix),
        boundsSignature: boundsSignature(item.bounds),
        indexed: Boolean(state.spatialIndex && item.bounds),
      });
      created++;
    }

    for (const entity of entities) {
      const record = state.records.get(entity.id);
      if (!record || staged.some((item) => item.entity.id === entity.id)) continue;
      const matrix = matrices.get(entity.id);
      const bounds = state.boundsForEntity
        ? transformBounds(state.boundsForEntity(entity), matrix)
        : null;
      const nextMatrixSignature = matrixSignature(matrix);
      const nextBoundsSignature = boundsSignature(bounds);
      const entityChanged = record.entity !== entity;
      if (record.matrixSignature === nextMatrixSignature
        && record.boundsSignature === nextBoundsSignature
        && matrixEquals(record.object, matrix)
        && !entityChanged) continue;
      applyMatrix(record.object, matrix);
      if (state.spatialIndex) {
        if (bounds && record.indexed) state.spatialIndex.update(entity, bounds);
        else if (bounds) state.spatialIndex.insert(entity, bounds);
        else if (record.indexed) state.spatialIndex.remove(entity);
        record.indexed = Boolean(bounds);
      }
      record.entity = entity;
      record.matrixSignature = nextMatrixSignature;
      record.boundsSignature = nextBoundsSignature;
      updated++;
    }

    for (const [id, record] of [...state.records]) {
      if (aliveIds.has(id)) continue;
      state.scene.remove(record.object);
      if (record.indexed) state.spatialIndex.remove(id);
      state.disposeObject(record.object, record.entity);
      state.records.delete(id);
      removed++;
    }
    return Object.freeze({ created, updated, removed });
  }

  getObject(entity) {
    const state = bridgeState.get(this);
    const id = typeof entity === 'number' ? entity : entity?.id;
    return state?.records.get(id)?.object ?? null;
  }

  getEntityForObject(object) {
    const state = bridgeState.get(this);
    for (let current = object; current && current !== state.scene; current = current.parent) {
      const id = current.userData?.clayEntityId;
      if (id !== undefined) return state.records.get(id)?.entity ?? null;
    }
    return null;
  }

  pick(origin, direction, { maxDistance = Infinity } = {}) {
    const state = bridgeState.get(this);
    if (!state?.spatialIndex) throw new Error('render bridge picking requires a spatial index');
    return pickNearest(state.spatialIndex, origin, direction, maxDistance);
  }

  destroy() {
    const state = bridgeState.get(this);
    if (!state || state.destroyed) return;
    for (const record of state.records.values()) {
      state.scene.remove(record.object);
      if (record.indexed) state.spatialIndex.remove(record.entity);
      state.disposeObject(record.object, record.entity);
    }
    state.records.clear();
    state.destroyed = true;
  }
}

export function createRenderBridge({
  world,
  scene,
  createObject,
  disposeObject = () => {},
  spatialIndex = null,
  boundsForEntity = null,
} = {}) {
  if (!world || typeof world.query !== 'function') fail('world must come from createWorld()');
  if (!(scene instanceof Object3D)) fail('scene must be a Three.js Object3D');
  if (typeof createObject !== 'function') fail('createObject must be a function');
  if (typeof disposeObject !== 'function') fail('disposeObject must be a function');
  if (spatialIndex && (typeof spatialIndex.insert !== 'function' || typeof spatialIndex.update !== 'function')) {
    fail('spatialIndex must come from createGridSpatialIndex()');
  }
  if (boundsForEntity !== null && typeof boundsForEntity !== 'function') fail('boundsForEntity must be a function');
  if (spatialIndex && !boundsForEntity) fail('boundsForEntity is required with a spatial index');
  const bridge = new RenderBridge();
  bridgeState.set(bridge, {
    world,
    scene,
    createObject,
    disposeObject,
    spatialIndex,
    boundsForEntity,
    records: new Map(),
    destroyed: false,
  });
  return bridge;
}
