// The mixed-version sync scenarios (tests/mixed-version.scenarios.js, mixed-format5, mixed-groups and mixed-cards) again in a time zone with
// DST, America/New_York, as the other date tests run. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/New_York';

test('this run is in America/New_York (DST on in July, off in January)', () => {
  assert.equal(new Date(2026, 6, 1, 12).getTimezoneOffset(), 240);
  assert.equal(new Date(2026, 0, 1, 12).getTimezoneOffset(), 300);
});

await import('./mixed-version.scenarios.js');
await import('./mixed-format5.scenarios.js');
await import('./mixed-groups.scenarios.js');
await import('./mixed-cards.scenarios.js');
await import('./mixed-cards-ui.scenarios.js');
