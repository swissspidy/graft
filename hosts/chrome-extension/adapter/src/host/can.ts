import type { Surface } from '@swissspidy/graft-core';

/**
 * Permission checks in the browser host, shared by the gateway and the
 * verifier. A scope is usable when it is granted and the app role of the
 * viewer is one the surface maps it to (`scope.host`). The app's own API
 * still decides every call; this only decides what the UI offers.
 */

/** Which of `scopes` the viewer can use: granted, and allowed for their app role. */
export function usableScopes(surface: Surface, role: string | undefined, granted: string[], scopes: string[] = Object.keys(surface.scopes)): Record<string, boolean> {
	return Object.fromEntries(
		scopes.map((scope) => {
			const declared = surface.scopes[scope];
			const roles = declared?.host;
			return [scope, declared !== undefined && granted.includes(scope) && (roles === undefined || (role !== undefined && roles.includes(role)))];
		}),
	);
}

export function createCan(usable: Record<string, boolean>) {
	return (scope: string): boolean => usable[scope] === true;
}
