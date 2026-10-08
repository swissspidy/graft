/**
 * The A2UI message processor: consumes server → client messages, maintains
 * surfaces, and produces client → server `action` messages.
 *
 * It is framework agnostic. UI layers subscribe with `subscribe()` and read
 * `getVersion()` (a monotonically increasing change counter), which makes it
 * a drop-in external store for React's `useSyncExternalStore`.
 */

import { A2UIProtocolError } from './errors';
import {
	createBasicFunctions,
	type BasicFunctionOptions,
	type FunctionRegistry,
} from './functions';
import { resolveDynamicValue, type ResolveScope } from './resolver';
import { Surface } from './surface';
import type {
	Action,
	ActionMessage,
	ClientCapabilities,
	ClientDataModel,
	ClientMessage,
	ComponentId,
	CreateSurfacePayload,
	DeleteSurfacePayload,
	ErrorMessage,
	JsonObject,
	JsonValue,
	ServerMessage,
	UpdateComponentsPayload,
	UpdateDataModelPayload,
} from './types';

export const BASIC_CATALOG_IDS = [
	'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
	'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json',
];

export const DEFAULT_PROTOCOL_VERSION = 'v0.9.1';

export interface ProcessorOptions extends BasicFunctionOptions {
	/** Extra or overriding client-side functions. */
	functions?: FunctionRegistry;
	/** Catalog ids this client advertises and accepts. Defaults to the basic catalog. */
	supportedCatalogIds?: string[];
	/** When true, `createSurface` with an unknown catalog id is rejected. */
	strictCatalogs?: boolean;
}

export type ActionListener = (
	message: ActionMessage,
	surface: Surface
) => void;
export type ClientMessageListener = ( message: ClientMessage ) => void;
export type ChangeListener = () => void;

const SUPPORTED_VERSION_PREFIX = 'v0.9';

export class A2UIProcessor {
	readonly surfaces = new Map< string, Surface >();
	readonly functions: FunctionRegistry;
	readonly supportedCatalogIds: string[];
	readonly locale?: string;

	private readonly strictCatalogs: boolean;
	private version = 0;
	private readonly changeListeners = new Set< ChangeListener >();
	private readonly actionListeners = new Set< ActionListener >();
	private readonly clientMessageListeners =
		new Set< ClientMessageListener >();
	private readonly dataModelUnsubscribers = new Map< string, () => void >();

	constructor( options: ProcessorOptions = {} ) {
		this.functions = {
			...createBasicFunctions( options ),
			...( options.functions ?? {} ),
		};
		this.supportedCatalogIds =
			options.supportedCatalogIds ?? BASIC_CATALOG_IDS;
		this.strictCatalogs = options.strictCatalogs ?? false;
		this.locale = options.locale;
	}

	// -- Change notification --------------------------------------------------

	subscribe( listener: ChangeListener ): () => void {
		this.changeListeners.add( listener );
		return () => {
			this.changeListeners.delete( listener );
		};
	}

	getVersion(): number {
		return this.version;
	}

	private notify() {
		this.version++;
		for ( const listener of this.changeListeners ) {
			listener();
		}
	}

	// -- Outbound messages ----------------------------------------------------

	/**
	 * Listen for `action` messages that should be sent to the agent.
	 * @param listener Callback.
	 */
	onAction( listener: ActionListener ): () => void {
		this.actionListeners.add( listener );
		return () => {
			this.actionListeners.delete( listener );
		};
	}

	/**
	 * Listen for every client → server message (`action` and `error`).
	 * @param listener Callback.
	 */
	onClientMessage( listener: ClientMessageListener ): () => void {
		this.clientMessageListeners.add( listener );
		return () => {
			this.clientMessageListeners.delete( listener );
		};
	}

	private emitClientMessage( message: ClientMessage ) {
		for ( const listener of this.clientMessageListeners ) {
			listener( message );
		}
	}

	// -- Inbound messages -----------------------------------------------------

	/**
	 * Processes one message. Throws `A2UIProtocolError` on invalid input.
	 * @param input A parsed server message.
	 */
	processMessage( input: unknown ): void {
		const message = input as Partial< ServerMessage > & {
			version?: string;
		};
		if ( ! message || typeof message !== 'object' ) {
			throw new A2UIProtocolError( 'Message is not an object.' );
		}
		if (
			typeof message.version === 'string' &&
			! message.version.startsWith( SUPPORTED_VERSION_PREFIX )
		) {
			throw new A2UIProtocolError(
				`Unsupported protocol version '${ message.version }'. This renderer speaks ${ SUPPORTED_VERSION_PREFIX }.x.`
			);
		}
		const kinds = [
			'createSurface',
			'updateComponents',
			'updateDataModel',
			'deleteSurface',
		].filter( ( key ) => key in message );
		if ( kinds.length !== 1 ) {
			throw new A2UIProtocolError(
				kinds.length === 0
					? 'Message contains no known update type.'
					: `Message contains multiple update types: ${ kinds.join( ', ' ) }.`
			);
		}
		switch ( kinds[ 0 ] ) {
			case 'createSurface':
				this.createSurface(
					( message as { createSurface: CreateSurfacePayload } )
						.createSurface,
					message.version
				);
				break;
			case 'updateComponents':
				this.updateComponents(
					( message as { updateComponents: UpdateComponentsPayload } )
						.updateComponents
				);
				break;
			case 'updateDataModel':
				this.updateDataModel(
					( message as { updateDataModel: UpdateDataModelPayload } )
						.updateDataModel
				);
				break;
			case 'deleteSurface':
				this.deleteSurface(
					( message as { deleteSurface: DeleteSurfacePayload } )
						.deleteSurface
				);
				break;
		}
	}

	/**
	 * Processes several messages. Stops at the first invalid one and throws.
	 * @param messages Messages, or a wrapper object with a `messages` array.
	 */
	processMessages( messages: unknown[] | { messages: unknown[] } ): void {
		const list = Array.isArray( messages ) ? messages : messages.messages;
		for ( const message of list ) {
			this.processMessage( message );
		}
	}

	/**
	 * Processes a JSON Lines stream (one message per line). Invalid lines are
	 * collected and returned instead of thrown so a stream keeps flowing.
	 * @param text JSON Lines text.
	 */
	processJsonl( text: string ): Array< { line: number; error: Error } > {
		const errors: Array< { line: number; error: Error } > = [];
		text.split( /\r?\n/ ).forEach( ( raw, index ) => {
			const line = raw.trim();
			if ( ! line ) {
				return;
			}
			try {
				this.processMessage( JSON.parse( line ) );
			} catch ( error ) {
				errors.push( {
					line: index + 1,
					error:
						error instanceof Error
							? error
							: new Error( String( error ) ),
				} );
			}
		} );
		return errors;
	}

	private createSurface( payload: CreateSurfacePayload, version?: string ) {
		if ( ! payload?.surfaceId ) {
			throw new A2UIProtocolError(
				"'createSurface' requires a 'surfaceId'.",
				undefined,
				'/createSurface/surfaceId'
			);
		}
		if ( ! payload.catalogId ) {
			throw new A2UIProtocolError(
				"'createSurface' requires a 'catalogId'.",
				payload.surfaceId,
				'/createSurface/catalogId'
			);
		}
		if (
			this.strictCatalogs &&
			! this.supportedCatalogIds.includes( payload.catalogId )
		) {
			throw new A2UIProtocolError(
				`Unsupported catalog '${ payload.catalogId }'.`,
				payload.surfaceId,
				'/createSurface/catalogId'
			);
		}
		if ( this.surfaces.has( payload.surfaceId ) ) {
			throw new A2UIProtocolError(
				`Surface '${ payload.surfaceId }' already exists. Delete it before creating it again.`,
				payload.surfaceId
			);
		}
		const surface = new Surface(
			payload.surfaceId,
			payload.catalogId,
			payload.theme ?? {},
			payload.sendDataModel ?? false,
			version ?? DEFAULT_PROTOCOL_VERSION
		);
		this.surfaces.set( surface.id, surface );
		this.dataModelUnsubscribers.set(
			surface.id,
			surface.dataModel.subscribe( () => this.notify() )
		);
		this.notify();
	}

	private requireSurface(
		surfaceId: string | undefined,
		kind: string
	): Surface {
		if ( ! surfaceId ) {
			throw new A2UIProtocolError(
				`'${ kind }' requires a 'surfaceId'.`,
				undefined,
				`/${ kind }/surfaceId`
			);
		}
		const surface = this.surfaces.get( surfaceId );
		if ( ! surface ) {
			throw new A2UIProtocolError(
				`Surface '${ surfaceId }' does not exist. Send 'createSurface' first.`,
				surfaceId
			);
		}
		return surface;
	}

	private updateComponents( payload: UpdateComponentsPayload ) {
		const surface = this.requireSurface(
			payload?.surfaceId,
			'updateComponents'
		);
		surface.applyComponents( payload.components );
		this.notify();
	}

	private updateDataModel( payload: UpdateDataModelPayload ) {
		const surface = this.requireSurface(
			payload?.surfaceId,
			'updateDataModel'
		);
		// DataModel.set notifies the processor through its subscription.
		surface.dataModel.set( payload.path ?? '/', payload.value );
	}

	private deleteSurface( payload: DeleteSurfacePayload ) {
		if ( ! payload?.surfaceId ) {
			throw new A2UIProtocolError(
				"'deleteSurface' requires a 'surfaceId'.",
				undefined,
				'/deleteSurface/surfaceId'
			);
		}
		if ( this.surfaces.delete( payload.surfaceId ) ) {
			this.dataModelUnsubscribers.get( payload.surfaceId )?.();
			this.dataModelUnsubscribers.delete( payload.surfaceId );
			this.notify();
		}
	}

	// -- Rendering helpers ----------------------------------------------------

	getSurface( surfaceId: string ): Surface | undefined {
		return this.surfaces.get( surfaceId );
	}

	/**
	 * Builds a resolution scope for a component rendered inside `surface`.
	 * @param surface   Surface the component belongs to.
	 * @param scopePath Absolute pointer that relative bindings resolve against.
	 */
	createScope( surface: Surface, scopePath?: string ): ResolveScope {
		return {
			dataModel: surface.dataModel,
			functions: this.functions,
			scopePath,
			locale: this.locale,
		};
	}

	/**
	 * Writes user input into a surface's data model (two-way binding).
	 * @param surfaceId Surface id.
	 * @param path      JSON Pointer.
	 * @param value     New value, or `undefined` to remove the key.
	 */
	setValue(
		surfaceId: string,
		path: string,
		value: JsonValue | undefined
	): void {
		this.requireSurface( surfaceId, 'setValue' ).dataModel.set(
			path,
			value
		);
	}

	/**
	 * Runs a component's `action`: a server event becomes an `action`
	 * message; a `functionCall` runs locally.
	 * @param surfaceId         Surface id.
	 * @param sourceComponentId Id of the component that triggered the action.
	 * @param action            The component's `action`.
	 * @param scopePath         Absolute pointer that relative bindings resolve against.
	 */
	dispatchAction(
		surfaceId: string,
		sourceComponentId: ComponentId,
		action: Action,
		scopePath?: string
	): void {
		const surface = this.requireSurface( surfaceId, 'dispatchAction' );
		const scope = this.createScope( surface, scopePath );

		if ( 'functionCall' in action ) {
			resolveDynamicValue( action.functionCall, scope );
			return;
		}

		const context: JsonObject = {};
		for ( const [ key, raw ] of Object.entries(
			action.event.context ?? {}
		) ) {
			const resolved = resolveDynamicValue( raw, scope );
			context[ key ] =
				resolved === undefined ? null : ( resolved as JsonValue );
		}
		const message: ActionMessage = {
			version: surface.version,
			action: {
				name: action.event.name,
				surfaceId,
				sourceComponentId,
				timestamp: new Date().toISOString(),
				context,
			},
		};
		for ( const listener of this.actionListeners ) {
			listener( message, surface );
		}
		this.emitClientMessage( message );
	}

	/**
	 * Reports a client-side error to the agent.
	 * @param error   Error payload.
	 * @param version Protocol version to tag the message with.
	 */
	reportError(
		error: ErrorMessage[ 'error' ],
		version = DEFAULT_PROTOCOL_VERSION
	): void {
		this.emitClientMessage( { version, error } );
	}

	// -- Capabilities & data model exchange -----------------------------------

	getClientCapabilities(
		version = DEFAULT_PROTOCOL_VERSION
	): ClientCapabilities {
		return {
			[ version ]: {
				supportedCatalogIds: [ ...this.supportedCatalogIds ],
			},
		};
	}

	/**
	 * Data models of every surface created with `sendDataModel: true`.
	 * @param version Protocol version to tag the message with.
	 */
	getClientDataModel(
		version = DEFAULT_PROTOCOL_VERSION
	): ClientDataModel | undefined {
		const surfaces: Record< string, JsonValue > = {};
		for ( const surface of this.surfaces.values() ) {
			if ( surface.sendDataModel ) {
				surfaces[ surface.id ] = surface.dataModel.snapshot();
			}
		}
		return Object.keys( surfaces ).length
			? { version, surfaces }
			: undefined;
	}
}
