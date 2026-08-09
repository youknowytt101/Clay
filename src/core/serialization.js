import {
  createWorld,
  getComponent,
  listComponents,
  restoreEntity,
} from './ecs.js';
import { PHYSICS_RUNTIME_REQUIREMENT } from './runtime-versions.js';

export const WORLD_FORMAT = 'clay.world';
export const WORLD_FORMAT_VERSION = 1;
const CHUNK_FORMAT_VERSION = 1;
const WORLD_MIGRATIONS = Object.freeze({});
const ENTITY_REF = '$entity';

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
}

function assertExactVersion(value, path) {
  assertNonEmptyString(value, path);
  if (/^[~^*<>=]/.test(value) || /\s/.test(value)) fail(`${path} must be an exact version`);
}

function canonicalize(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must not contain a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail(`${path} must contain only JSON values`);
  if (seen.has(value)) fail(`${path} must not contain a cycle`);
  seen.add(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) fail(`${path} must contain only plain objects`);
    result = {};
    for (const key of Object.keys(value).sort(compareAscii)) {
      result[key] = canonicalize(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
  return result;
}

function canonicalClone(value) {
  return canonicalize(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function envelopeContent(envelope) {
  const content = canonicalClone(envelope);
  delete content.revision;
  return content;
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required for revisions');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function revisionFor(envelope) {
  return `sha256:${await sha256(JSON.stringify(envelopeContent(envelope)))}`;
}

function validateRuntimeRequirements(runtimes) {
  if (!Array.isArray(runtimes)) fail('envelope.runtimes must be an array');
  const ids = new Set();
  for (const [index, runtime] of runtimes.entries()) {
    if (!isPlainObject(runtime)) fail(`envelope.runtimes[${index}] must be an object`);
    assertNonEmptyString(runtime.id, `envelope.runtimes[${index}].id`);
    assertExactVersion(runtime.version, `envelope.runtimes[${index}].version`);
    if (ids.has(runtime.id)) fail(`envelope has duplicate runtime requirement ${runtime.id}`);
    ids.add(runtime.id);
  }
}

function requirePhysicsRuntime(runtimes) {
  if (!runtimes.some((runtime) => runtime.id === PHYSICS_RUNTIME_REQUIREMENT.id)) {
    fail(`world snapshots must include runtime ${PHYSICS_RUNTIME_REQUIREMENT.id}`);
  }
}

function validateEnvelopeShape(envelope) {
  if (!isPlainObject(envelope)) fail('envelope must be an object');
  if (envelope.format !== WORLD_FORMAT) fail(`envelope.format must be ${WORLD_FORMAT}`);
  if (!Number.isInteger(envelope.version) || envelope.version < 1) fail('envelope.version must be a positive integer');
  if (typeof envelope.revision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(envelope.revision)) {
    fail('envelope.revision must be a SHA-256 revision');
  }
  validateRuntimeRequirements(envelope.runtimes);
  requirePhysicsRuntime(envelope.runtimes);
  if (!Array.isArray(envelope.chunks)) fail('envelope.chunks must be an array');

  const chunkIds = new Set();
  const entityIds = new Set();
  for (const [chunkIndex, chunk] of envelope.chunks.entries()) {
    const chunkPath = `envelope.chunks[${chunkIndex}]`;
    if (!isPlainObject(chunk)) fail(`${chunkPath} must be an object`);
    assertNonEmptyString(chunk.id, `${chunkPath}.id`);
    if (chunkIds.has(chunk.id)) fail(`envelope has duplicate chunk ${chunk.id}`);
    chunkIds.add(chunk.id);
    if (chunk.version !== CHUNK_FORMAT_VERSION) fail(`${chunkPath}.version must be ${CHUNK_FORMAT_VERSION}`);
    canonicalClone(chunk.payload);
    if (!Array.isArray(chunk.entities)) fail(`${chunkPath}.entities must be an array`);

    let previousEntityId = 0;
    for (const [entityIndex, entity] of chunk.entities.entries()) {
      const entityPath = `${chunkPath}.entities[${entityIndex}]`;
      if (!isPlainObject(entity)) fail(`${entityPath} must be an object`);
      if (!Number.isSafeInteger(entity.id) || entity.id < 1) fail(`${entityPath}.id must be a positive safe integer`);
      if (entity.id <= previousEntityId) fail(`${chunkPath}.entities must be sorted by stable id`);
      previousEntityId = entity.id;
      if (entityIds.has(entity.id)) fail(`envelope has duplicate entity id ${entity.id}`);
      entityIds.add(entity.id);
      if (!Array.isArray(entity.components)) fail(`${entityPath}.components must be an array`);

      let previousComponentId = '';
      for (const [componentIndex, component] of entity.components.entries()) {
        const componentPath = `${entityPath}.components[${componentIndex}]`;
        if (!isPlainObject(component)) fail(`${componentPath} must be an object`);
        assertNonEmptyString(component.id, `${componentPath}.id`);
        if (previousComponentId && compareAscii(previousComponentId, component.id) >= 0) {
          fail(`${entityPath}.components must be sorted by component id without duplicates`);
        }
        previousComponentId = component.id;
        if (!Number.isInteger(component.version) || component.version < 1) {
          fail(`${componentPath}.version must be a positive integer`);
        }
        if (!isPlainObject(component.data)) fail(`${componentPath}.data must be an object`);
        canonicalClone(component.data);
      }
    }
  }
}

async function verifyEnvelope(envelope) {
  const clone = canonicalClone(envelope);
  validateEnvelopeShape(clone);
  const expected = await revisionFor(clone);
  if (clone.revision !== expected) {
    throw new Error(`revision mismatch: expected ${expected}, received ${clone.revision}`);
  }
  return deepFreeze(clone);
}

export function stringifyEnvelope(envelope) {
  return JSON.stringify(canonicalClone(envelope));
}

export async function sealEnvelope(draft) {
  const content = envelopeContent(draft);
  const sealed = { ...content, revision: await revisionFor(content) };
  validateEnvelopeShape(sealed);
  return deepFreeze(canonicalClone(sealed));
}

export async function parseEnvelope(json) {
  if (typeof json !== 'string') fail('envelope JSON must be a string');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SyntaxError(`invalid envelope JSON: ${error.message}`, { cause: error });
  }
  return verifyEnvelope(parsed);
}

export function migrateEnvelope(envelope, { targetVersion, migrations }) {
  if (!isPlainObject(envelope)) fail('envelope must be an object');
  if (!Number.isInteger(envelope.version) || envelope.version < 1) fail('envelope.version must be a positive integer');
  if (!Number.isInteger(targetVersion) || targetVersion < envelope.version) {
    fail('targetVersion must be an integer not lower than envelope.version');
  }
  if (!isPlainObject(migrations)) fail('migrations must be an object');

  let current = envelopeContent(envelope);
  while (current.version < targetVersion) {
    const fromVersion = current.version;
    const migration = migrations[fromVersion];
    if (typeof migration !== 'function') {
      throw new Error(`missing envelope migration ${fromVersion} -> ${fromVersion + 1}`);
    }
    current = migration(canonicalClone(current));
    if (!isPlainObject(current)) {
      fail(`envelope migration ${fromVersion} -> ${fromVersion + 1} must return an object`);
    }
    if (current.version !== fromVersion + 1) {
      fail(`envelope migration ${fromVersion} -> ${fromVersion + 1} must set version ${fromVersion + 1}`);
    }
  }
  return deepFreeze(canonicalClone(current));
}

class RuntimeRegistry {
  constructor() {
    this._runtimes = new Map();
  }

  register(id, version, runtime) {
    assertNonEmptyString(id, 'runtime id');
    assertExactVersion(version, 'runtime version');
    if (runtime === undefined || runtime === null) fail('runtime implementation is required');
    let versions = this._runtimes.get(id);
    if (!versions) {
      versions = new Map();
      this._runtimes.set(id, versions);
    }
    if (versions.has(version)) throw new Error(`runtime ${id} ${version} is already registered`);
    versions.set(version, runtime);
    return this;
  }

  resolve(requirements) {
    validateRuntimeRequirements(requirements);
    const resolved = new Map();
    for (const { id, version } of requirements) {
      const runtime = this._runtimes.get(id)?.get(version);
      if (!runtime) throw new Error(`snapshot requires ${id} ${version}, but that exact version is not registered`);
      resolved.set(id, runtime);
    }
    return resolved;
  }
}

export function createRuntimeRegistry() {
  return new RuntimeRegistry();
}

function normalizeRuntimes(runtimes) {
  validateRuntimeRequirements(runtimes);
  requirePhysicsRuntime(runtimes);
  return runtimes
    .map(({ id, version }) => ({ id, version }))
    .sort((a, b) => compareAscii(a.id, b.id));
}

function normalizeChunkPayloads(input) {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input ?? {});
  const result = new Map();
  for (const [id, payload] of entries) {
    assertNonEmptyString(id, 'chunk id');
    if (result.has(id)) fail(`duplicate chunk payload ${id}`);
    result.set(id, canonicalClone(payload));
  }
  return result;
}

function encodeComponentData(entity, component) {
  const values = entity.get(component);
  const data = {};
  for (const [fieldName, field] of Object.entries(component.schema)) {
    if (field.transient) continue;
    const value = values[fieldName];
    data[fieldName] = field.type === 'entity'
      ? (value === null ? null : { [ENTITY_REF]: value.id })
      : value;
  }
  return canonicalClone(data);
}

export async function createWorldEnvelope(world, {
  runtimes,
  chunkForEntity = () => 'main',
  chunkPayloads = {},
} = {}) {
  if (typeof chunkForEntity !== 'function') fail('chunkForEntity must be a function');
  const chunks = new Map();
  for (const [id, payload] of normalizeChunkPayloads(chunkPayloads)) {
    chunks.set(id, { id, version: CHUNK_FORMAT_VERSION, entities: [], payload });
  }

  const components = listComponents();
  for (const entity of world.query()) {
    const chunkId = chunkForEntity(entity);
    assertNonEmptyString(chunkId, `chunk id for entity ${entity.id}`);
    let chunk = chunks.get(chunkId);
    if (!chunk) {
      chunk = { id: chunkId, version: CHUNK_FORMAT_VERSION, entities: [], payload: null };
      chunks.set(chunkId, chunk);
    }
    const serializedComponents = [];
    for (const component of components) {
      if (!entity.has(component)) continue;
      serializedComponents.push({
        id: component.id,
        version: component.version,
        data: encodeComponentData(entity, component),
      });
    }
    chunk.entities.push({ id: entity.id, components: serializedComponents });
  }

  const orderedChunks = [...chunks.values()]
    .sort((a, b) => compareAscii(a.id, b.id))
    .map((chunk) => ({
      ...chunk,
      entities: chunk.entities.sort((a, b) => a.id - b.id),
    }));

  return sealEnvelope({
    format: WORLD_FORMAT,
    version: WORLD_FORMAT_VERSION,
    runtimes: normalizeRuntimes(runtimes),
    chunks: orderedChunks,
  });
}

export function getEnvelopeChunk(envelope, id) {
  assertNonEmptyString(id, 'chunk id');
  const chunk = envelope.chunks?.find((item) => item.id === id);
  if (!chunk) throw new Error(`chunk ${id} does not exist`);
  return deepFreeze(canonicalClone(chunk));
}

function migrateSerializedComponent(component, fromVersion, data) {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) fail(`${component.id} data version must be positive`);
  if (fromVersion > component.version) {
    throw new Error(`${component.id} data version ${fromVersion} is newer than registered version ${component.version}`);
  }
  let current = canonicalClone(data);
  for (let version = fromVersion; version < component.version; version++) {
    const migration = component.migrations[version];
    if (typeof migration !== 'function') throw new Error(`${component.id} is missing migration ${version} -> ${version + 1}`);
    current = migration(canonicalClone(current));
    if (!isPlainObject(current)) fail(`${component.id} migration ${version} -> ${version + 1} must return an object`);
  }
  return current;
}

function decodeComponentData(component, record) {
  const migrated = migrateSerializedComponent(component, record.version, record.data);
  const values = { ...migrated };
  const references = [];

  for (const [fieldName, field] of Object.entries(component.schema)) {
    if (field.transient) {
      delete values[fieldName];
      continue;
    }
    if (field.type !== 'entity') continue;
    const encoded = Object.hasOwn(values, fieldName) ? values[fieldName] : null;
    if (encoded === null) {
      values[fieldName] = null;
      continue;
    }
    if (!isPlainObject(encoded) || !Number.isSafeInteger(encoded[ENTITY_REF]) || encoded[ENTITY_REF] < 1) {
      fail(`${component.id}.${fieldName} must contain a serialized entity reference`);
    }
    references.push({ fieldName, targetId: encoded[ENTITY_REF] });
    values[fieldName] = null;
  }
  return { values, references };
}

async function normalizeEnvelopeInput(input) {
  const envelope = typeof input === 'string'
    ? await parseEnvelope(input)
    : await verifyEnvelope(input);
  if (envelope.version > WORLD_FORMAT_VERSION) {
    throw new Error(`world format ${envelope.version} is newer than supported version ${WORLD_FORMAT_VERSION}`);
  }
  if (envelope.version < WORLD_FORMAT_VERSION) {
    return sealEnvelope(migrateEnvelope(envelope, {
      targetVersion: WORLD_FORMAT_VERSION,
      migrations: WORLD_MIGRATIONS,
    }));
  }
  return envelope;
}

export async function loadWorldEnvelope(input, { runtimeRegistry } = {}) {
  if (!(runtimeRegistry instanceof RuntimeRegistry)) fail('runtimeRegistry must come from createRuntimeRegistry()');
  const envelope = await normalizeEnvelopeInput(input);
  const runtimes = runtimeRegistry.resolve(envelope.runtimes);
  const world = createWorld();
  const entitiesById = new Map();
  const pendingReferences = [];
  const chunkByEntityId = new Map();
  const chunkPayloads = new Map(
    envelope.chunks.map((chunk) => [chunk.id, deepFreeze(canonicalClone(chunk.payload))])
  );

  try {
    for (const chunk of envelope.chunks) {
      for (const entity of chunk.entities) chunkByEntityId.set(entity.id, chunk.id);
    }
    const records = envelope.chunks
      .flatMap((chunk) => chunk.entities)
      .sort((a, b) => a.id - b.id);

    for (const record of records) {
      const initializers = [];
      const decodedComponents = [];
      for (const componentRecord of record.components) {
        const component = getComponent(componentRecord.id);
        if (!component) throw new Error(`component ${componentRecord.id} is not registered`);
        const decoded = decodeComponentData(component, componentRecord);
        initializers.push(component(decoded.values));
        decodedComponents.push({ component, references: decoded.references });
      }
      const entity = restoreEntity(world, record.id, ...initializers);
      entitiesById.set(entity.id, entity);
      for (const { component, references } of decodedComponents) {
        for (const reference of references) pendingReferences.push({ entity, component, ...reference });
      }
    }

    for (const { entity, component, fieldName, targetId } of pendingReferences) {
      const target = entitiesById.get(targetId);
      if (!target) throw new Error(`${component.id}.${fieldName} references missing entity ${targetId}`);
      entity.set(component, { [fieldName]: target });
    }
  } catch (error) {
    world.destroy();
    throw error;
  }

  let currentEnvelope;
  try {
    currentEnvelope = await createWorldEnvelope(world, {
      runtimes: envelope.runtimes,
      chunkForEntity: (entity) => chunkByEntityId.get(entity.id),
      chunkPayloads,
    });
  } catch (error) {
    world.destroy();
    throw error;
  }

  return Object.freeze({
    world,
    sourceRevision: envelope.revision,
    revision: currentEnvelope.revision,
    envelope: currentEnvelope,
    runtimes,
    chunkPayloads,
  });
}

class CheckpointStore {
  constructor(runtimeRegistry) {
    this._runtimeRegistry = runtimeRegistry;
    this._snapshots = new Map();
  }

  async save(name, world, options) {
    assertNonEmptyString(name, 'checkpoint name');
    if (this._snapshots.has(name)) throw new Error(`checkpoint ${name} already exists`);
    const envelope = await createWorldEnvelope(world, options);
    this._snapshots.set(name, stringifyEnvelope(envelope));
    return Object.freeze({ name, revision: envelope.revision });
  }

  list() {
    return Object.freeze(
      [...this._snapshots.entries()]
        .map(([name, json]) => ({ name, revision: JSON.parse(json).revision }))
        .sort((a, b) => compareAscii(a.name, b.name))
        .map(Object.freeze)
    );
  }

  async restore(name) {
    assertNonEmptyString(name, 'checkpoint name');
    const json = this._snapshots.get(name);
    if (!json) throw new Error(`checkpoint ${name} does not exist`);
    return loadWorldEnvelope(json, { runtimeRegistry: this._runtimeRegistry });
  }
}

export function createCheckpointStore({ runtimeRegistry } = {}) {
  if (!(runtimeRegistry instanceof RuntimeRegistry)) fail('runtimeRegistry must come from createRuntimeRegistry()');
  return new CheckpointStore(runtimeRegistry);
}
