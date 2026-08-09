import { createWorld as createKootaWorld, trait } from 'koota';

const COMPONENT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FIELD_TYPES = new Set(['number', 'string', 'boolean', 'enum', 'entity', 'reference']);
const COMPONENT_INSTANCE = Symbol('clay.component-instance');

const componentMetadata = new WeakMap();
const componentsById = new Map();
const entityState = new WeakMap();
const worldState = new WeakMap();
const StableEntityId = trait({ value: 0 });

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
}

function validateFieldValue(path, field, value, world) {
  switch (field.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`);
      if (field.min !== undefined && value < field.min) fail(`${path} must be >= min ${field.min}`);
      if (field.max !== undefined && value > field.max) fail(`${path} must be <= max ${field.max}`);
      break;
    case 'string':
      if (typeof value !== 'string') fail(`${path} must be a string`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
      break;
    case 'enum':
      if (!field.values.includes(value)) fail(`${path} must be one of enum values: ${field.values.join(', ')}`);
      break;
    case 'entity':
      if (value !== null && !entityState.has(value)) fail(`${path} must be an entity or null`);
      if (value !== null && !entityState.get(value).alive) fail(`${path} cannot reference destroyed entity ${value.id}`);
      if (value !== null && world && entityState.get(value).world !== world) {
        fail(`${path} cannot reference an entity from another world`);
      }
      break;
    case 'reference':
      if (value !== null && typeof value !== 'object' && typeof value !== 'function') {
        fail(`${path} must be an object reference or null`);
      }
      break;
  }
}

function normalizeField(componentId, fieldName, input) {
  const path = `${componentId}.${fieldName}`;
  if (!isPlainObject(input)) fail(`${path} schema must be an object`);
  if (!FIELD_TYPES.has(input.type)) fail(`${path}.type must be one of ${[...FIELD_TYPES].join(', ')}`);
  if (!Object.hasOwn(input, 'default')) fail(`${path}.default is required`);

  const allowed = new Set(['type', 'default', 'min', 'max', 'values', 'unit', 'description', 'transient']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not a supported schema property`);
  }

  if (input.description !== undefined) assertString(input.description, `${path}.description`);
  if (input.transient !== undefined && typeof input.transient !== 'boolean') {
    fail(`${path}.transient must be a boolean`);
  }
  if (input.type === 'reference' && input.transient !== true) {
    fail(`${path}.transient must be true for runtime object references`);
  }
  if (input.unit !== undefined) {
    if (input.type !== 'number') fail(`${path}.unit is only valid for number fields`);
    assertString(input.unit, `${path}.unit`);
  }
  if (input.min !== undefined || input.max !== undefined) {
    if (input.type !== 'number') fail(`${path}.min/max are only valid for number fields`);
    if (input.min !== undefined && (typeof input.min !== 'number' || !Number.isFinite(input.min))) {
      fail(`${path}.min must be a finite number`);
    }
    if (input.max !== undefined && (typeof input.max !== 'number' || !Number.isFinite(input.max))) {
      fail(`${path}.max must be a finite number`);
    }
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
      fail(`${path}.min cannot be greater than max`);
    }
  }

  const field = { ...input };
  if (input.type === 'enum') {
    if (!Array.isArray(input.values) || input.values.length === 0) fail(`${path}.values must be a non-empty array`);
    if (input.values.some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
      fail(`${path}.values must contain only string, number, or boolean values`);
    }
    if (new Set(input.values).size !== input.values.length) fail(`${path}.values must not contain duplicates`);
    field.values = Object.freeze([...input.values]);
  } else if (input.values !== undefined) {
    fail(`${path}.values is only valid for enum fields`);
  }

  if ((input.type === 'entity' || input.type === 'reference') && input.default !== null) {
    fail(`${path}.default must be null for ${input.type} fields`);
  }
  validateFieldValue(`${path}.default`, field, input.default);
  return Object.freeze(field);
}

function normalizeSchema(componentId, input) {
  if (!isPlainObject(input)) fail(`${componentId}.schema must be an object`);
  const schema = {};
  for (const [fieldName, field] of Object.entries(input)) {
    if (!FIELD_NAME.test(fieldName)) fail(`${componentId}.${fieldName} is not a valid field name`);
    schema[fieldName] = normalizeField(componentId, fieldName, field);
  }
  return Object.freeze(schema);
}

function normalizeMigrations(componentId, version, input) {
  if (!isPlainObject(input)) fail(`${componentId}.migrations must be an object`);
  const migrations = {};

  for (const key of Object.keys(input)) {
    const fromVersion = Number(key);
    if (!Number.isInteger(fromVersion) || fromVersion < 1 || String(fromVersion) !== key) {
      fail(`${componentId}.migrations key "${key}" must be a positive integer version`);
    }
    if (fromVersion >= version) fail(`${componentId}.migrations cannot start at current or future version ${key}`);
    if (typeof input[key] !== 'function') fail(`${componentId}.migrations.${key} must be a function`);
  }

  for (let fromVersion = 1; fromVersion < version; fromVersion++) {
    if (!Object.hasOwn(input, fromVersion)) {
      fail(`${componentId}.migrations is missing ${fromVersion} -> ${fromVersion + 1}`);
    }
    migrations[fromVersion] = input[fromVersion];
  }
  return Object.freeze(migrations);
}

function assertComponent(component) {
  const metadata = componentMetadata.get(component);
  if (!metadata) fail('expected a component created by defineComponent()');
  return metadata;
}

function normalizeValues(component, input, world) {
  const { id, schema } = assertComponent(component);
  if (!isPlainObject(input)) fail(`${id} values must be an object`);

  for (const fieldName of Object.keys(input)) {
    if (!Object.hasOwn(schema, fieldName)) fail(`${id}.${fieldName} is not declared in the component schema`);
  }

  const values = {};
  for (const [fieldName, field] of Object.entries(schema)) {
    const value = Object.hasOwn(input, fieldName) ? input[fieldName] : field.default;
    validateFieldValue(`${id}.${fieldName}`, field, value, world);
    values[fieldName] = value;
  }
  return values;
}

function componentInput(input, world) {
  if (componentMetadata.has(input)) {
    return { component: input, values: normalizeValues(input, {}, world) };
  }
  if (input?.[COMPONENT_INSTANCE] !== true) fail('expected a component or component initializer');
  return { component: input.component, values: normalizeValues(input.component, input.values, world) };
}

export function defineComponent({ id, version, schema, migrations = {} }) {
  assertString(id, 'component id');
  if (!COMPONENT_ID.test(id)) fail(`component id "${id}" must be a lowercase stable identifier`);
  if (componentsById.has(id)) fail(`component id "${id}" is already registered`);
  if (!Number.isInteger(version) || version < 1) fail(`${id}.version must be a positive integer`);

  const normalizedSchema = normalizeSchema(id, schema);
  const normalizedMigrations = normalizeMigrations(id, version, migrations);
  const defaults = Object.fromEntries(Object.entries(normalizedSchema).map(([name, field]) => [name, field.default]));
  const kootaTrait = Object.keys(normalizedSchema).length === 0 ? trait() : trait(defaults);

  function component(values = {}) {
    if (!isPlainObject(values)) fail(`${id} values must be an object`);
    return Object.freeze({ [COMPONENT_INSTANCE]: true, component, values: { ...values } });
  }

  Object.defineProperties(component, {
    id: { value: id, enumerable: true },
    version: { value: version, enumerable: true },
    schema: { value: normalizedSchema, enumerable: true },
    migrations: { value: normalizedMigrations, enumerable: true },
  });
  componentMetadata.set(component, {
    id,
    version,
    schema: normalizedSchema,
    migrations: normalizedMigrations,
    trait: kootaTrait,
  });
  componentsById.set(id, component);
  return Object.freeze(component);
}

export function getComponent(id) {
  return componentsById.get(id);
}

export function listComponents() {
  return Object.freeze([...componentsById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

export function migrateComponentData(component, fromVersion, data) {
  const metadata = assertComponent(component);
  if (!Number.isInteger(fromVersion) || fromVersion < 1) fail('fromVersion must be a positive integer');
  if (fromVersion > metadata.version) {
    fail(`${metadata.id} data version ${fromVersion} is newer than current version ${metadata.version}`);
  }
  if (!isPlainObject(data)) fail(`${metadata.id} migration input must be an object`);

  let current = { ...data };
  for (let version = fromVersion; version < metadata.version; version++) {
    try {
      current = metadata.migrations[version]({ ...current });
    } catch (error) {
      throw new Error(`${metadata.id} migration ${version} -> ${version + 1} failed: ${error.message}`, {
        cause: error,
      });
    }
    if (!isPlainObject(current)) {
      throw new TypeError(`${metadata.id} migration ${version} -> ${version + 1} must return an object`);
    }
  }

  try {
    return normalizeValues(component, current);
  } catch (error) {
    if (fromVersion === metadata.version) throw error;
    throw new TypeError(
      `${metadata.id} migration ${fromVersion} -> ${metadata.version} produced invalid data: ${error.message}`,
      { cause: error }
    );
  }
}

class Entity {
  constructor(world, raw, id) {
    entityState.set(this, { world, raw, alive: true });
    Object.defineProperty(this, 'id', { value: id, enumerable: true });
  }

  get alive() {
    return entityState.get(this).alive;
  }

  _assertAlive() {
    const state = entityState.get(this);
    if (!state.alive) throw new Error(`entity ${this.id} has been destroyed`);
    state.world._assertAlive();
  }

  has(component) {
    this._assertAlive();
    return entityState.get(this).raw.has(assertComponent(component).trait);
  }

  get(component) {
    this._assertAlive();
    const metadata = assertComponent(component);
    const raw = entityState.get(this).raw;
    if (!raw.has(metadata.trait)) throw new Error(`entity ${this.id} does not have component ${metadata.id}`);
    return raw.get(metadata.trait);
  }

  set(component, patch) {
    this._assertAlive();
    const metadata = assertComponent(component);
    const state = entityState.get(this);
    if (!state.raw.has(metadata.trait)) throw new Error(`entity ${this.id} does not have component ${metadata.id}`);
    if (!isPlainObject(patch)) fail(`${metadata.id} patch must be an object`);
    const values = normalizeValues(component, { ...state.raw.get(metadata.trait), ...patch }, state.world);
    state.raw.set(metadata.trait, values);
    return this;
  }

  add(...inputs) {
    this._assertAlive();
    const state = entityState.get(this);
    const normalized = inputs.map((input) => componentInput(input, state.world));
    const seen = new Set();
    for (const { component } of normalized) {
      const metadata = assertComponent(component);
      if (seen.has(component) || state.raw.has(metadata.trait)) {
        throw new Error(`entity ${this.id} already has component ${metadata.id}`);
      }
      seen.add(component);
    }
    for (const { component, values } of normalized) {
      const metadata = assertComponent(component);
      state.raw.add(Object.keys(metadata.schema).length === 0 ? metadata.trait : metadata.trait(values));
    }
    return this;
  }

  remove(...components) {
    this._assertAlive();
    const raw = entityState.get(this).raw;
    const metadata = components.map(assertComponent);
    for (const item of metadata) {
      if (!raw.has(item.trait)) throw new Error(`entity ${this.id} does not have component ${item.id}`);
    }
    for (const item of metadata) raw.remove(item.trait);
    return this;
  }

  destroy() {
    this._assertAlive();
    const state = entityState.get(this);
    state.raw.destroy();
    state.alive = false;
    const owner = worldState.get(state.world);
    owner.entities.delete(state.raw);
    owner.entityIds.delete(this.id);
  }
}

function spawnEntity(world, explicitId, inputs) {
  world._assertAlive();
  const state = worldState.get(world);
  const normalized = inputs.map((input) => componentInput(input, world));
  const seen = new Set();
  for (const { component } of normalized) {
    const { id } = assertComponent(component);
    if (seen.has(component)) fail(`cannot spawn an entity with duplicate component ${id}`);
    seen.add(component);
  }

  let id;
  if (explicitId === undefined) {
    id = state.nextEntityId++;
  } else {
    if (!Number.isSafeInteger(explicitId) || explicitId < 1) fail('restored entity id must be a positive safe integer');
    if (state.entityIds.has(explicitId)) fail(`restored entity id ${explicitId} already exists`);
    id = explicitId;
    state.nextEntityId = Math.max(state.nextEntityId, id + 1);
  }

  const traits = [StableEntityId({ value: id })];
  for (const { component, values } of normalized) {
    const metadata = assertComponent(component);
    traits.push(Object.keys(metadata.schema).length === 0 ? metadata.trait : metadata.trait(values));
  }
  const raw = state.raw.spawn(...traits);
  const entity = new Entity(world, raw, id);
  state.entities.set(raw, entity);
  state.entityIds.set(id, entity);
  return entity;
}

class QueryResult {
  constructor(entities, components) {
    this._entities = Object.freeze(entities);
    this._components = Object.freeze(components);
  }

  get length() {
    return this._entities.length;
  }

  [Symbol.iterator]() {
    return this._entities[Symbol.iterator]();
  }

  at(index) {
    return this._entities.at(index);
  }

  map(callback) {
    return this._entities.map(callback);
  }

  forEach(callback) {
    this._entities.forEach(callback);
  }

  readEach(callback) {
    this._entities.forEach((entity, index) => {
      callback(this._components.map((component) => entity.get(component)), entity, index);
    });
  }

  updateEach(callback) {
    this._entities.forEach((entity, index) => {
      const values = this._components.map((component) => entity.get(component));
      callback(values, entity, index);
      const state = entityState.get(entity);
      const normalized = this._components.map((component, componentIndex) =>
        normalizeValues(component, values[componentIndex], state.world)
      );
      this._components.forEach((component, componentIndex) => {
        state.raw.set(assertComponent(component).trait, normalized[componentIndex]);
      });
    });
  }

  toArray() {
    return [...this._entities];
  }
}

class World {
  constructor() {
    worldState.set(this, {
      raw: createKootaWorld(),
      entities: new Map(),
      entityIds: new Map(),
      nextEntityId: 1,
      alive: true,
    });
  }

  _assertAlive() {
    if (!worldState.get(this).alive) throw new Error('world has been destroyed');
  }

  spawn(...inputs) {
    return spawnEntity(this, undefined, inputs);
  }

  query(...components) {
    this._assertAlive();
    const state = worldState.get(this);
    const metadata = components.map(assertComponent);
    const rawEntities = state.raw.query(...metadata.map((item) => item.trait));
    const entities = rawEntities.map((raw) => state.entities.get(raw));
    entities.sort((a, b) => a.id - b.id);
    return new QueryResult(entities, components);
  }

  destroy() {
    this._assertAlive();
    const state = worldState.get(this);
    for (const entity of state.entities.values()) entityState.get(entity).alive = false;
    state.entities.clear();
    state.entityIds.clear();
    state.raw.destroy();
    state.alive = false;
  }
}

export function createWorld() {
  return new World();
}

export function restoreEntity(world, id, ...inputs) {
  if (!worldState.has(world)) fail('expected a world created by createWorld()');
  return spawnEntity(world, id, inputs);
}
