import { resolveWorldTransforms } from '../core/transform.js';

const streamerState = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeChunkIds(policy, input) {
  if (!Array.isArray(input)) fail('chunk ids must be an array');
  const ids = [...new Set(input)].sort(compareAscii);
  for (const id of ids) policy.coordinatesForId(id);
  return Object.freeze(ids);
}

function matrixPoint(matrix) {
  const elements = matrix?.elements;
  if (!Array.isArray(elements) || elements.length !== 16) fail('world matrix must expose 16 elements');
  return Object.freeze({ x: elements[12], y: elements[13], z: elements[14] });
}

export function createTransformChunkResolver(policy, { residentChunkId = 'resident' } = {}) {
  if (!policy || typeof policy.idForPoint !== 'function') fail('policy must come from createChunkPolicy()');
  if (typeof residentChunkId !== 'string' || residentChunkId.length === 0) fail('residentChunkId must be a non-empty string');
  const matricesByContext = new WeakMap();
  return (entity, context) => {
    if (!context || typeof context !== 'object' || !context.world) {
      fail('Transform chunk resolution requires the serialization world context');
    }
    let matrices = matricesByContext.get(context);
    if (!matrices) {
      matrices = resolveWorldTransforms(context.world);
      matricesByContext.set(context, matrices);
    }
    const matrix = matrices.get(entity.id);
    if (!matrix) return residentChunkId;
    return policy.idForPoint(matrixPoint(matrix));
  };
}

class ChunkStreamer {
  get activeChunks() {
    return Object.freeze([...streamerState.get(this).active].sort(compareAscii));
  }

  transition(inputIds) {
    const state = streamerState.get(this);
    const afterChunks = normalizeChunkIds(state.policy, inputIds);
    const beforeChunks = Object.freeze([...state.active].sort(compareAscii));
    const before = new Set(beforeChunks);
    const after = new Set(afterChunks);
    const loaded = Object.freeze(afterChunks.filter((id) => !before.has(id)));
    const unloaded = Object.freeze(beforeChunks.filter((id) => !after.has(id)));
    state.active = after;
    let projection;
    try {
      projection = state.bridge.sync();
    } catch (error) {
      state.active = before;
      throw error;
    }
    return Object.freeze({ beforeChunks, afterChunks, loaded, unloaded, projection });
  }

  transitionAround(point, options) {
    const state = streamerState.get(this);
    return this.transition(state.policy.idsAroundPoint(point, options));
  }

  refresh() {
    return streamerState.get(this).bridge.sync();
  }
}

export function createChunkStreamer({ bridge, policy, initialChunks = [] } = {}) {
  if (!bridge || typeof bridge.setEntityFilter !== 'function' || typeof bridge.sync !== 'function') {
    fail('bridge must come from createRenderBridge()');
  }
  if (!policy || typeof policy.idForPoint !== 'function' || typeof policy.coordinatesForId !== 'function') {
    fail('policy must come from createChunkPolicy()');
  }
  const streamer = new ChunkStreamer();
  const state = {
    bridge,
    policy,
    active: new Set(normalizeChunkIds(policy, initialChunks)),
  };
  streamerState.set(streamer, state);
  bridge.setEntityFilter((_entity, { matrix }) => state.active.has(policy.idForPoint(matrixPoint(matrix))));
  return Object.freeze(streamer);
}
