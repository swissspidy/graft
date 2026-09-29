/**
 * The EmDash RBAC permissions Graft checks, with the lowest role level that
 * holds each (from @emdash-cms/auth; test/permissions.test.ts keeps them in
 * step). A copy, so the sandboxed plugin does not bundle EmDash's auth
 * package.
 */
export const permissions = {
	'content:read': 10,
	'content:read_drafts': 20,
	'content:publish_own': 30,
	'content:publish_any': 40,
	'plugins:manage': 50,
} as const;

export type Permission = keyof typeof permissions;

export function hasPermission(user: { role: number } | null | undefined, permission: Permission): boolean {
	return !!user && user.role >= permissions[permission];
}

/** An "own" permission on the user's own object, or the "any" permission. */
export function canActOnOwn(user: { id: string; role: number } | null | undefined, ownerId: string, own: Permission, any: Permission): boolean {
	if (!user) {
		return false;
	}
	return hasPermission(user, any) || (user.id === ownerId && hasPermission(user, own));
}
