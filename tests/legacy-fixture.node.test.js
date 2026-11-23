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

/* ------------------------------------------------------------------ tests/legacy-1.25.1/ (commit 2135adf) */

const DIR125 = new URL('./legacy-1.25.1/', import.meta.url);

// Generated once from `git show 2135adf:<source>` and frozen. Never regenerate.
const FROZEN125 = [
  { file: 'storage.js', source: 'js/storage.js', bytes: 77140, blobSha256: '6e7fec093e3bde754a45b6b47324ffb1514410e50de7d9903c7681ef4a74feb3', fileSha256: 'a1ea616c21d4c50212e9b6cbac841663c71b68b4024c7a4c7baa86423697e43d' },
  { file: 'sync.js', source: 'js/sync.js', bytes: 23959, blobSha256: 'c0c042764b5d324ca742ecbe5a774bae6d218ebf918a383bffe78e7d388a820b', fileSha256: '53cb39ea488c388b545905e31dc6f88a6b154277a89952decf8382810f01ccdc' },
  { file: 'sync-core.js', source: 'js/sync-core.js', bytes: 13378, blobSha256: 'd5074d2410242929a78823cc5083ab42af91863b5820ae26b96e4fbeb3e55d61', fileSha256: 'b640970811421bc9078c49de4384f2baf737c9035f1d9c08faacb49143f404f0' },
  { file: 'crypto.js', source: 'js/crypto.js', bytes: 6064, blobSha256: 'e7b2bd8cfeab443cbe2b71cec3cde231bc1724e93d176e7abf23ca4bfa6c8089', fileSha256: '2f94f3818dc1c23c1dc3daef8a1f4112da796609fae575635c816f756011e1cd' },
  { file: 'util.js', source: 'js/util.js', bytes: 14503, blobSha256: '98141f535b376b1fa95cd73d93e781ec65108fea4595c7660502f6a37c3317f3', fileSha256: '260228f1746a89c5b377ed5efc7cda8ea6153d6bb7dd8eb11eed3f6f11ec4dca' },
  { file: 'i18n.js', source: 'js/i18n.js', bytes: 16979, blobSha256: 'bb94e0037b0ad9fdb9203e1ff82b9bfc6aec4752025c41a9369ccd8beeb5f798', fileSha256: '976a3e2ee01f142331c20ab736ba7de639c9b8ca4485ea347cb8ce32a241da63' },
  { file: 'services.js', source: 'js/services.js', bytes: 6721, blobSha256: '4e67c7b6744d28ae714a6d047b6ba814659cf5e4a44cd8e6c573bcbc00c009fb', fileSha256: '2c03a523ae94c02ed27dccf0349442b795b25c8b443ca286927dc229b9a14448' },
  { file: 'interval.js', source: 'js/interval.js', bytes: 12337, blobSha256: '0d38eb42ef0b5506e3311781066d0400462973f54503e6f2bf144dd0eae7c1bf', fileSha256: 'f922f1c6507b990e0e75aa4a0a8dbe9761097e87d8d5cbe760b9d03b3f5ea40d' },
  { file: 'format-migration.js', source: 'js/format-migration.js', bytes: 9852, blobSha256: '434e115ce055ef4cd554c297cad689a99f120f3e81671b3edda0e0e3d50b354a', fileSha256: '205f9a0c7059230d6302bb1b15b0e824bade1d995d04dc82a6d965a2a413eb2c' },
  { file: 'legacy-step.js', source: 'js/legacy-step.js', bytes: 3723, blobSha256: '78ff6ac4e91b72072190e9079255856d1329ac4ea4422f842322f576fd905dda', fileSha256: 'a09d08120ae9db731eb044639d3504ea44039e031a6d526322f25cc4c990c2f9' },
  { file: 'calendar-math.js', source: 'js/calendar-math.js', bytes: 9950, blobSha256: 'fb4b9cf178d8f910dd647932819f612d9d1d64d3c275797c2fbf0454877212bc', fileSha256: '4611bed18dbbfce0472ec22dbf276cd4f1e5cbe99363ca67f29097b3505d2374' },
  { file: 'insights-calc.js', source: 'js/insights-calc.js', bytes: 10226, blobSha256: '0d9464c94b5b793ae93669fc01c6bc3063a1efe60b791dd78b9524ae59f53cec', fileSha256: '1b114690499119d99c2627c612c47d0aca1aa594312899f4da5e4c00f9bd5ef9' },
  { file: 'group-slots.js', source: 'js/group-slots.js', bytes: 8779, blobSha256: '1cc2fcd38b06063bc6896e2b022bd82780c4844b19e741927c22fce88ad2d919', fileSha256: '24fbb0d801eb44f3a80e633793c4f9ca61d9efd4c64d374942e2f50b429de277' },
  { file: 'wallet-math.js', source: 'js/wallet-math.js', bytes: 21711, blobSha256: 'baf460c26381de8c595857ae2722c9f5c3e9f46063f53f79f6375f21dccbf66b', fileSha256: '506355c03327d2d5f3ff4b3382476a470092bb14ca145e8056aa82f4c4461fc5' },
  { file: 'category-select.js', source: 'js/category-select.js', bytes: 4804, blobSha256: '3b8721f4723bac82d586327c7f9362cd2a8b6a73af14a28a77e3fce30f5a86eb', fileSha256: 'c3336c4a59fc2f37f29d3a8536ef448a2874e3ade5c5c8e0160b81e8609a6dfe' },
  { file: 'locales/en.js', source: 'js/locales/en.js', bytes: 44485, blobSha256: 'ed8f0be0d97c7160d20d1e17eeb75d32be7f494bfd1b67c5d3a2b2fb751042c8', fileSha256: '8832f0d41dece1677ad37a72918389fc823d3e96778ccd8d374a5ebfbec733c9' },
  { file: 'app.js', source: 'js/app.js', bytes: 120243, blobSha256: '95c9a45c880f0f6ae845c7a1cd471eda35cf925bce56ec3876ef979e2408a0fa', fileSha256: 'f5d1d5094aef7532d18515fe0d1e55abe556064474f95bdf1c0f29010b87e026' },
];

const header125 = (source) => `// FROZEN: ${source} from Peek Budget 1.25.1 (commit 2135adf), byte for byte below these two lines.\n`
  + '// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).\n';

for (const f of FROZEN125) {
  test(`frozen 1.25.1 ${f.file}: the header, then the 1.25.1 file byte for byte (LF line ends)`, () => {
    const buf = readFileSync(new URL(f.file, DIR125));
    const head = Buffer.from(header125(f.source), 'utf8');
    assert.ok(buf.subarray(0, head.length).equals(head), 'the two-line header is unchanged');
    const body = buf.subarray(head.length);
    assert.equal(body.length, f.bytes, 'same length as the 1.25.1 file');
    assert.equal(sha(body), f.blobSha256, 'same bytes as the 1.25.1 file');
    assert.equal(sha(buf), f.fileSha256, 'the whole fixture file is unchanged');
    assert.equal(buf.indexOf(0x0d), -1, 'no CR: 1.25.1 stores LF, and nothing converted it');
  });
}

test('the frozen 1.25.1 modules load on their own and are 1.25.1: no pay, backup format 5', async () => {
  const old = await import('./legacy-1.25.1/storage.js');
  const current = await import('../js/storage.js');
  assert.notEqual(old.ITEM_FIELDS, current.ITEM_FIELDS, 'separate module instances');
  assert.ok(!old.ITEM_FIELDS.includes('pay'));
  assert.equal(old.BACKUP_VERSION, 5);
  const engine = await import('./legacy-1.25.1/sync.js');
  assert.equal(typeof engine.createSyncEngine, 'function');
  const app = readFileSync(new URL('app.js', DIR125), 'utf8');
  assert.ok(app.includes("const APP_VERSION = '1.25.1';"));
});

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
