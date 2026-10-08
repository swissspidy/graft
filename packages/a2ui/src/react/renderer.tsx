import { useEffect, useMemo, useSyncExternalStore } from '@wordpress/element';
import type { CSSProperties, ReactNode } from 'react';
import { __experimentalVStack as VStack } from '@wordpress/components';
import type { A2UIProcessor, ActionListener } from '../core/processor';
import { ROOT_COMPONENT_ID } from '../core/surface';
import { wordPressCatalog } from './catalog';
import {
	CatalogContext,
	ProcessorContext,
	SurfaceContext,
	type ComponentCatalog,
} from './context';
import { A2UINode } from './node';

function useProcessorVersion( processor: A2UIProcessor ) {
	return useSyncExternalStore(
		( listener ) => processor.subscribe( listener ),
		() => processor.getVersion(),
		() => processor.getVersion()
	);
}

/**
 * Maps A2UI theme parameters onto the WordPress admin theme variables.
 * @param theme Theme parameters from `createSurface`.
 */
function themeStyle(
	theme: Record< string, unknown >
): CSSProperties | undefined {
	const primary =
		typeof theme.primaryColor === 'string' ? theme.primaryColor : undefined;
	if ( ! primary ) {
		return undefined;
	}
	return {
		'--wp-admin-theme-color': primary,
		'--wp-admin-theme-color--rgb': hexToRgb( primary ),
		'--wp-admin-theme-color-darker-10': primary,
		'--wp-admin-theme-color-darker-20': primary,
		'--wp-components-color-accent': primary,
		'--wp-components-color-accent-darker-10': primary,
		'--wp-components-color-accent-darker-20': primary,
	} as CSSProperties;
}

function hexToRgb( hex: string ): string | undefined {
	const match = /^#?([0-9a-f]{6})$/i.exec( hex.trim() );
	if ( ! match ) {
		return undefined;
	}
	const hexValue = match[ 1 ];
	const channel = ( offset: number ) =>
		parseInt( hexValue.slice( offset, offset + 2 ), 16 );
	return `${ channel( 0 ) }, ${ channel( 2 ) }, ${ channel( 4 ) }`;
}

export interface A2UISurfaceProps {
	processor: A2UIProcessor;
	surfaceId: string;
	/** Component catalog. Defaults to the WordPress components catalog. */
	catalog?: ComponentCatalog;
	/** Rendered while the surface has no `root` component yet. */
	placeholder?: ReactNode;
	className?: string;
}

/**
 * Renders a single surface.
 *
 * @param props Component props.
 */
export function A2UISurface( props: A2UISurfaceProps ) {
	const {
		processor,
		surfaceId,
		catalog = wordPressCatalog,
		placeholder = null,
		className,
	} = props;
	useProcessorVersion( processor );
	const surface = processor.getSurface( surfaceId );
	const style = useMemo(
		() => ( surface ? themeStyle( surface.theme ) : undefined ),
		[ surface ]
	);

	if ( ! surface || ! surface.root ) {
		return <>{ placeholder }</>;
	}

	return (
		<ProcessorContext.Provider value={ processor }>
			<SurfaceContext.Provider value={ surface }>
				<CatalogContext.Provider value={ catalog }>
					<div
						className={ [ 'a2ui-wp-surface', className ]
							.filter( Boolean )
							.join( ' ' ) }
						data-surface-id={ surfaceId }
						style={ style }
					>
						<A2UINode id={ ROOT_COMPONENT_ID } />
					</div>
				</CatalogContext.Provider>
			</SurfaceContext.Provider>
		</ProcessorContext.Provider>
	);
}

export interface A2UIRendererProps {
	processor: A2UIProcessor;
	catalog?: ComponentCatalog;
	/** Called with every `action` message the user triggers. */
	onAction?: ActionListener;
	/** Rendered when there are no surfaces. */
	emptyState?: ReactNode;
}

/**
 * Renders every surface the processor knows about, stacked vertically.
 *
 * @param props Component props.
 */
export function A2UIRenderer( props: A2UIRendererProps ) {
	const { processor, catalog, onAction, emptyState = null } = props;
	useProcessorVersion( processor );

	useEffect( () => {
		if ( ! onAction ) {
			return undefined;
		}
		return processor.onAction( onAction );
	}, [ processor, onAction ] );

	const surfaceIds = Array.from( processor.surfaces.keys() );
	if ( surfaceIds.length === 0 ) {
		return <>{ emptyState }</>;
	}

	return (
		<VStack spacing={ 4 } className="a2ui-wp-surfaces">
			{ surfaceIds.map( ( surfaceId ) => (
				<A2UISurface
					key={ surfaceId }
					processor={ processor }
					surfaceId={ surfaceId }
					catalog={ catalog }
				/>
			) ) }
		</VStack>
	);
}
