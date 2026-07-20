import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';

interface FileEntry {
  /** Human-readable path used inside the archive. */
  zipPath: string;
  absPath: string;
}

/** Decodes the `encodeURIComponent` segments used for on-disk names back to readable text. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function walk(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  // Layout on disk is exactly two levels deep: <namespace>/<resource>/<id>.json.
  let namespaces: string[];
  try {
    namespaces = await readdir(root);
  } catch {
    return entries;
  }
  for (const namespace of namespaces) {
    let resources: string[];
    try {
      resources = await readdir(join(root, namespace));
    } catch {
      continue;
    }
    for (const resource of resources) {
      let files: string[];
      try {
        files = await readdir(join(root, namespace, resource));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        // e.g. "primary" / "/calendars/{calendarId}/events" -> "calendars/{calendarId}/events"
        const readableResource = decode(resource).replace(/^\/+/, '');
        entries.push({
          zipPath: join(decode(namespace), readableResource, decode(file)),
          absPath: join(root, namespace, resource, file),
        });
      }
    }
  }
  return entries;
}

/**
 * Packages the entire local-first copy under `dataDir` into a ZIP: one JSON
 * file per record, grouped by account/calendar and resource. This is the
 * download the app is named for.
 */
export async function buildZip(dataDir: string): Promise<Buffer> {
  const zip = new JSZip();
  const entries = await walk(dataDir);
  for (const entry of entries) {
    zip.file(entry.zipPath, await readFile(entry.absPath, 'utf8'));
  }
  zip.file(
    'README.txt',
    [
      'Zipper export',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Records: ${entries.length}`,
      '',
      'This archive is a full local copy of your Google Calendar data as read',
      'by Zipper. Each JSON file is one record (a calendar list entry or an',
      'event), grouped by calendar and resource.',
      '',
    ].join('\n'),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
