const CHUNK_ID = /^chunk:(-?\d+):(-?\d+):(-?\d+)$/;

function fail(message) {
  throw new TypeError(message);
}

function finite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be finite`);
  return value;
}

function point(value, path) {
  if (!value || typeof value !== 'object') fail(`${path} must be an object`);
  return Object.freeze({
    x: finite(value.x, `${path}.x`),
    y: finite(value.y, `${path}.y`),
    z: finite(value.z, `${path}.z`),
  });
}

function chunkId({ x, y, z }) {
  return `chunk:${x}:${y}:${z}`;
}

function parseChunkId(id) {
  if (typeof id !== 'string') fail('chunk id must be a string');
  const match = CHUNK_ID.exec(id);
  if (!match) fail(`chunk id ${id} must use chunk:x:y:z`);
  const coordinates = match.slice(1).map(Number);
  if (coordinates.some((value) => !Number.isSafeInteger(value))) fail(`chunk id ${id} exceeds safe integer coordinates`);
  return Object.freeze({ x: coordinates[0], y: coordinates[1], z: coordinates[2] });
}

class ChunkPolicy {
  constructor(size, origin) {
    this.size = size;
    this.origin = origin;
    Object.freeze(this);
  }

  idForPoint(input) {
    const value = point(input, 'point');
    return chunkId({
      x: Math.floor((value.x - this.origin.x) / this.size),
      y: Math.floor((value.y - this.origin.y) / this.size),
      z: Math.floor((value.z - this.origin.z) / this.size),
    });
  }

  coordinatesForId(id) {
    return parseChunkId(id);
  }

  boundsForId(id) {
    const coordinates = parseChunkId(id);
    const min = Object.freeze({
      x: this.origin.x + coordinates.x * this.size,
      y: this.origin.y + coordinates.y * this.size,
      z: this.origin.z + coordinates.z * this.size,
    });
    return Object.freeze({
      min,
      max: Object.freeze({ x: min.x + this.size, y: min.y + this.size, z: min.z + this.size }),
    });
  }

  idsAroundPoint(input, { radius = 0 } = {}) {
    if (!Number.isSafeInteger(radius) || radius < 0) fail('radius must be a non-negative safe integer');
    const center = parseChunkId(this.idForPoint(input));
    const ids = [];
    for (let x = center.x - radius; x <= center.x + radius; x++) {
      for (let y = center.y - radius; y <= center.y + radius; y++) {
        for (let z = center.z - radius; z <= center.z + radius; z++) ids.push(chunkId({ x, y, z }));
      }
    }
    return Object.freeze(ids);
  }
}

export function createChunkPolicy({ size, origin = { x: 0, y: 0, z: 0 } } = {}) {
  finite(size, 'size');
  if (size <= 0) fail('size must be > 0');
  return new ChunkPolicy(size, point(origin, 'origin'));
}
