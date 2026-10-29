// Injectable clock so queues can be tested without real time passing.
export function createClock({ nowMs = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof nowMs !== 'function') throw new TypeError('nowMs must be a function');
  return {
    now: nowMs,
    delay: ms => new Promise(resolve => { setTimer(() => resolve(), Math.max(0, ms)); }),
    setTimeout,
    clearTimeout: clearTimer,
  };
}
