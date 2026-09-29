/**
 * JSON Schema validation behind a swappable engine. The default is Ajv
 * (./ajv.ts), which generates code at runtime; hosts that forbid that (the
 * EmDash sandbox, a Cloudflare Worker) install another engine with
 * setSchemaEngine() before validating anything (see ./schema-cfworker.ts).
 *
 * Validators are compiled lazily and cached per schema object, so importing
 * the core never compiles a schema.
 */

/** A validation error, in Ajv's shape (other engines map to it). */
export interface SchemaError {
	keyword: string;
	/** JSON pointer of the value the error is about. */
	instancePath: string;
	schemaPath: string;
	params: Record<string, unknown>;
	message?: string;
}

export interface Validator {
	(data: unknown): boolean;
	errors?: SchemaError[] | null;
}

/** A validator that narrows what it accepts. */
export interface TypedValidator<T> {
	(data: unknown): data is T;
	errors?: SchemaError[] | null;
}

export interface SchemaEngine {
	/** Compiles a schema; throws when the schema itself is invalid. */
	compile(schema: object | boolean): Validator;
}

let engine: SchemaEngine | undefined;
let defaultEngine: (() => SchemaEngine) | undefined;
let cache = new WeakMap<object, Validator>();

/** Registers the engine used when none is set (the core registers Ajv). */
export function setDefaultSchemaEngine(factory: () => SchemaEngine): void {
	defaultEngine = factory;
}

/** Replaces the engine; cached validators are dropped. */
export function setSchemaEngine(next: SchemaEngine): void {
	engine = next;
	cache = new WeakMap();
}

function current(): SchemaEngine {
	if (!engine) {
		if (!defaultEngine) {
			throw new Error('No JSON Schema engine: call setSchemaEngine().');
		}
		engine = defaultEngine();
	}
	return engine;
}

/** A validator for a schema, compiled on first use. */
export function compileSchema(schema: object | boolean): Validator {
	if (typeof schema === 'boolean') {
		return current().compile(schema);
	}
	let validate = cache.get(schema);
	if (!validate) {
		validate = current().compile(schema);
		cache.set(schema, validate);
	}
	return validate;
}

/** A validator compiled the first time it is called. */
export function lazyValidator<T = unknown>(schema: object): TypedValidator<T> {
	const validate = ((data: unknown) => {
		const inner = compileSchema(schema);
		const ok = inner(data);
		validate.errors = inner.errors ?? null;
		return ok;
	}) as TypedValidator<T>;
	return validate;
}
