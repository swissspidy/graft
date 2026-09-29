import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { setDefaultSchemaEngine, type SchemaEngine, type SchemaError } from './schema.ts';

// ajv-formats is CommonJS; under NodeNext its default import is the module object.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

/**
 * Ajv configured the way every Graft contract and embedded schema is
 * checked: draft 2020-12, unknown keywords rejected, formats validated.
 */
export function createAjv(): Ajv2020 {
	const ajv = new Ajv2020({
		allErrors: true,
		strict: true,
		strictRequired: false,
		allowUnionTypes: true,
	});
	addFormats(ajv);
	return ajv;
}

/** The default engine: Ajv, created on first use. */
export function ajvEngine(): SchemaEngine {
	const ajv = createAjv();
	return {
		compile(schema) {
			const validate = ajv.compile(schema);
			const wrapped = (data: unknown) => {
				const ok = validate(data) as boolean;
				wrapped.errors = (validate.errors as SchemaError[] | null | undefined) ?? null;
				return ok;
			};
			wrapped.errors = null as SchemaError[] | null;
			return wrapped;
		},
	};
}

setDefaultSchemaEngine(ajvEngine);
