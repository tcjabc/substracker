// Getting a file out of the app. In the native app the file is written to the app's cache
// folder and handed to the system share sheet (Capacitor Filesystem + Share); on the web it's
// a normal browser download.

import { plugin } from './platform.js';

/**
 * Hand `blob` (text, e.g. a JSON backup) to the person as a file called `filename`.
 * Resolves to true when it was delivered, false when the person closed the share sheet.
 */
export async function deliverFile(blob, filename) {
  const fs = plugin('Filesystem');
  const share = plugin('Share');
  if (fs && share) return shareNative(fs, share, blob, filename);
  downloadInBrowser(blob, filename);
  return true;
}

async function shareNative(fs, share, blob, filename) {
  const { uri } = await fs.writeFile({
    path: filename,
    data: await blob.text(),
    directory: 'CACHE',
    encoding: 'utf8',
  });
  try {
    await share.share({ title: filename, files: [uri], dialogTitle: 'Save or send the backup' });
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
