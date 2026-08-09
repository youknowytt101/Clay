// 注意：core 层在这里 import 了渲染库的数学类。不违反 I7（这些是纯 f64 数学类，
// headless 可跑，测试为证），但它是一处**分层泄漏**，且 decompose() 的 sqrt/atan2
// 不保证跨平台位级一致——而结果会进玩法断言。已登记为 U-046，与 U-025 同批实测；
// 不一致就把矩阵数学内联进 core 并自控算法。**在那之前不要扩大 three 在 core 的用量。**
import { Matrix4, Quaternion, Vector3 } from 'three';
import { defineComponent } from './ecs.js';

const QUATERNION_EPSILON = 1e-24;

export const Transform = defineComponent({
  id: 'core.transform',
  version: 1,
  schema: {
    x: { type: 'number', default: 0, unit: 'm', description: 'Local X position.' },
    y: { type: 'number', default: 0, unit: 'm', description: 'Local Y position.' },
    z: { type: 'number', default: 0, unit: 'm', description: 'Local Z position.' },
    qx: { type: 'number', default: 0, description: 'Local quaternion X.' },
    qy: { type: 'number', default: 0, description: 'Local quaternion Y.' },
    qz: { type: 'number', default: 0, description: 'Local quaternion Z.' },
    qw: { type: 'number', default: 1, description: 'Local quaternion W.' },
    sx: { type: 'number', default: 1, min: Number.MIN_VALUE, description: 'Local X scale.' },
    sy: { type: 'number', default: 1, min: Number.MIN_VALUE, description: 'Local Y scale.' },
    sz: { type: 'number', default: 1, min: Number.MIN_VALUE, description: 'Local Z scale.' },
    parent: { type: 'entity', default: null, description: 'Parent Transform entity.' },
  },
});

function assertTransformEntity(entity) {
  if (!entity || typeof entity.has !== 'function' || !entity.has(Transform)) {
    throw new TypeError('expected an entity with core.transform');
  }
}

function localMatrix(entity) {
  assertTransformEntity(entity);
  const value = entity.get(Transform);
  const lengthSq = value.qx * value.qx + value.qy * value.qy + value.qz * value.qz + value.qw * value.qw;
  if (lengthSq <= QUATERNION_EPSILON) {
    throw new Error(`Transform quaternion must not be zero on entity ${entity.id}`);
  }
  const quaternion = new Quaternion(value.qx, value.qy, value.qz, value.qw).normalize();
  return new Matrix4().compose(
    new Vector3(value.x, value.y, value.z),
    quaternion,
    new Vector3(value.sx, value.sy, value.sz)
  );
}

function resolveEntity(entity, cache, visiting) {
  const cached = cache.get(entity.id);
  if (cached) return cached;
  if (visiting.has(entity.id)) {
    throw new Error(`Transform hierarchy cycle detected at entity ${entity.id}`);
  }
  visiting.add(entity.id);
  try {
    const value = entity.get(Transform);
    const result = localMatrix(entity);
    if (value.parent !== null) {
      if (!value.parent.alive) {
        throw new Error(`Transform entity ${entity.id} has destroyed parent ${value.parent.id}`);
      }
      if (!value.parent.has(Transform)) {
        throw new Error(`Transform entity ${entity.id} parent ${value.parent.id} has no core.transform`);
      }
      result.premultiply(resolveEntity(value.parent, cache, visiting));
    }
    cache.set(entity.id, result);
    return result;
  } finally {
    visiting.delete(entity.id);
  }
}

export function getWorldMatrix(entity, target = new Matrix4()) {
  assertTransformEntity(entity);
  return target.copy(resolveEntity(entity, new Map(), new Set()));
}

export function getWorldTransform(entity) {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  getWorldMatrix(entity).decompose(position, quaternion, scale);
  return Object.freeze({
    position: Object.freeze({ x: position.x, y: position.y, z: position.z }),
    quaternion: Object.freeze({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }),
    scale: Object.freeze({ x: scale.x, y: scale.y, z: scale.z }),
  });
}

export function resolveWorldTransforms(world) {
  if (!world || typeof world.query !== 'function') throw new TypeError('world must come from createWorld()');
  const cache = new Map();
  const visiting = new Set();
  for (const entity of world.query(Transform)) resolveEntity(entity, cache, visiting);
  return cache;
}
