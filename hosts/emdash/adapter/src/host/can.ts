/**
 * The EmDash `$can` check, shared by the plugin's renderer and the verifier
 * so both judge permissions the same way.
 *
 * A scope is usable when it is granted and the viewer's role has the EmDash
 * permissions it maps to. On an entry from the Graft capabilities, the
 * entry's own `can` flags refine the answer (authors publish only their own
 * entries).
 */
const objectChecks: Record<string, string> = {
	'content.status:write': 'publish',
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
