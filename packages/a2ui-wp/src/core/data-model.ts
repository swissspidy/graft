/**
 * The per-surface, client-side data model.
 *
 * A plain JSON tree addressed with JSON Pointers plus a change notification
 * so UI layers can re-render. Subscribers receive the pointer that changed;
 * `/` means the whole model was replaced.
 */

import { getAtPointer, setAtPointer } from './json-pointer';
import type { JsonValue } from './types';

export type DataModelListener = ( path: string ) => void;

export class DataModel {
	private data: unknown;
	private listeners = new Set< DataModelListener >();

	constructor( initial: JsonValue = {} ) {
		this.data = initial;
	}

	get( path = '/' ): unknown {
		return getAtPointer( this.data, path );
	}

	/**
	 * Replaces (or, with `undefined`, removes) the value at `path`.
	 * @param path  JSON Pointer.
	 * @param value New value, or `undefined` to remove the key.
	 */
	set( path: string, value: JsonValue | undefined ): void {
		const normalized = path === '' ? '/' : path;
		if ( normalized === '/' ) {
			this.data = value === undefined ? {} : value;
		} else {
			this.data = setAtPointer( this.data, normalized, value );
		}
		for ( const listener of this.listeners ) {
			listener( normalized );
		}
	}

	/** A deep-cloned snapshot suitable for sending to the agent. */
	snapshot(): JsonValue {
		return JSON.parse( JSON.stringify( this.data ?? null ) );
	}

	subscribe( listener: DataModelListener ): () => void {
		this.listeners.add( listener );
		return () => {
			this.listeners.delete( listener );
		};
	}
}
