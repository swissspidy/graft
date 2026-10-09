/**
 * The browser-safe subset of the core used by renderers: expression
 * evaluation. No Ajv, no schemas.
 */
export { evaluate, isAction, type Action, type EvalContext } from './build/evaluate.ts';
export { getPath, isBinding, isCan, walkValue } from './build/expressions.ts';
export { removeRow } from './build/rows.ts';
export type { Build, DataSource, Value } from './build/types.ts';
export { describeCheck, type CheckDescribers } from './verifier/describe.ts';
