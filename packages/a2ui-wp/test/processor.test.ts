import { describe, expect, it, vi } from 'vitest';
import { A2UIProcessor } from '../src/core/processor';
import type { ActionMessage } from '../src/core/types';

const CATALOG =
	'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';

const create = ( surfaceId = 's1' ) => ( {
	version: 'v0.9.1',
	createSurface: { surfaceId, catalogId: CATALOG, sendDataModel: true },
} );

describe( 'A2UIProcessor', () => {
	it( 'creates, updates and deletes surfaces while notifying subscribers', () => {
		const processor = new A2UIProcessor();
		const listener = vi.fn();
		processor.subscribe( listener );

		processor.processMessage( create() );
		expect( processor.getSurface( 's1' ) ).toBeDefined();
		expect( processor.getSurface( 's1' )?.root ).toBeUndefined();

		processor.processMessage( {
			version: 'v0.9.1',
			updateComponents: {
				surfaceId: 's1',
				components: [ { id: 'root', component: 'Text', text: 'hi' } ],
			},
		} );
		expect( processor.getSurface( 's1' )?.root?.component ).toBe( 'Text' );

		processor.processMessage( {
			version: 'v0.9.1',
			updateDataModel: { surfaceId: 's1', path: '/a/b', value: 1 },
		} );
		expect( processor.getSurface( 's1' )?.dataModel.get( '/a/b' ) ).toBe(
			1
		);

		processor.processMessage( {
			version: 'v0.9.1',
			updateDataModel: { surfaceId: 's1', path: '/a/b' },
		} );
		expect( processor.getSurface( 's1' )?.dataModel.get( '/a' ) ).toEqual(
			{}
		);

		processor.processMessage( {
			version: 'v0.9.1',
			deleteSurface: { surfaceId: 's1' },
		} );
		expect( processor.getSurface( 's1' ) ).toBeUndefined();
		expect( listener ).toHaveBeenCalledTimes( 5 );
	} );

	it( 'keeps the previous type when a component update omits it', () => {
		const processor = new A2UIProcessor();
		processor.processMessage( create() );
		processor.processMessage( {
			updateComponents: {
				surfaceId: 's1',
				components: [ { id: 'root', component: 'Text', text: 'a' } ],
			},
		} );
		processor.processMessage( {
			updateComponents: {
				surfaceId: 's1',
				components: [ { id: 'root', text: 'b' } ],
			},
		} );
		expect( processor.getSurface( 's1' )?.root ).toMatchObject( {
			component: 'Text',
			text: 'b',
		} );
	} );

	it( 'rejects invalid messages', () => {
		const processor = new A2UIProcessor();
		expect( () =>
			processor.processMessage( {
				version: 'v1.0',
				createSurface: { surfaceId: 'x', catalogId: CATALOG },
			} )
		).toThrow( /Unsupported protocol version/ );
		expect( () =>
			processor.processMessage( {
				updateComponents: { surfaceId: 'nope', components: [] },
			} )
		).toThrow( /does not exist/ );
		processor.processMessage( create() );
		expect( () => processor.processMessage( create() ) ).toThrow(
			/already exists/
		);
		expect( () =>
			processor.processMessage( {
				updateComponents: {
					surfaceId: 's1',
					components: [ { component: 'Text' } ],
				},
			} )
		).toThrow( /missing an 'id'/ );
		expect( () =>
			processor.processMessage( {
				createSurface: { surfaceId: 'a' },
				deleteSurface: { surfaceId: 'a' },
			} )
		).toThrow( /multiple/ );
		expect( () =>
			new A2UIProcessor( { strictCatalogs: true } ).processMessage( {
				createSurface: { surfaceId: 'a', catalogId: 'x' },
			} )
		).toThrow( /Unsupported catalog/ );
	} );

	it( 'processes JSON Lines and collects errors without stopping', () => {
		const processor = new A2UIProcessor();
		const errors = processor.processJsonl(
			[
				JSON.stringify( create() ),
				'not json',
				'',
				JSON.stringify( {
					updateDataModel: { surfaceId: 's1', value: { ok: true } },
				} ),
			].join( '\n' )
		);
		expect( errors ).toHaveLength( 1 );
		expect( errors[ 0 ].line ).toBe( 2 );
		expect( processor.getSurface( 's1' )?.dataModel.get( '/ok' ) ).toBe(
			true
		);
	} );

	it( 'dispatches actions with resolved context and echoes the surface version', () => {
		const processor = new A2UIProcessor();
		const actions: ActionMessage[] = [];
		processor.onAction( ( message ) => actions.push( message ) );
		processor.processMessage( create() );
		processor.processMessage( {
			updateDataModel: {
				surfaceId: 's1',
				value: { items: [ { id: 'i1' }, { id: 'i2' } ], note: 'n' },
			},
		} );

		processor.dispatchAction(
			's1',
			'btn',
			{
				event: {
					name: 'pick',
					context: {
						id: { path: 'id' },
						note: { path: '/note' },
						fixed: 1,
						missing: { path: '/nope' },
					},
				},
			},
			'/items/1'
		);

		expect( actions ).toHaveLength( 1 );
		expect( actions[ 0 ].version ).toBe( 'v0.9.1' );
		expect( actions[ 0 ].action ).toMatchObject( {
			name: 'pick',
			surfaceId: 's1',
			sourceComponentId: 'btn',
			context: { id: 'i2', note: 'n', fixed: 1, missing: null },
		} );
		expect( new Date( actions[ 0 ].action.timestamp ).toISOString() ).toBe(
			actions[ 0 ].action.timestamp
		);
	} );

	it( 'runs local function-call actions', () => {
		const openUrl = vi.fn();
		const processor = new A2UIProcessor( { openUrl } );
		processor.processMessage( create() );
		processor.processMessage( {
			updateDataModel: {
				surfaceId: 's1',
				value: { url: 'https://wordpress.org/' },
			},
		} );
		processor.dispatchAction( 's1', 'btn', {
			functionCall: { call: 'openUrl', args: { url: { path: '/url' } } },
		} );
		expect( openUrl ).toHaveBeenCalledWith( 'https://wordpress.org/' );
	} );

	it( 'exposes capabilities and the client data model', () => {
		const processor = new A2UIProcessor();
		processor.processMessage( create() );
		processor.processMessage( {
			createSurface: { surfaceId: 's2', catalogId: CATALOG },
		} );
		processor.processMessage( {
			updateDataModel: { surfaceId: 's1', value: { a: 1 } },
		} );
		expect(
			processor.getClientCapabilities()[ 'v0.9.1' ].supportedCatalogIds
		).toContain( CATALOG );
		expect( processor.getClientDataModel() ).toEqual( {
			version: 'v0.9.1',
			surfaces: { s1: { a: 1 } },
		} );
	} );
} );
