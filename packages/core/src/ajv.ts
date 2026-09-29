import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

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
