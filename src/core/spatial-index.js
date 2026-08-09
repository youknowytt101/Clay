function fail(message) {
  throw new TypeError(message);
}

function finite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}

function normalizeVector(value, path) {
  if (!value || typeof value !== 'object') fail(`${path} must be an object`);
  return Object.freeze({
    x: finite(value.x, `${path}.x`),
    y: finite(value.y, `${path}.y`),
    z: finite(value.z, `${path}.z`),
  });
}

function normalizeBounds(value, path = 'bounds') {
  if (!value || typeof value !== 'object') fail(`${path} must be an object`);
  const min = normalizeVector(value.min, `${path}.min`);
  const max = normalizeVector(value.max, `${path}.max`);
  for (const axis of ['x', 'y', 'z']) {
    if (min[axis] > max[axis]) fail(`${path}.min.${axis} must be <= max.${axis}`);
  }
  return Object.freeze({ min, max });
}

function entityId(entity, { allowId = false } = {}) {
  if (!allowId && (!entity || typeof entity !== 'object')) {
    fail('spatial item must be an entity object with a positive stable id');
  }
  const id = typeof entity === 'number' ? entity : entity?.id;
  if (!Number.isSafeInteger(id) || id < 1) fail('spatial item must have a positive stable entity id');
  return id;
}

function cellKey(x, y, z) {
  return `${x},${y},${z}`;
}

function cellKeys(bounds, cellSize) {
  const minX = Math.floor(bounds.min.x / cellSize);
  const minY = Math.floor(bounds.min.y / cellSize);
  const minZ = Math.floor(bounds.min.z / cellSize);
  const maxX = Math.floor(bounds.max.x / cellSize);
  const maxY = Math.floor(bounds.max.y / cellSize);
  const maxZ = Math.floor(bounds.max.z / cellSize);
  const result = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) result.push(cellKey(x, y, z));
    }
  }
  return result;
}

function intersects(a, b) {
  return a.min.x <= b.max.x && a.max.x >= b.min.x
    && a.min.y <= b.max.y && a.max.y >= b.min.y
    && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function rayDistance(bounds, origin, direction, maxDistance) {
  let near = 0;
  let far = maxDistance;
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(direction[axis]) < 1e-15) {
      if (origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis]) return null;
      continue;
    }
    let a = (bounds.min[axis] - origin[axis]) / direction[axis];
    let b = (bounds.max[axis] - origin[axis]) / direction[axis];
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  return near <= maxDistance ? near : null;
}

class GridSpatialIndex {
  constructor(cellSize) {
    this._cellSize = cellSize;
    this._entries = new Map();
    this._cells = new Map();
  }

  get size() {
    return this._entries.size;
  }

  insert(entity, inputBounds) {
    const id = entityId(entity);
    if (this._entries.has(id)) throw new Error(`entity ${id} is already in the spatial index`);
    const bounds = normalizeBounds(inputBounds);
    const keys = cellKeys(bounds, this._cellSize);
    const entry = { id, entity, bounds, keys };
    this._entries.set(id, entry);
    for (const key of keys) {
      let cell = this._cells.get(key);
      if (!cell) {
        cell = new Set();
        this._cells.set(key, cell);
      }
      cell.add(id);
    }
    return this;
  }

  update(entity, inputBounds) {
    const id = entityId(entity);
    const previous = this._entries.get(id);
    if (!previous) throw new Error(`entity ${id} is not in the spatial index`);
    const bounds = normalizeBounds(inputBounds);
    const keys = cellKeys(bounds, this._cellSize);
    const previousKeys = new Set(previous.keys);
    const nextKeys = new Set(keys);
    for (const key of previousKeys) {
      if (nextKeys.has(key)) continue;
      const cell = this._cells.get(key);
      cell.delete(id);
      if (cell.size === 0) this._cells.delete(key);
    }
    for (const key of nextKeys) {
      if (previousKeys.has(key)) continue;
      let cell = this._cells.get(key);
      if (!cell) {
        cell = new Set();
        this._cells.set(key, cell);
      }
      cell.add(id);
    }
    this._entries.set(id, { id, entity, bounds, keys });
    return this;
  }

  remove(entity) {
    const id = entityId(entity, { allowId: true });
    const entry = this._entries.get(id);
    if (!entry) return false;
    for (const key of entry.keys) {
      const cell = this._cells.get(key);
      cell.delete(id);
      if (cell.size === 0) this._cells.delete(key);
    }
    this._entries.delete(id);
    return true;
  }

  queryAabb(inputBounds) {
    const bounds = normalizeBounds(inputBounds);
    const candidateIds = new Set();
    for (const key of cellKeys(bounds, this._cellSize)) {
      for (const id of this._cells.get(key) ?? []) candidateIds.add(id);
    }
    return Object.freeze(
      [...candidateIds]
        .sort((a, b) => a - b)
        .map((id) => this._entries.get(id))
        .filter((entry) => intersects(entry.bounds, bounds) && entry.entity?.alive !== false)
        .map((entry) => entry.entity)
    );
  }

  raycast(inputOrigin, inputDirection, { maxDistance = Infinity } = {}) {
    const origin = normalizeVector(inputOrigin, 'origin');
    const rawDirection = normalizeVector(inputDirection, 'direction');
    const length = Math.hypot(rawDirection.x, rawDirection.y, rawDirection.z);
    if (length <= 1e-15) fail('direction must not be zero');
    if (typeof maxDistance !== 'number' || Number.isNaN(maxDistance) || maxDistance < 0) {
      fail('maxDistance must be a non-negative number');
    }
    const direction = {
      x: rawDirection.x / length,
      y: rawDirection.y / length,
      z: rawDirection.z / length,
    };
    const hits = [];
    for (const entry of this._entries.values()) {
      if (entry.entity?.alive === false) continue;
      const distance = rayDistance(entry.bounds, origin, direction, maxDistance);
      if (distance !== null) hits.push(Object.freeze({ entity: entry.entity, distance }));
    }
    hits.sort((a, b) => a.distance - b.distance || a.entity.id - b.entity.id);
    return Object.freeze(hits);
  }
}

export function createGridSpatialIndex({ cellSize = 4 } = {}) {
  finite(cellSize, 'cellSize');
  if (cellSize <= 0) fail('cellSize must be > 0');
  return new GridSpatialIndex(cellSize);
}

export function pickNearest(index, origin, direction, maxDistance = Infinity) {
  if (!index || typeof index.raycast !== 'function') fail('index must come from createGridSpatialIndex()');
  return index.raycast(origin, direction, { maxDistance })[0] ?? null;
}
