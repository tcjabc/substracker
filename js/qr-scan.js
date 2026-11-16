// Scanning the recovery-words QR code (shown by Show recovery words on another device).
//   Phones: @capacitor-mlkit/barcode-scanning's scan(), which on Android opens the Google code
//           scanner from Google Play services (no CAMERA permission in this app). iOS later.
//   Web:    getUserMedia and the vendored jsQR decoder (js/jsqr.js), frame by frame in a canvas
//           that is never added to the page. Nothing (frames, images or results) leaves the device,
//           and every camera track is stopped as soon as scanning ends.
// The QR holds the 12 words as plain text, separated by spaces (js/sync-sheet.js qrSvg).

import jsQR from './jsqr.js';
import { isNative, platformName, plugin } from './platform.js';
import { parseRecovery, splitWords, WORD_COUNT } from './words.js';

export const NOT_RECOVERY_CODE = "That QR code isn't a Peek Budget recovery code.";

export const SCAN_MESSAGES = Object.freeze({
  denied: 'Camera access was blocked. Allow the camera for this app or site, or type the words instead.',
  unavailable: 'No camera is available. Type the words instead.',
  noPlayServices: 'Scanning needs Google Play services. Type the words instead.',
  installing: 'Getting the scanner ready. This can take a minute the first time…',
  installFailed: "The scanner couldn't be installed. Try again later, or type the words instead.",
  failed: "The scan didn't work. Try again, or type the words instead.",
});

/** A scan that didn't produce text. `code` is a key of SCAN_MESSAGES, or 'cancelled'. */
export class ScanError extends Error {
  constructor(code) {
    super(SCAN_MESSAGES[code] ?? 'Scanning stopped.');
    this.code = code;
  }
}

/**
 * The recovery words in a scanned QR text, normalised to "word word …" (lowercase, single spaces),
 * or null if the text isn't exactly 12 recovery words with a valid checksum. Never throws.
 */
export async function recoveryFromQr(text) {
  if (typeof text !== 'string' || text.length > 300) return null;
  if (!/^\s*[A-Za-z]+(?:\s+[A-Za-z]+)*\s*$/.test(text)) return null; // letters and whitespace only
  const words = splitWords(text);
  if (words.length !== WORD_COUNT) return null;
  const norm = words.join(' ');
  try { await parseRecovery(norm); } catch { return null; }
  return norm;
}

/** Text from an RGBA image (Uint8ClampedArray, width, height), or null. Pure: used for camera frames and tests. */
export function decodeImage(data, width, height) {
  const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

/** 'native', 'web' or null: how this device can scan, if at all. */
export async function scanSupport() {
  if (isNative()) {
    const p = plugin('BarcodeScanner');
    if (!p) return null;
    try { return (await p.isSupported())?.supported ? 'native' : null; } catch { return null; }
  }
  const md = globalThis.navigator?.mediaDevices;
  return globalThis.isSecureContext && typeof md?.getUserMedia === 'function' ? 'web' : null;
}

/* ---------------- phones ---------------- */

const INSTALL_COMPLETED = 4;
const INSTALL_STOPPED = new Set([3, 5]); // CANCELED, FAILED
const INSTALL_TIMEOUT_MS = 120_000;

async function ensureGoogleScanner(p, onStatus) {
  let available;
  try { ({ available } = await p.isGoogleBarcodeScannerModuleAvailable()); } catch { throw new ScanError('noPlayServices'); }
  if (available) return;
  onStatus?.(SCAN_MESSAGES.installing);
  let listener;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ScanError('installFailed')), INSTALL_TIMEOUT_MS);
      const finish = (fn, v) => { clearTimeout(timer); fn(v); };
      Promise.resolve(p.addListener('googleBarcodeScannerModuleInstallProgress', (e) => {
        if (e?.state === INSTALL_COMPLETED) finish(resolve);
        else if (INSTALL_STOPPED.has(e?.state)) finish(reject, new ScanError('installFailed'));
      })).then((h) => { listener = h; });
      p.installGoogleBarcodeScannerModule().catch((err) => {
        if (/already installed/i.test(err?.message ?? '')) finish(resolve);
        else finish(reject, new ScanError('installFailed'));
      });
    });
  } finally {
    try { await listener?.remove(); } catch { /* ignore */ }
  }
}

/** Scan with the phone's scanner. Resolves the QR text ('' if none); rejects with ScanError. */
export async function scanNative({ onStatus, p = plugin('BarcodeScanner'), platform = platformName() } = {}) {
  if (!p) throw new ScanError('unavailable');
  if (platform === 'android') await ensureGoogleScanner(p, onStatus);
  let res;
  try {
    res = await p.scan({ formats: ['QR_CODE'] });
  } catch (err) {
    const m = String(err?.message ?? '');
    if (/cancel/i.test(m)) throw new ScanError('cancelled');
    if (/denied|permission/i.test(m)) throw new ScanError('denied');
    if (/not available/i.test(m)) throw new ScanError('noPlayServices');
    throw new ScanError('failed');
  }
  const b = res?.barcodes?.[0];
  return String(b?.rawValue ?? b?.displayValue ?? '');
}

/* ---------------- web ---------------- */

const FRAME_MS = 150;
const MAX_FRAME_SIDE = 720;

/**
 * A camera scanner for the web. start() shows the camera in `video` and resolves the first QR text
 * it reads; stop() ends it (start() then rejects with ScanError('cancelled')). Every track is
 * stopped whenever scanning ends, however it ends.
 */
export function createWebScanner({ video, media = globalThis.navigator?.mediaDevices, decode = decodeImage } = {}) {
  let stream = null;
  let timer = null;
  let pending = null; // { resolve, reject }

  function release() {
    clearTimeout(timer);
    timer = null;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    if (video) { try { video.pause(); } catch { /* ignore */ } video.srcObject = null; }
  }

  function settle(fn, v) {
    const p = pending;
    pending = null;
    release();
    p?.[fn](v);
  }

  function frame(canvas, ctx) {
    timer = null;
    if (!pending || !stream) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h) {
      const k = Math.min(1, MAX_FRAME_SIDE / Math.max(w, h));
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const text = decode(img.data, img.width, img.height);
      if (text !== null) { settle('resolve', text); return; }
    }
    timer = setTimeout(() => frame(canvas, ctx), FRAME_MS);
  }

  return {
    get active() { return Boolean(pending); },
    async start() {
      if (pending) throw new Error('Already scanning.');
      if (typeof media?.getUserMedia !== 'function') throw new ScanError('unavailable');
      const result = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      // Stopped (Stop scanning, Back, the sheet closing) while the camera prompt is still up: the
      // caller only gets `result` once the prompt answers, so mark the rejection as expected here
      // rather than have it reported as an unhandled error. The caller still sees it.
      result.catch(() => {});
      try {
        const s = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (!pending) { for (const t of s.getTracks()) t.stop(); return result; } // stopped while asking
        stream = s;
        video.srcObject = s;
        video.setAttribute('playsinline', '');
        video.muted = true;
        await video.play();
        const canvas = document.createElement('canvas'); // never added to the page
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        timer = setTimeout(() => frame(canvas, ctx), FRAME_MS);
      } catch (err) {
        const name = err?.name ?? '';
        const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable';
        settle('reject', new ScanError(code));
      }
      return result;
    },
    stop() { if (pending) settle('reject', new ScanError('cancelled')); else release(); },
  };
}
