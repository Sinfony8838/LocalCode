// A controllable clock for tests: nothing moves unless tickTo is called.
export function createTestClock(startUtcMs = 0) {
  let now = startUtcMs;
  return {
    now: () => now,
    tickTo(targetUtcMs) {
      if (targetUtcMs < now) throw new RangeError('the test clock cannot move backwards');
      now = targetUtcMs;
      return now;
    },
  };
}
