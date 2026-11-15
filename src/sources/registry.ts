import type { HttpClient } from '../http/client.js';
import { ImovirtualAdapter } from './imovirtual/index.js';
import { OlxAdapter } from './olx/index.js';
import type { SourceAdapter } from './types.js';

/**
 * Every supported website. To add one: create src/sources/<site>/ with an
 * adapter implementing SourceAdapter, list it here, and add a block for it
 * under `sources:` in the config.
 */
export function createAdapters(http: HttpClient): SourceAdapter[] {
  return [new ImovirtualAdapter(http), new OlxAdapter(http)];
}
