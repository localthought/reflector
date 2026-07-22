import { loadOpenApiDocument, type OpenApiDocument } from 'syncables';
import type { ZipperConfig } from '../config/index.js';
import {
  adaptSchemesForSyncables,
  applyOverlay,
  loadYamlFile,
  pinItemsFields,
  type OverlayDocument,
} from './overlay.js';

/** Overlay files applied, in order, on top of the base document. */
const OVERLAY_FILES = [
  'auth-overlay.yaml',
  'pagination-overlay.yaml',
  'crud-causality-overlay.yaml',
];

/**
 * Loads the vendored OpenAPI document and applies every overlay in
 * `config.overlayDir`. The overlays are what make the document self-describing
 * enough to drive the whole app: an OAuth security scheme (auth), pagination
 * schemes (paging), and CRUD-causality resources (what to sync and how). The
 * resulting pagination schemes are then normalized into the shape the syncables
 * engine understands.
 */
export async function buildDocument(
  config: ZipperConfig,
): Promise<OpenApiDocument> {
  let document = await loadOpenApiDocument(config.openApiPath);
  for (const file of OVERLAY_FILES) {
    const overlay = await loadYamlFile<OverlayDocument>(
      `${config.overlayDir}/${file}`,
    );
    document = applyOverlay(document, overlay);
  }
  return pinItemsFields(adaptSchemesForSyncables(document));
}

/**
 * Narrows a document to just the given paths (keeping shared `components`),
 * so a syncables client created from it discovers and syncs only the intended
 * resource. Without this, one client's `sync()` would try to GET every
 * collection in the full API — including paths with unbound variables or no
 * list operation.
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
