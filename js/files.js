// Getting a file out of the app. A plain browser download for now; this is the one place to
// swap in the native share sheet later (e.g. Capacitor Filesystem.writeFile + Share.share).

/** Hand `blob` to the person as a file called `filename`. */
export async function deliverFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
