/**
 * Type definitions for the A2UI v0.9.x protocol.
 *
 * These mirror the JSON Schemas published at
 * https://a2ui.org/specification/v0_9/ (common_types.json,
 * server_to_client.json, client_to_server.json) and the basic catalog.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	JsonPrimitive | JsonValue[] | { [ key: string ]: JsonValue };
export type JsonObject = { [ key: string ]: JsonValue };

/** A reference to a value in the surface data model (RFC 6901 JSON Pointer). */
export interface DataBinding {
	path: string;
}

export type FunctionReturnType =
	'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | 'void';

/** Invokes a named client-side function from the surface's catalog. */
export interface FunctionCall {
	call: string;
	args?: Record< string, DynamicValue | JsonObject >;
	returnType?: FunctionReturnType;
}

/** A literal, a data binding, or a function call. */
export type DynamicValue =
	| string
	| number
	| boolean
	| null
	| DynamicValue[]
	| DataBinding
	| FunctionCall;

export type DynamicString = string | DataBinding | FunctionCall;
export type DynamicNumber = number | DataBinding | FunctionCall;
export type DynamicBoolean = boolean | DataBinding | FunctionCall;
export type DynamicStringList = string[] | DataBinding | FunctionCall;

export type ComponentId = string;

/** Static list of child ids, or a template expanded over a list in the data model. */
export type ChildList =
	| ComponentId[]
	| {
			componentId: ComponentId;
			path: string;
	  };

export interface CheckRule {
	condition: DynamicBoolean;
	message: string;
}

export interface AccessibilityAttributes {
	label?: DynamicString;
	description?: DynamicString;
}

export interface ServerEventAction {
	event: {
		name: string;
		context?: Record< string, DynamicValue >;
	};
}

export interface LocalFunctionAction {
	functionCall: FunctionCall;
}

export type Action = ServerEventAction | LocalFunctionAction;

/**
 * A component as sent on the wire: `id`, the discriminating `component`
 * type name, and the type-specific properties.
 */
export interface ComponentDefinition {
	id: ComponentId;
	component: string;
	accessibility?: AccessibilityAttributes;
	checks?: CheckRule[];
	[ property: string ]: unknown;
}

export type Theme = Record< string, JsonValue >;

// ---------------------------------------------------------------------------
// Server → client messages
// ---------------------------------------------------------------------------

export interface CreateSurfacePayload {
	surfaceId: string;
	catalogId: string;
	theme?: Theme;
	sendDataModel?: boolean;
}

export interface UpdateComponentsPayload {
	surfaceId: string;
	components: ComponentDefinition[];
}

export interface UpdateDataModelPayload {
	surfaceId: string;
	/** JSON Pointer. Omitted or `/` means the whole data model. */
	path?: string;
	/** Omitted means "remove the key at `path`". */
	value?: JsonValue;
}

export interface DeleteSurfacePayload {
	surfaceId: string;
}

export interface CreateSurfaceMessage {
	version?: string;
	createSurface: CreateSurfacePayload;
}
export interface UpdateComponentsMessage {
	version?: string;
	updateComponents: UpdateComponentsPayload;
}
export interface UpdateDataModelMessage {
	version?: string;
	updateDataModel: UpdateDataModelPayload;
}
export interface DeleteSurfaceMessage {
	version?: string;
	deleteSurface: DeleteSurfacePayload;
}

export type ServerMessage =
	| CreateSurfaceMessage
	| UpdateComponentsMessage
	| UpdateDataModelMessage
	| DeleteSurfaceMessage;

// ---------------------------------------------------------------------------
// Client → server messages
// ---------------------------------------------------------------------------

export interface ActionPayload {
	name: string;
	surfaceId: string;
	sourceComponentId: ComponentId;
	/** ISO 8601 timestamp. */
	timestamp: string;
	context: JsonObject;
}

export interface ActionMessage {
	version: string;
	action: ActionPayload;
}

export interface ErrorPayload {
	code: string;
	surfaceId: string;
	message: string;
	/** JSON Pointer to the failing field, for `VALIDATION_FAILED`. */
	path?: string;
}

export interface ErrorMessage {
	version: string;
	error: ErrorPayload;
}

export type ClientMessage = ActionMessage | ErrorMessage;

/** Capabilities advertised to the agent, keyed by protocol version. */
export interface ClientCapabilities {
	[ version: string ]: {
		supportedCatalogIds: string[];
		inlineCatalogs?: JsonObject[];
	};
}

/** Data model snapshot sent alongside actions when `sendDataModel` is set. */
export interface ClientDataModel {
	version: string;
	surfaces: Record< string, JsonValue >;
}
