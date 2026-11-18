// Getting a file out of the app. In the native app the file is written to the app's cache
// folder and handed to the system share sheet (Capacitor Filesystem + Share); on the web it's
// a normal browser download.

import { plugin } from './platform.js';
import { t } from './i18n.js';

/**
 * Hand `blob` (text, e.g. a JSON backup or a CSV file) to the person as a file called `filename`.
 * `dialogTitle` is the native share sheet's title. Resolves to true when it was delivered, false
 * when the person closed the share sheet.
 */
export async function deliverFile(blob, filename, { dialogTitle = t('settings.export.dialogTitle') } = {}) {
  const fs = plugin('Filesystem');
  const share = plugin('Share');
  if (fs && share) return shareNative(fs, share, blob, filename, dialogTitle);
  downloadInBrowser(blob, filename);
  return true;
}

const BOM = String.fromCharCode(0xfeff);

/** The blob's text exactly, byte-order mark included (Blob.text() drops a leading one). */
async function exactText(blob) {
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const bom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  return (bom ? BOM : '') + await blob.text();
}

async function shareNative(fs, share, blob, filename, dialogTitle) {
  const { uri } = await fs.writeFile({
    path: filename,
    data: await exactText(blob),
    directory: 'CACHE',
    encoding: 'utf8',
  });
  try {
    await share.share({ title: filename, files: [uri], dialogTitle });
    return true;
  } catch (err) {
    // Closing the share sheet rejects with "Share canceled"; that isn't an error.
    if (/cancel/i.test(String(err?.message ?? err))) return false;
    throw err;
  }
}

function downloadInBrowser(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
