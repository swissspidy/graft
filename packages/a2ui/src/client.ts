/**
 * What a browser renderer needs, without @graft/core's validation (ajv,
 * yaml): the Graft catalog on web_core, the verifier's seeding of the data
 * model, table fields, event inputs and the build's types. Keeps a page
 * that draws A2UI builds small.
 */
export { createGraftCatalog } from './catalog.ts';
export { seed } from './walk.ts';
export { tableField } from './table.ts';
export { withContext } from './events.ts';
export type { A2UIBuild, A2UIComponent, A2UISurface, EventBinding } from './types.ts';
