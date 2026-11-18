// Node tests for js/qr-scan.js: reading recovery words from scanned QR text, a round trip from our
// own QR generator to jsQR, the web scanner's camera handling (with fakes), and the phone scanner
// flow (with a fake plugin). Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../js/qrcode.js';
import { qrSvg } from '../js/sync-sheet.js';
import { recoveryFromQr, decodeImage, createWebScanner, scanNative, ScanError, notRecoveryMessage, SCAN_MESSAGES } from '../js/qr-scan.js';
import { keyToWords } from '../js/words.js';
import { generateKey } from '../js/crypto.js';

const ZOO = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

/** RGBA pixels for a module grid (true = dark), `scale` px per module, with a 4-module white quiet zone. */
function rasterize(n, isDark, scale = 4, quiet = 4) {
  const side = (n + 2 * quiet) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!isDark(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + quiet) * scale + y) * side + (c + quiet) * scale + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { data, width: side, height: side };
}

test('QR text: 12 valid words are accepted and normalised', async () => {
  assert.equal(await recoveryFromQr(ZOO), ZOO);
  assert.equal(await recoveryFromQr(`  ${ZOO.toUpperCase().replace(/ /g, '\n\t ')}  \r\n`), ZOO, 'extra whitespace, any case');
  const words = (await keyToWords(generateKey())).join(' ');
  assert.equal(await recoveryFromQr(words), words);
});

test('QR text: garbage, wrong counts and bad checksums are refused', async () => {
  const bad = [
    '', '   ', 'hello', 'https://example.com/zoo-zoo', 'WIFI:S:home;T:WPA;P:secret;;',
    ZOO.split(' ').slice(0, 11).join(' '), `${ZOO} zoo`, // 11 and 13 words
    'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo', // all list words, checksum wrong
    'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrongg', // not a list word
    '1. zoo 2. zoo 3. zoo 4. zoo 5. zoo 6. zoo 7. zoo 8. zoo 9. zoo 10. zoo 11. zoo 12. wrong', // not our format
    'AAAAAAAAAAAAAAAAAAAAAA', // an old-style key isn't what our QR holds
    `${'abandon '.repeat(60)}`, null, undefined, 42,
  ];
  for (const t of bad) assert.equal(await recoveryFromQr(t), null, JSON.stringify(t));
  assert.equal(notRecoveryMessage(), "That QR code isn't a Peek Budget recovery code.");
});

test('round trip: our generator → pixels → jsQR gives back the same words', async () => {
  for (let i = 0; i < 5; i++) {
    const words = (await keyToWords(generateKey())).join(' ');
    const qr = qrcode(0, 'M');
    qr.addData(words);
    qr.make();
    const img = rasterize(qr.getModuleCount(), (r, c) => qr.isDark(r, c));
    const text = decodeImage(img.data, img.width, img.height);
    assert.equal(text, words);
    assert.equal(await recoveryFromQr(text), words);
  }
});

test('round trip from the SVG the Sync sheet shows (qrSvg)', async () => {
  const words = (await keyToWords(generateKey())).join(' ');
  const svg = qrSvg(words);
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
  const dark = new Set([...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${m[1]},${m[2]}`));
  assert.ok(dark.size > 100);
  const img = rasterize(size, (r, c) => dark.has(`${c},${r}`), 4, 0); // the SVG already has its quiet zone
  assert.equal(decodeImage(img.data, img.width, img.height), words);
});

test('no QR in the picture: decodeImage returns null', () => {
  const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  assert.equal(decodeImage(blank, 200, 200), null);
});

/* ---------------- web scanner with a fake camera ---------------- */

function fakeCamera({ fail } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }, { stopped: false, stop() { this.stopped = true; } }];
  const media = {
    asked: 0,
    async getUserMedia(c) {
      media.asked++;
      media.constraints = c;
      if (fail) { const e = new Error('nope'); e.name = fail; throw e; }
      return { getTracks: () => tracks };
    },
  };
  const video = { videoWidth: 640, videoHeight: 480, srcObject: null, muted: false, setAttribute() {}, async play() {}, pause() {} };
  return { media, video, tracks };
}

function withCanvas(fn) {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) }) }),
  };
  return fn().finally(() => { globalThis.document = prev; });
}

test('web scanner: a read QR resolves its text and stops every camera track; only video is asked for', () => withCanvas(async () => {
  const cam = fakeCamera();
  let frames = 0;
  const scanner = createWebScanner({ video: cam.video, media: cam.media, decode: () => (++frames >= 3 ? ZOO : null) });
  const text = await scanner.start();
  assert.equal(text, ZOO);
  assert.ok(cam.tracks.every((t) => t.stopped), 'tracks stopped');
  assert.equal(cam.video.srcObject, null);
  assert.equal(cam.media.constraints.audio, false);
  assert.equal(scanner.active, false);
}));

test('web scanner: stop() (sheet closed, Back, Stop scanning) stops the tracks and rejects with cancelled', () => withCanvas(async () => {
  const cam = fakeCamera();
  const scanner = createWebScanner({ video: cam.video, media: cam.media, decode: () => null });
  const p = scanner.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(scanner.active, true);
  scanner.stop();
  await assert.rejects(p, (e) => e instanceof ScanError && e.code === 'cancelled');
  assert.ok(cam.tracks.every((t) => t.stopped));
  scanner.stop(); // harmless twice
}));

test('web scanner: camera denied or missing gives a clear message, typing still possible', async () => {
  for (const [name, code] of [['NotAllowedError', 'denied'], ['SecurityError', 'denied'], ['NotFoundError', 'unavailable'], ['NotReadableError', 'unavailable']]) {
    const cam = fakeCamera({ fail: name });
    const scanner = createWebScanner({ video: cam.video, media: cam.media });
    await assert.rejects(scanner.start(), (e) => e instanceof ScanError && e.code === code && e.message === SCAN_MESSAGES[code], name);
  }
  await assert.rejects(createWebScanner({ video: {}, media: {} }).start(), (e) => e.code === 'unavailable');
  assert.match(SCAN_MESSAGES.denied, /type the words instead/);
});

/* ---------------- phone scanner with a fake plugin ---------------- */

function fakeScanner({ available = true, scan = async () => ({ barcodes: [{ rawValue: ZOO }] }), installEvents = [4], availableThrows = false } = {}) {
  const calls = [];
  let listener = null;
  return {
    calls,
    async isGoogleBarcodeScannerModuleAvailable() { calls.push('available?'); if (availableThrows) throw new Error('no Play services'); return { available }; },
    async addListener(name, fn) { calls.push(`listen:${name}`); listener = fn; return { remove: async () => { calls.push('unlisten'); } }; },
    async installGoogleBarcodeScannerModule() {
      calls.push('install');
      setTimeout(() => { for (const state of installEvents) listener?.({ state }); }, 5);
    },
    async scan(opts) { calls.push(['scan', opts]); return scan(); },
  };
}

test('phone: module already there → scan QR codes only and return the text', async () => {
  const p = fakeScanner();
  assert.equal(await scanNative({ p, platform: 'android' }), ZOO);
  assert.deepEqual(p.calls, ['available?', ['scan', { formats: ['QR_CODE'] }]]);
});

test('phone: module not installed → install it (with a status line), then scan', async () => {
  const p = fakeScanner({ available: false, installEvents: [1, 2, 6, 4] });
  const status = [];
  assert.equal(await scanNative({ p, platform: 'android', onStatus: (m) => status.push(m) }), ZOO);
  assert.deepEqual(status, [SCAN_MESSAGES.installing]);
  assert.ok(p.calls.includes('install') && p.calls.includes('unlisten'));
});

test('phone: install failure, no Play services, cancel and permission problems map to clear messages', async () => {
  await assert.rejects(scanNative({ p: fakeScanner({ available: false, installEvents: [5] }), platform: 'android' }), (e) => e.code === 'installFailed');
  await assert.rejects(scanNative({ p: fakeScanner({ availableThrows: true }), platform: 'android' }), (e) => e.code === 'noPlayServices');
  await assert.rejects(scanNative({ p: fakeScanner({ scan: async () => { throw new Error('scan canceled.'); } }), platform: 'android' }), (e) => e.code === 'cancelled');
  await assert.rejects(scanNative({ p: fakeScanner({ scan: async () => { throw new Error('User denied access to camera.'); } }), platform: 'ios' }), (e) => e.code === 'denied');
  await assert.rejects(scanNative({ p: null }), (e) => e.code === 'unavailable');
  // iOS has no Google module step.
  const ios = fakeScanner({ available: false });
  assert.equal(await scanNative({ p: ios, platform: 'ios' }), ZOO);
  assert.equal(ios.calls.includes('available?'), false);
});
