/**
 * The WordPress `$can` check, shared by the browser runtime and the
 * verifier so both judge permissions the same way.
 *
 * A scope is usable when it is granted and the user has the WordPress
 * capabilities it maps to (computed by the host). On a post object from
 * the Graft abilities, the post's own `can` flags refine the answer.
 */
const objectChecks: Record<string, string> = {
	'posts.status:write': 'publish',
	'posts:write': 'edit',
};

export function createCan(usable: Record<string, boolean>) {
	return (scope: string, on: unknown): boolean => {
		if (usable[scope] !== true) {
			return false;
		}
		const key = objectChecks[scope];
		if (key && typeof on === 'object' && on !== null) {
			const can = (on as { can?: Record<string, unknown> }).can;
			if (can && key in can) {
				return can[key] === true;
			}
		}
		return true;
	};
}
