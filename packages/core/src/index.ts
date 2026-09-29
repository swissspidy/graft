export { hasErrors, type Diagnostic, type Severity } from './diagnostics.ts';
export { createAjv } from './ajv.ts';
export { parseSpec, type ParsedSpec } from './spec/parse.ts';
export { validateSpec, type SpecValidation, type ValidateSpecOptions } from './spec/validate.ts';
export { checkManifestAgainstSurface } from './spec/surface.ts';
export { deriveCriterionId } from './spec/criteria.ts';
export type { Criterion, Section, Spec, SpecManifest } from './spec/types.ts';
export { validateSurface, type SurfaceValidation } from './surface/validate.ts';
export { canonicalJson, hashSurface, sha256 } from './surface/hash.ts';
export type { Capability, Component, JsonSchema, Migration, Scope, Slot, Surface } from './surface/types.ts';
export { hashSpec, normalizeSpecSource } from './spec/hash.ts';
export type { AndExpr, Binding, Build, CallExpr, CanExpr, Check, DataRef, DataSource, EqExpr, Expression, FieldRef, Logic, NotExpr, OrExpr, Refs, SlotRef, TreeNode, Value } from './build/types.ts';
export { getPath, isAnd, isBinding, isCall, isCan, isDataRef, isEq, isExpression, isFieldRef, isNot, isOr, isSlotRef, walkTree, walkValue } from './build/expressions.ts';
export { evaluate, isAction, type Action, type EvalContext } from './build/evaluate.ts';
export { extractRefs } from './build/refs.ts';
export { validateBuild, type BuildValidation, type ValidateBuildOptions } from './build/validate.ts';
export { nextSpecState, specEvents, specLifecycle, type SpecEvent, type SpecState } from './lifecycle/spec.ts';
export { removeRow } from './build/rows.ts';
export { SandboxCallError, type Sandbox } from './verifier/sandbox.ts';
export {
	allActions,
	snapshotTree,
	type ComponentSemantics,
	type SemanticsArgs,
	type Snapshot,
	type SnapshotAction,
	type SnapshotEmitter,
	type SnapshotRow,
	type SnapshotTable,
} from './verifier/snapshot.ts';
export { matchesRecord, verifyBuild, type CheckResult, type Verification, type VerifyOptions } from './verifier/run.ts';
