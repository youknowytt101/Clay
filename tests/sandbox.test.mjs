/**
 * M1-j deterministic condition/action sandbox acceptance.
 *
 * @package M1-j
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeterministicScriptRegistry } from '../src/core/sandbox.js';

function action(source, overrides = {}) {
  return {
    id: 'test.sample-action',
    kind: 'action',
    source,
    ...overrides,
  };
}

// @covers I7 决策29 M1-j:J1 M1-j:J3
test('forbidden ambient capabilities fail during registration', () => {
  const forbidden = [
    ['Date', 'return Date.now();'],
    ['Math.random', 'return Math.random();'],
    ['dynamic random', 'return Math["random"]();'],
    ['performance', 'return performance.now();'],
    ['network', 'return fetch(input.url);'],
    ['storage', 'return localStorage.getItem("key");'],
    ['DOM', 'return document.body.dataset.value;'],
    ['host output', 'console.log(input.value); return null;'],
    ['host escape', 'return input.constructor.constructor("return this")();'],
  ];

  for (const [label, source] of forbidden) {
    const registry = createDeterministicScriptRegistry();
    assert.throws(
      () => registry.register(action(source, { id: `test.${label.toLowerCase().replaceAll(' ', '-')}` })),
      /forbidden capability/,
      `${label} must fail before execution`
    );
    assert.deepEqual(registry.list(), [], 'a rejected script must not remain registered');
  }
});

// @covers M1-j:J3
test('static scan ignores forbidden words in comments and string literals', () => {
  const registry = createDeterministicScriptRegistry().register(action(`
    // Date and Math.random are documentation here.
    return { label: "fetch localStorage document", value: Math.max(input.a, input.b) };
  `));

  assert.deepEqual(registry.execute('test.sample-action', {
    input: { a: 2, b: 5 }, state: {}, seed: 1, tick: 0, dt: 0.02,
  }), { label: 'fetch localStorage document', value: 5 });
});

// @covers I7 I11 决策29 M1-j:J2 meta:oracle-sensitivity
test('seeded rng, tick and dt are injected deterministically and differences are detectable', () => {
  const registry = createDeterministicScriptRegistry().register(action(`
    return { roll: rng.uint32(), tick, dt, input, state };
  `));
  const context = {
    input: { command: 'move', entityIds: [3, 1] },
    state: { phase: 'playing' },
    seed: 42,
    tick: 17,
    dt: 0.02,
  };

  const first = registry.execute('test.sample-action', context);
  const replay = registry.execute('test.sample-action', context);
  const changedSeed = registry.execute('test.sample-action', { ...context, seed: 43 });
  const changedTick = registry.execute('test.sample-action', { ...context, tick: 18 });

  assert.equal(JSON.stringify(first), JSON.stringify(replay));
  assert.notEqual(first.roll, changedSeed.roll, 'negative case must expose a seed difference');
  assert.notEqual(first.tick, changedTick.tick, 'negative case must expose a tick difference');
  assert.equal(first.dt, 0.02);
});

// @covers I7 M1-j:J1 M1-j:J2
test('scripts receive isolated immutable JSON and return canonical JSON', () => {
  const registry = createDeterministicScriptRegistry().register(action(`
    let mutationBlocked = false;
    try { input.nested.value = 99; } catch { mutationBlocked = true; }
    return { z: state.value, mutationBlocked, a: input.nested.value };
  `));
  const input = { nested: { value: 3 } };
  const result = registry.execute('test.sample-action', {
    input,
    state: { value: 7 },
    seed: 0,
    tick: 0,
    dt: 0.02,
  });

  assert.deepEqual(result, { a: 3, mutationBlocked: true, z: 7 });
  assert.equal(input.nested.value, 3);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(
    () => createDeterministicScriptRegistry()
      .register(action('return undefined;'))
      .execute('test.sample-action', { input: {}, state: {}, seed: 0, tick: 0, dt: 0.02 }),
    /only JSON values/
  );
});

// @covers M1-j:J1 M1-j:J2
test('conditions return booleans and registry metadata does not expose executable functions', () => {
  const registry = createDeterministicScriptRegistry().register({
    id: 'test.is-ready',
    kind: 'condition',
    source: 'return input.ready && tick >= state.startTick;',
  });

  assert.equal(registry.execute('test.is-ready', {
    input: { ready: true }, state: { startTick: 2 }, seed: 9, tick: 2, dt: 0.02,
  }), true);
  assert.deepEqual(registry.list(), [{ id: 'test.is-ready', kind: 'condition' }]);
  assert.throws(
    () => createDeterministicScriptRegistry()
      .register({ id: 'test.bad-condition', kind: 'condition', source: 'return 1;' })
      .execute('test.bad-condition', { input: {}, state: {}, seed: 0, tick: 0, dt: 0.02 }),
    /must return a boolean/
  );
});

// @covers I7 M1-j:J1 M1-j:J3
test('dynamic code, module loading and template literals are rejected statically', () => {
  const sources = [
    'return eval(input.source);',
    'return Function(input.source)();',
    'return import(input.module);',
    'return require(input.module);',
    'return `${input.value}`;',
  ];
  for (const [index, source] of sources.entries()) {
    assert.throws(
      () => createDeterministicScriptRegistry().register(action(source, { id: `test.escape-${index}` })),
      /forbidden capability|template literals/
    );
  }
});
