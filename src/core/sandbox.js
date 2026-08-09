import { createDeterministicRng } from './rng.js';

const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SCRIPT_KINDS = new Set(['condition', 'action']);
const FORBIDDEN_IDENTIFIERS = new Set([
  'Date', 'performance', 'crypto',
  'fetch', 'Request', 'Response', 'WebSocket', 'WebTransport', 'XMLHttpRequest', 'EventSource',
  'navigator', 'sendBeacon',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'Storage',
  'document', 'window', 'self', 'globalThis', 'HTMLElement', 'Node', 'Event', 'CustomEvent',
  'DOMParser', 'MutationObserver', 'Image', 'Audio', 'console',
  'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'MessageChannel', 'postMessage',
  'process', 'require', 'module', 'exports', 'Deno', 'Bun',
  'eval', 'Function', 'AsyncFunction', 'import',
  'constructor', 'prototype', '__proto__', 'caller', 'callee', 'arguments', 'this',
]);
const DANGEROUS_PROPERTY = /^(?:constructor|prototype|__proto__|caller|callee)$/;
const registryState = new WeakMap();

const SAFE_MATH = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter((name) => name !== 'random')
    .map((name) => [name, Math[name]])
));

function fail(message) {
  throw new TypeError(message);
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value, path) {
  return deepFreeze(canonicalize(value, path));
}

function isIdentifierStart(character) {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character);
}

function scanSource(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) fail('script source contains an unterminated comment');
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
        } else {
          value += source[index++];
        }
      }
      if (index >= source.length) fail('script source contains an unterminated string');
      if (DANGEROUS_PROPERTY.test(value)) fail(`script uses forbidden capability ${value}`);
      index++;
      continue;
    }
    if (character === '`') fail('script source must not use template literals');
    if (isIdentifierStart(character)) {
      const start = index++;
      while (index < source.length && isIdentifierPart(source[index])) index++;
      tokens.push(source.slice(start, index));
      continue;
    }
    if (!/\s/.test(character)) tokens.push(character);
    index++;
  }

  for (const token of tokens) {
    if (FORBIDDEN_IDENTIFIERS.has(token)) fail(`script uses forbidden capability ${token}`);
  }
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index] === 'Math' && tokens[index + 1] === '.' && tokens[index + 2] === 'random') {
      fail('script uses forbidden capability Math.random');
    }
  }
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] === 'Math' && tokens[index + 1] === '[') {
      fail('script uses forbidden capability dynamic Math access');
    }
  }
}

function compile(source) {
  scanSource(source);
  try {
    return Function('input', 'state', 'rng', 'tick', 'dt', 'Math', `"use strict";\n${source}`);
  } catch (error) {
    fail(`script source is invalid: ${error.message}`);
  }
}

function normalizeDefinition(input) {
  if (!isPlainObject(input)) fail('script definition must be an object');
  if (typeof input.id !== 'string' || !STABLE_ID.test(input.id)) {
    fail('script id must be a stable lowercase identifier');
  }
  if (!SCRIPT_KINDS.has(input.kind)) fail('script kind must be condition or action');
  if (typeof input.source !== 'string' || input.source.trim().length === 0) {
    fail('script source must be a non-empty string');
  }
  return {
    metadata: Object.freeze({ id: input.id, kind: input.kind }),
    execute: compile(input.source),
  };
}

function normalizeContext(input) {
  if (!isPlainObject(input)) fail('script context must be an object');
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) fail('tick must be a non-negative safe integer');
  if (typeof input.dt !== 'number' || !Number.isFinite(input.dt) || input.dt < 0) {
    fail('dt must be a non-negative finite number');
  }
  return Object.freeze({
    input: immutableJson(input.input ?? {}, 'input'),
    state: immutableJson(input.state ?? {}, 'state'),
    rng: createDeterministicRng(input.seed),
    tick: input.tick,
    dt: input.dt,
  });
}

class DeterministicScriptRegistry {
  constructor() {
    registryState.set(this, new Map());
  }

  register(input) {
    const definition = normalizeDefinition(input);
    const scripts = registryState.get(this);
    if (scripts.has(definition.metadata.id)) {
      throw new Error(`script ${definition.metadata.id} is already registered`);
    }
    scripts.set(definition.metadata.id, definition);
    return this;
  }

  list() {
    return Object.freeze([...registryState.get(this).values()]
      .map((definition) => definition.metadata)
      .sort((a, b) => compareAscii(a.id, b.id)));
  }

  execute(id, context) {
    const definition = registryState.get(this).get(id);
    if (!definition) throw new Error(`script ${id} is not registered`);
    const normalized = normalizeContext(context);
    const result = definition.execute(
      normalized.input,
      normalized.state,
      normalized.rng,
      normalized.tick,
      normalized.dt,
      SAFE_MATH
    );
    if (definition.metadata.kind === 'condition') {
      if (typeof result !== 'boolean') fail(`condition ${id} must return a boolean`);
      return result;
    }
    return immutableJson(result, `action ${id} result`);
  }
}

export function createDeterministicScriptRegistry() {
  return new DeterministicScriptRegistry();
}
