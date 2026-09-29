/**
 * The browser-safe subset of the core used by renderers: expression
 * evaluation and tree walking. No Ajv, no schemas.
 */
export { evaluate, inert, isAction, type Action, type EvalContext } from './build/evaluate.ts';
export { FunctionError, functionKey, type AsyncFunctionRunner, type FunctionCall, type FunctionErrorKind, type FunctionResult, type FunctionRunner } from './build/functions.ts';
export { getPath, isBinding, isCall, isCan, isFn, walkTree, walkValue } from './build/expressions.ts';
export { removeRow } from './build/rows.ts';
export type { Build, BuildCode, DataSource, TreeNode, Value } from './build/types.ts';
export type { SurfaceFunctions } from './surface/types.ts';
export { describeCheck, type CheckDescribers } from './verifier/describe.ts';
