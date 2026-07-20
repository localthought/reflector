import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { FileStorageAdapter } from '../../src/sync/file-storage.js';
import { buildZip } from '../../src/sync/zip.js';

describe('buildZip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zipper-zip-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('packages the local copy into a readable archive', async () => {
    const events = new FileStorageAdapter(dir, 'primary');
    await events.put('/calendars/{calendarId}/events', 'e1', { id: 'e1', summary: 'One' });
    const calendars = new FileStorageAdapter(dir, '_account');
    await calendars.put('/users/me/calendarList', 'primary', { id: 'primary' });

    const buffer = await buildZip(dir);
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);

    expect(names).toContain('README.txt');
    // Paths are decoded to readable, nested form grouped by namespace/resource.
    expect(names).toContain('primary/calendars/{calendarId}/events/e1.json');
    expect(names).toContain('_account/users/me/calendarList/primary.json');

    const content = await zip.file('primary/calendars/{calendarId}/events/e1.json')?.async('string');
    expect(JSON.parse(content ?? '{}')).toMatchObject({ summary: 'One' });
  });

  it('produces an archive with just a README when there is no data', async () => {
    const zip = await JSZip.loadAsync(await buildZip(dir));
    expect(Object.keys(zip.files)).toEqual(['README.txt']);
  });
});
