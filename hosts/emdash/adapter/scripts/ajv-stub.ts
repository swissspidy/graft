// Stands in for Ajv in the sandboxed bundle, which validates with the
// cfworker engine; nothing may construct it.
export class Ajv2020 {
	constructor() {
		throw new Error('Ajv is not available in the EmDash plugin sandbox.');
	}
}
export default function addFormats(): void {}
