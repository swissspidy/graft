/** Thrown when a server message is malformed or violates protocol state rules. */
export class A2UIProtocolError extends Error {
	constructor(
		message: string,
		public readonly surfaceId?: string,
		public readonly path?: string
	) {
		super( message );
		this.name = 'A2UIProtocolError';
	}
}
