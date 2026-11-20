// Format 5's first-launch step (tests/format-migration.node.test.js) again in a time zone with DST,
// America/New_York, as the other date tests run. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/New_York';

test('this run is in America/New_York (DST on in July, off in January)', () => {
  assert.equal(new Date(2026, 6, 1, 12).getTimezoneOffset(), 240);
  assert.equal(new Date(2026, 0, 1, 12).getTimezoneOffset(), 300);
});

await import('./format-migration.node.test.js');
