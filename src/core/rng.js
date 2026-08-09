export function createDeterministicRng(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('seed must be an unsigned 32-bit integer');
  }
  let state = seed >>> 0;
  function uint32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
  return Object.freeze({
    uint32,
    next: () => uint32() / 0x100000000,
  });
}
