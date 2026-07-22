import JSZip from 'jszip';
import type { ExportRecord } from './storage.js';

/** Builds the readable, nested path a record takes inside the archive. */
function zipPath(record: ExportRecord): string {
  // e.g. "primary" / "/calendars/{calendarId}/events" / "e1"
  //   -> "primary/calendars/{calendarId}/events/e1.json"
  const resource = record.resource.replace(/^\/+/, '');
  return [record.namespace, resource, `${record.id}.json`]
    .filter((part) => part.length > 0)
    .join('/');
}

/**
 * Packages an entire local-first copy into a ZIP: one JSON file per record,
 * grouped by account/calendar and resource. The records come from whichever
 * {@link StorageBackend} is active (on-disk files or the user's remoteStorage
 * account), so the download works the same regardless of where data lives.
 * This is the download the app is named for.
 */
export async function buildZip(records: ExportRecord[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const record of records) {
    zip.file(zipPath(record), JSON.stringify(record.value, null, 2));
  }
  zip.file(
    'README.txt',
    [
      'Zipper export',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Records: ${records.length}`,
      '',
      'This archive is a full local copy of your Google Calendar data as read',
      'by Zipper. Each JSON file is one record (a calendar list entry or an',
      'event), grouped by calendar and resource.',
      '',
    ].join('\n'),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
