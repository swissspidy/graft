import { describe, expect, it } from 'vitest';
import { hashSurface, validateSpec, validateSurface, type Surface } from '../src/index.ts';

function surface(): Surface {
	return {
		graft: 1,
		host: 'acme',
		hostVersion: '1.0.0',
		slots: {
			'admin.page': {
				kind: 'owned',
				title: 'Page',
				options: {
					type: 'object',
					properties: { title: { type: 'string', minLength: 1 } },
					required: ['title'],
					additionalProperties: false,
				},
			},
			'list.row-actions': { kind: 'extension', title: 'Row actions', screen: 'list', accepts: ['button'] },
			'old.page': { kind: 'owned', title: 'Old', deprecated: true, successor: 'admin.page' },
		},
		components: {
			button: { props: { type: 'object', properties: { label: { type: 'string' } } } },
		},
		capabilities: {
			'items.list': {
				kind: 'read',
				input: { type: 'object' },
				output: { type: 'object', properties: { when: { type: 'string', format: 'date-time' } } },
				scopes: ['items:read'],
			},
		},
		scopes: { 'items:read': { title: 'See items' } },
		audiences: ['staff'],
	};
}

const spec = (frontmatter: string) => `---
graft: 1
id: demo
host: acme
${frontmatter}
---

# Demo

Something useful.

## Acceptance criteria

- It works {#works}
`;

describe('validateSurface', () => {
	it('accepts a consistent surface and returns its hash', async () => {
		const result = await validateSurface(surface());
		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('hashes the contract, not where it came from', async () => {
		const a = surface();
		const b = { ...surface(), hostVersion: '1.0.1', migrations: [] };
		const reordered = { ...surface(), scopes: { 'items:read': { title: 'See items' } }, slots: surface().slots };
		expect(await hashSurface(a)).toBe(await hashSurface(b));
		expect(await hashSurface(a)).toBe(await hashSurface(reordered));
		expect(await hashSurface(a)).not.toBe(await hashSurface({ ...a, audiences: ['staff', 'guests'] }));
	});

	it('verifies a stored hash', async () => {
		const s = surface();
		s.hash = await hashSurface(s);
		expect((await validateSurface(s)).ok).toBe(true);
		s.audiences = ['everyone'];
		expect((await validateSurface(s)).diagnostics.map((d) => d.code)).toEqual(['surface-hash-mismatch']);
	});

	it('reports references to undeclared symbols', async () => {
		const s = surface();
		s.slots['list.row-actions']!.accepts = ['link'];
		s.slots['old.page']!.successor = 'gone.page';
		s.capabilities['items.list']!.scopes = ['items:write'];
		s.migrations = [{ op: 'rename', kind: 'capability', from: 'things.list', to: 'things.all' }];
		const result = await validateSurface(s);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
			['surface-unknown-component', '/slots/list.row-actions/accepts'],
			['surface-unknown-slot', '/slots/old.page/successor'],
			['surface-unknown-scope', '/capabilities/items.list/scopes'],
			['surface-migration-target', '/migrations/0/to'],
		]);
	});

	it('rejects embedded schemas that do not compile', async () => {
		const s = surface();
		s.components.button!.props = { type: 'object', properties: { label: { type: 'strin' } } };
		expect((await validateSurface(s)).diagnostics).toEqual([
			expect.objectContaining({ code: 'surface-invalid-schema', path: '/components/button/props' }),
		]);
	});

	it('rejects documents of the wrong shape', async () => {
		const result = await validateSurface({ graft: 1, host: 'acme' });
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.code).toBe('surface-schema');
	});
});

describe('validateSpec against a surface', () => {
	const s = surface();

	it('passes a spec that fits the surface', () => {
		const result = validateSpec(spec('mount: { slot: admin.page, title: Demo }\naudience: [staff]\npermissions: [items:read]'), { surface: s });
		expect(result.diagnostics).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('reports unknown slots, bad options, audiences and scopes on their lines', () => {
		const result = validateSpec(
			spec('mount:\n  slot: admin.page\n  color: red\naudience: [staff, guests]\npermissions: [items:read, items:write]'),
			{ surface: s },
		);
		expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
			['mount-invalid-options', 6],
			['mount-invalid-options', 7],
			['audience-unknown', 8],
			['permission-unknown-scope', 9],
		]);
		expect(result.diagnostics[0]?.message).toBe('"mount" is missing required field "title".');
		expect(result.diagnostics[1]?.message).toBe('"mount" has unknown field "color".');

		const unknown = validateSpec(spec('mount: { slot: side.panel }\npermissions: []'), { surface: s });
		expect(unknown.diagnostics[0]?.message).toContain('Slot "side.panel" does not exist in acme 1.0.0. Available: admin.page');
	});

	it('warns about deprecated slots', () => {
		const result = validateSpec(spec('mount: { slot: old.page }\npermissions: []'), { surface: s });
		expect(result.ok).toBe(true);
		expect(result.diagnostics[0]?.message).toBe('Slot "old.page" is deprecated; use "admin.page".');
	});

	it('refuses a surface for another host', () => {
		const result = validateSpec(spec('mount: { slot: admin.page }\npermissions: []'), { surface: { ...s, host: 'other' } });
		expect(result.diagnostics.map((d) => d.code)).toEqual(['surface-host-mismatch']);
	});

	it('skips phase two when the manifest is invalid', () => {
		const result = validateSpec(spec('mount: { slot: nope }\npermissions: [BAD]'), { surface: s });
		expect(result.diagnostics.map((d) => d.code)).toEqual(['frontmatter-schema']);
	});
});
