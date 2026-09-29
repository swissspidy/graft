import type { AndExpr, Binding, CallExpr, CanExpr, DataRef, EqExpr, Expression, FieldRef, NotExpr, OrExpr, SlotRef, TreeNode, Value } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isDataRef = (v: unknown): v is DataRef => isRecord(v) && typeof v.$data === 'string';
export const isFieldRef = (v: unknown): v is FieldRef => isRecord(v) && typeof v.$field === 'string';
export const isSlotRef = (v: unknown): v is SlotRef => isRecord(v) && typeof v.$slot === 'string';
export const isCan = (v: unknown): v is CanExpr => isRecord(v) && typeof v.$can === 'string';
export const isCall = (v: unknown): v is CallExpr => isRecord(v) && typeof v.$call === 'string';
export const isEq = (v: unknown): v is EqExpr => isRecord(v) && Array.isArray(v.$eq);
export const isAnd = (v: unknown): v is AndExpr => isRecord(v) && Array.isArray(v.$and);
export const isOr = (v: unknown): v is OrExpr => isRecord(v) && Array.isArray(v.$or);
export const isNot = (v: unknown): v is NotExpr => isRecord(v) && Object.hasOwn(v, '$not');
export const isBinding = (v: unknown): v is Binding => isDataRef(v) || isFieldRef(v) || isSlotRef(v);
export const isExpression = (v: unknown): v is Expression =>
	isBinding(v) || isCan(v) || isCall(v) || isEq(v) || isAnd(v) || isOr(v) || isNot(v);

/** Visits every value (depth first, parents before children) with its JSON pointer. */
export function walkValue(value: Value | undefined, path: string, visit: (value: Value, path: string) => void): void {
	if (value === undefined) {
		return;
	}
	visit(value, path);
	if (Array.isArray(value)) {
		value.forEach((item, i) => walkValue(item, `${path}/${i}`, visit));
	} else if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			walkValue(item as Value, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, visit);
		}
	}
}

/** Visits every tree node with its JSON pointer. */
export function walkTree(node: TreeNode, path: string, visit: (node: TreeNode, path: string) => void): void {
	visit(node, path);
	if (Array.isArray(node.children)) {
		node.children.forEach((child, i) => walkTree(child, `${path}/children/${i}`, visit));
	}
}

/** Reads a dotted path (`a.b.0`) from a value. An empty path returns the value. */
export function getPath(value: unknown, path: string): unknown {
	if (path === '') {
		return value;
	}
	let current: unknown = value;
	for (const segment of path.split('.')) {
		if (current === null || current === undefined) {
			return undefined;
		}
		if (Array.isArray(current) && /^\d+$/.test(segment)) {
			current = current[Number(segment)];
		} else if (isRecord(current) && Object.hasOwn(current, segment)) {
			current = current[segment];
		} else {
			return undefined;
		}
	}
	return current;
}
