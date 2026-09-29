import { canActOnOwn as authCanActOnOwn, Permissions } from '@emdash-cms/auth';
import { describe, expect, it } from 'vitest';
import { canActOnOwn, permissions } from '../src/host/permissions.ts';
import { roles } from '../src/host/surface.ts';

describe('the permission table', () => {
	it('matches EmDash', () => {
		for (const [name, level] of Object.entries(permissions)) {
			expect(Permissions[name as keyof typeof Permissions], name).toBe(level);
		}
	});

	it('decides "own" permissions like EmDash', () => {
		for (const role of Object.values(roles)) {
			for (const owner of ['u1', 'u2', '']) {
				const user = { id: 'u1', role };
				expect(canActOnOwn(user, owner, 'content:publish_own', 'content:publish_any')).toBe(authCanActOnOwn(user as never, owner, 'content:publish_own', 'content:publish_any'));
			}
		}
	});
});
