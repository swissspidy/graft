import { createContext, useContext } from '@wordpress/element';
import type { ComponentType } from '@wordpress/element';
import type { A2UIProcessor } from '../core/processor';
import type { Surface } from '../core/surface';

/** Props every catalog component receives. */
export interface A2UIComponentProps< P = Record< string, unknown > > {
	/** The component id within its surface. */
	id: string;
	/** The wire properties minus `id` and `component`. Values may be dynamic. */
	props: P;
}

export type ComponentCatalog = Record<
	string,
	ComponentType< A2UIComponentProps< any > >
>;

export const ProcessorContext = createContext< A2UIProcessor | null >( null );
export const SurfaceContext = createContext< Surface | null >( null );
/** Absolute data-model pointer that relative bindings resolve against. */
export const ScopeContext = createContext< string | undefined >( undefined );
export const CatalogContext = createContext< ComponentCatalog >( {} );

export function useProcessor(): A2UIProcessor {
	const processor = useContext( ProcessorContext );
	if ( ! processor ) {
		throw new Error(
			'A2UI components must be rendered inside <A2UISurface>.'
		);
	}
	return processor;
}

export function useSurface(): Surface {
	const surface = useContext( SurfaceContext );
	if ( ! surface ) {
		throw new Error(
			'A2UI components must be rendered inside <A2UISurface>.'
		);
	}
	return surface;
}

export function useScopePath(): string | undefined {
	return useContext( ScopeContext );
}

export function useCatalog(): ComponentCatalog {
	return useContext( CatalogContext );
}
