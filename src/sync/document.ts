import { loadOpenApiDocument, type OpenApiDocument } from 'syncables';
import type { ZipperConfig } from '../config/index.js';
import {
  adaptSchemesForSyncables,
  applyOverlay,
  loadYamlFile,
  pinItemsFields,
  type OverlayDocument,
} from './overlay.js';

/**
 * Loads the vendored Google Calendar OpenAPI document, applies the
 * localthought/overlays Calendar overlays (pagination + CRUD causality) that
 * define how a client interacts with the API, and normalizes the resulting
 * pagination schemes into the shape the syncables engine understands.
 */
export async function buildCalendarDocument(
  config: ZipperConfig,
): Promise<OpenApiDocument> {
  const base = await loadOpenApiDocument(config.openApiPath);
  const pagination = await loadYamlFile<OverlayDocument>(
    `${config.overlayDir}/pagination-overlay.yaml`,
  );
  const crud = await loadYamlFile<OverlayDocument>(
    `${config.overlayDir}/crud-causality-overlay.yaml`,
  );
  const overlaid = applyOverlay(applyOverlay(base, pagination), crud);
  return pinItemsFields(adaptSchemesForSyncables(overlaid));
}

/**
 * Narrows a document to just the given paths (keeping shared `components`),
 * so a syncables client created from it discovers and syncs only the intended
 * resource. Without this, one client's `sync()` would try to GET every
 * collection in the full Calendar API — including paths with unbound
 * variables or no list operation.
 */
export function subsetDocument(
  document: OpenApiDocument,
  paths: string[],
): OpenApiDocument {
  const picked: OpenApiDocument['paths'] = {};
  for (const path of paths) {
    const item = document.paths[path];
    if (item) {
      picked[path] = item;
    }
  }
  return {
    openapi: document.openapi,
    info: document.info,
    paths: picked,
    ...(document.components ? { components: document.components } : {}),
  };
}

/** Path templates for the resources Zipper reads and edits. */
export const CALENDAR_LIST_PATHS = [
  '/users/me/calendarList',
  '/users/me/calendarList/{calendarId}',
];
export const EVENT_PATHS = [
  '/calendars/{calendarId}/events',
  '/calendars/{calendarId}/events/{eventId}',
];

export const CALENDAR_LIST_COLLECTION = '/users/me/calendarList';
export const EVENTS_COLLECTION = '/calendars/{calendarId}/events';
