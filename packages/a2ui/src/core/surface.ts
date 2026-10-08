import { DataModel } from './data-model';
import { A2UIProtocolError } from './errors';
import type { ComponentDefinition, ComponentId, Theme } from './types';

export const ROOT_COMPONENT_ID = 'root';

/**
 * One UI surface: its flat component buffer (keyed by id) and its data model.
 * The tree is reconstructed at render time by following id references from
 * the component with id `root`.
 */
export class Surface {
	readonly components = new Map< ComponentId, ComponentDefinition >();
	readonly dataModel = new DataModel();

	constructor(
		readonly id: string,
		readonly catalogId: string,
		readonly theme: Theme,
		readonly sendDataModel: boolean,
		/** Protocol version the surface was created with; echoed on actions. */
		readonly version: string
	) {}

	get root(): ComponentDefinition | undefined {
		return this.components.get( ROOT_COMPONENT_ID );
	}

	getComponent( id: ComponentId ): ComponentDefinition | undefined {
		return this.components.get( id );
	}

	/**
	 * Upserts components. Validates every entry before mutating anything.
	 * @param definitions Components as sent on the wire.
	 */
	applyComponents( definitions: ComponentDefinition[] ): void {
		if ( ! Array.isArray( definitions ) ) {
			throw new A2UIProtocolError(
				"'components' must be an array.",
				this.id,
				'/updateComponents/components'
			);
		}
		definitions.forEach( ( definition, index ) => {
			if ( ! definition || typeof definition !== 'object' ) {
				throw new A2UIProtocolError(
					`Component at index ${ index } is not an object.`,
					this.id,
					`/updateComponents/components/${ index }`
				);
			}
			if ( typeof definition.id !== 'string' || definition.id === '' ) {
				throw new A2UIProtocolError(
					`Component at index ${ index } is missing an 'id'.`,
					this.id,
					`/updateComponents/components/${ index }/id`
				);
			}
			const existing = this.components.get( definition.id );
			if ( typeof definition.component !== 'string' && ! existing ) {
				throw new A2UIProtocolError(
					`Component '${ definition.id }' is missing a 'component' type.`,
					this.id,
					`/updateComponents/components/${ index }/component`
				);
			}
		} );
		for ( const definition of definitions ) {
			const existing = this.components.get( definition.id );
			const component =
				typeof definition.component === 'string'
					? definition.component
					: existing!.component;
			this.components.set( definition.id, { ...definition, component } );
		}
	}
}
