// Node tests for tests/legacy-1.19.0/: the frozen copies of the 1.19.0 modules (commit 08bcdc4)
// that stand in for an older household device. Every byte is checked: the two-line header, the
// SHA-256 of the original 1.19.0 file under it, and of the whole file. If one of these fails, the
// fixture was edited, reformatted or converted. Restore it from git; never update the hashes.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = new URL('./legacy-1.19.0/', import.meta.url);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Generated once from `git show 08bcdc4:<source>` and frozen. Never regenerate.
const FROZEN = [
  { file: 'storage.js', source: 'js/storage.js', bytes: 57615, blobSha256: '0874679a28952c0f73202b03f2065120927dff471afbf5bc5cf0efc74d68c7b0', fileSha256: '47d0f5e0458b2157a1329f77c38e6474d40d569e012c18322168a191044192bb' },
  { file: 'sync.js', source: 'js/sync.js', bytes: 23959, blobSha256: 'c0c042764b5d324ca742ecbe5a774bae6d218ebf918a383bffe78e7d388a820b', fileSha256: '9b84c6cc65c54947f7fb64b7b072f2223cf6a64a445ba2c1046c0614aecced56' },
  { file: 'sync-core.js', source: 'js/sync-core.js', bytes: 13378, blobSha256: 'd5074d2410242929a78823cc5083ab42af91863b5820ae26b96e4fbeb3e55d61', fileSha256: '96aee0aeed34241857efc452c8084cecb9f1dc0ca40303d946a1a3a8ccd709c9' },
  { file: 'crypto.js', source: 'js/crypto.js', bytes: 6064, blobSha256: 'e7b2bd8cfeab443cbe2b71cec3cde231bc1724e93d176e7abf23ca4bfa6c8089', fileSha256: 'ac8d257b691e6bd0f5894d934c39c4353a704c586f4427fe4f1b72eb7677cd06' },
  { file: 'util.js', source: 'js/util.js', bytes: 14009, blobSha256: '3665ce7107533552c90fd7cbca821ab21e2f4ba61238b669f6630d5d6949fef4', fileSha256: '2da61dfc0eb5089f69453f8fa4047089da1451e4c9d4022c3960d6a86d9db9c2' },
  { file: 'i18n.js', source: 'js/i18n.js', bytes: 16980, blobSha256: '4a9cfacb58c59bca45ef1bb9bcd41b86b0525922a9810eb020d30d0801a948c1', fileSha256: 'f7e14aee48a1b89a574a7ba06e8275f8d5aa640720dc0f79e982bdf4cebde07c' },
  { file: 'services.js', source: 'js/services.js', bytes: 2885, blobSha256: '92f89c3c7b58abc5c30329eaff4f9ab6b423b32b222bb24f06c6d039bfcf8158', fileSha256: '2b7bed5253205521548719f52302efe820ddcfa8d193a07d8eac8dac38bd346b' },
  { file: 'insights-calc.js', source: 'js/insights-calc.js', bytes: 9548, blobSha256: 'f87d2a497aaacc30e649e31539207c6ae8ae3bdbb0e14dd83c1ecf5b3cf3461c', fileSha256: '1cc59dced0fedf6eb5f784d2629536bfcec23202f8c98e2271872e4818eed213' },
  { file: 'wallet-math.js', source: 'js/wallet-math.js', bytes: 17380, blobSha256: '734b1c70406b025ca0f6be33c9f89f7e0f227bb5eb4c5d1bef5fc3e7cf3a55ff', fileSha256: '771f8d8407605375322270ce4a27f1716a8d2bb45bf12968790ddb07484caf54' },
  { file: 'locales/en.js', source: 'js/locales/en.js', bytes: 42520, blobSha256: '65decb03aa6bc2b5958560599bd31cb5759ceb34851d2ef637f6516dd4e394a7', fileSha256: 'ea02ff0a491b6da547b1d98714ceb5c52daa744d153d09ba66c4d4a9093dd3cb' },
  { file: 'app.js', source: 'js/app.js', bytes: 95153, blobSha256: 'ad932312ea398d94dc4bbcabd8bc649f2abea59a01922d7a9b2af1cf96a170a2', fileSha256: '1b01d909a20b56cfdaba275747b218cd22f03381925df5d42107eb76472ce45f' },
];

const header = (source) => `// FROZEN: ${source} from Peek Budget 1.19.0 (commit 08bcdc4), byte for byte below these two lines.\n`
  + '// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).\n';

for (const f of FROZEN) {
  test(`frozen 1.19.0 ${f.file}: the header, then the 1.19.0 file byte for byte (LF line ends)`, () => {
    const buf = readFileSync(new URL(f.file, DIR));
    const head = Buffer.from(header(f.source), 'utf8');
    assert.ok(buf.subarray(0, head.length).equals(head), 'the two-line header is unchanged');
    const body = buf.subarray(head.length);
    assert.equal(body.length, f.bytes, 'same length as the 1.19.0 file');
    assert.equal(sha(body), f.blobSha256, 'same bytes as the 1.19.0 file');
    assert.equal(sha(buf), f.fileSha256, 'the whole fixture file is unchanged');
    assert.equal(buf.indexOf(0x0d), -1, 'no CR: 1.19.0 stores LF, and nothing converted it');
  });
}

test('the frozen modules load on their own: their imports resolve to each other, never to js/', async () => {
  const legacy = await import('./legacy-1.19.0/storage.js');
  const current = await import('../js/storage.js');
  const legacyUtil = await import('./legacy-1.19.0/util.js');
  const currentUtil = await import('../js/util.js');
  assert.notEqual(legacy.ITEM_FIELDS, current.ITEM_FIELDS, 'separate module instances');
  assert.notEqual(legacyUtil.isOnce, currentUtil.isOnce);
  assert.equal(legacy.SCHEMA_VERSION, 4);
  assert.deepEqual([...legacy.ITEM_FIELDS], [
    'type', 'name', 'domain', 'emoji', 'plan', 'price', 'currency', 'cycle',
    'nextRenewal', 'date', 'category', 'notes', 'createdAt', 'updatedAt',
  ]);
  const engine = await import('./legacy-1.19.0/sync.js');
  assert.equal(typeof engine.createSyncEngine, 'function');
});
