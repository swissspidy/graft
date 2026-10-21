// Stands in for Ajv in the extension's bundles, which validate with the
// cfworker engine (Manifest V3 forbids generated code); nothing may construct it.
export class Ajv2020 {
	constructor() {
		throw new Error('Ajv is not available in the extension.');
	}
}
export default function addFormats(): void {}
