/**
 * The browser-safe subset of the core used by renderers: expression
 * evaluation and tree walking. No Ajv, no schemas.
 */
export { evaluate, isAction, type Action, type EvalContext } from './build/evaluate.ts';
export { getPath, isBinding, isCall, isCan, walkTree, walkValue } from './build/expressions.ts';
export { removeRow } from './build/rows.ts';
export type { Build, DataSource, TreeNode, Value } from './build/types.ts';
