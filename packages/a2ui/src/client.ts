/**
 * What a renderer needs, without A2UI's function machinery or zod: the
 * catalog's functions as plain JavaScript, table fields, event inputs and
 * the build's types. Keeps a page that draws A2UI builds small.
 */
export { pureFunctions, readPointer, type PureFunction } from './functions.ts';
export { tableField } from './table.ts';
export { withContext } from './events.ts';
export type { A2UIBuild, A2UIComponent, A2UISurface, EventBinding } from './types.ts';
