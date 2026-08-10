/**
 * Writes an export file set via chrome.downloads. Service workers have no
 * URL.createObjectURL, so every file is delivered as a `data:` URL — text
 * is percent-encoded here, binaries (screenshots) already arrive as
 * base64 `data:` URLs produced by lib/shots.js.
 */

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** downloadId -> { resolve, reject } for in-flight chrome.downloads.download calls. */
const pending = new Map();
/**
 * downloadId -> Error|null for terminal states seen BEFORE the waiter existed.
 * chrome.downloads.download() resolves asynchronously, so a small/data: URL
 * can finish before we know its id — without this the wait would hang until
 * DOWNLOAD_TIMEOUT_MS.
 */
const settledEarly = new Map();

function settle(id, error) {
  const waiter = pending.get(id);
  if (!waiter) {
    settledEarly.set(id, error);
    return;
  }
  pending.delete(id);
  if (error) waiter.reject(error);
  else waiter.resolve();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') {
    settle(delta.id, null);
  } else if (delta.state?.current === 'interrupted' || delta.error) {
    settle(delta.id, new Error(`download interrupted: ${delta.error?.current || 'unknown'}`));
  }
});

function textDataUrl(text) {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
}

function waitForDownload(id, filename) {
  if (settledEarly.has(id)) {
    const error = settledEarly.get(id);
    settledEarly.delete(id);
    return error ? Promise.reject(error) : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`download timed out: ${filename}`));
    }, DOWNLOAD_TIMEOUT_MS);
    pending.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

async function downloadAndWait(url, filename) {
  // 'overwrite', NOT 'uniquify'. The folder name is derived from the session
  // (PROTOCOL §4) so re-exporting the same session targets the same paths, and
  // Chrome applies uniquify PER FILE: report.md would become "report (1).md"
  // while a brand-new shots/02-*.jpg kept its name, leaving the report's
  // `![element](shots/01-element.jpg)` links pointing at files that no longer
  // exist and the un-suffixed report.md holding stale first-export content.
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  await waitForDownload(id, filename);
  return id;
}

/** Derives the absolute export folder path from the first completed download's known relative path. */
async function resolveFolderRoot(downloadId, relPath) {
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) throw new Error('download not found after completion');
  const suffix = `/${relPath}`;
  return item.filename.endsWith(suffix)
    ? item.filename.slice(0, -suffix.length)
    : item.filename.replace(/[/\\][^/\\]+$/, '');
}

/**
 * Accepts either lib/export.js's `[{ path, content }]` array or a plain
 * `{ path: content }` record, so the two producers cannot drift apart.
 */
function textEntries(files) {
  if (Array.isArray(files)) {
    return files.map((f) => ({ path: f.path, url: textDataUrl(f.content) }));
  }
  return Object.entries(files || {}).map(([path, text]) => ({ path, url: textDataUrl(text) }));
}

/**
 * @param {{ folder: string, files: {path:string,content:string}[]|Record<string,string>,
 *   blobs?: Record<string,string> }} args files are raw text; blobs are
 *   already-encoded `data:` URLs (e.g. JPEG screenshots), keyed by the same
 *   export-relative path stored on AnnotationOut.shots.
 * @returns {Promise<{ folder: string, files: string[] }>}
 */
export async function writeExportFolder({ folder, files, blobs = {} }) {
  const entries = [
    ...textEntries(files),
    ...Object.entries(blobs).map(([path, dataUrl]) => ({ path, url: dataUrl })),
  ];
  if (entries.length === 0) throw new Error('no export files to write');

  let firstId = null;
  for (const entry of entries) {
    const id = await downloadAndWait(entry.url, `${folder}/${entry.path}`);
    if (firstId === null) firstId = { id, path: entry.path };
  }

  const resolvedFolder = await resolveFolderRoot(firstId.id, firstId.path);
  return { folder: resolvedFolder, files: entries.map((e) => e.path) };
}
