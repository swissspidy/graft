import { useCallback, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import type {
	JsonValue,
	AccessibilityAttributes,
	Action,
	CheckRule,
} from '../core/types';
import {
	isDataBinding,
	resolveBoolean,
	resolveDynamicValue,
	resolveNumber,
	resolvePath,
	resolveString,
	resolveStringList,
	type ResolveScope,
} from '../core/resolver';
import { useProcessor, useScopePath, useSurface } from './context';

/** The resolution scope of the current component. */
export function useResolveScope(): ResolveScope {
	const processor = useProcessor();
	const surface = useSurface();
	const scopePath = useScopePath();
	return useMemo(
		() => processor.createScope( surface, scopePath ),
		[ processor, surface, scopePath ]
	);
}

export function useDynamicValue( value: unknown ): unknown {
	return resolveDynamicValue( value, useResolveScope() );
}

export function useDynamicString( value: unknown ): string {
	return resolveString( value, useResolveScope() );
}

export function useDynamicNumber( value: unknown, fallback = 0 ): number {
	return resolveNumber( value, useResolveScope(), fallback );
}

export function useDynamicBoolean( value: unknown ): boolean {
	return resolveBoolean( value, useResolveScope() );
}

export function useDynamicStringList( value: unknown ): string[] {
	return resolveStringList( value, useResolveScope() );
}

/**
 * Two-way binding for input components. When `value` is a data binding the
 * setter writes to the surface data model; otherwise it falls back to local
 * component state seeded from the (resolved) literal.
 * @param value  Value to resolve.
 * @param coerce Converts the resolved value to the type the input works with.
 */
export function useBoundValue< T extends JsonValue >(
	value: unknown,
	coerce: ( resolved: unknown ) => T
): [ T, ( next: T ) => void ] {
	const processor = useProcessor();
	const surface = useSurface();
	const scope = useResolveScope();
	const bound = isDataBinding( value );
	const absolutePath = bound ? resolvePath( value.path, scope ) : undefined;
	const [ local, setLocal ] = useState< T >( () =>
		coerce( resolveDynamicValue( value, scope ) )
	);

	const current = bound
		? coerce( surface.dataModel.get( absolutePath ) )
		: local;

	const setValue = useCallback(
		( next: T ) => {
			if ( absolutePath ) {
				processor.setValue( surface.id, absolutePath, next );
			} else {
				setLocal( next );
			}
		},
		[ processor, surface, absolutePath ]
	);

	return [ current, setValue ];
}

export interface CheckResult {
	valid: boolean;
	messages: string[];
}

/**
 * Evaluates a component's `checks`. Invalid checks count as failures.
 * @param checks The component's `checks`.
 * @param extra  Additional rules, for example one derived from `validationRegexp`.
 */
export function useChecks(
	checks: CheckRule[] | undefined,
	extra: CheckRule[] = []
): CheckResult {
	const scope = useResolveScope();
	const all = [ ...( Array.isArray( checks ) ? checks : [] ), ...extra ];
	const messages: string[] = [];
	for ( const rule of all ) {
		let passed = false;
		try {
			passed = resolveBoolean( rule.condition, scope );
		} catch ( error ) {
			passed = false;
			// eslint-disable-next-line no-console
			console.warn( '[a2ui-wp] check failed to evaluate:', error );
		}
		if ( ! passed ) {
			messages.push( rule.message ?? __( 'Invalid value.', 'a2ui-wp' ) );
		}
	}
	return { valid: messages.length === 0, messages };
}

/**
 * Returns a callback that dispatches the component's `action`.
 * @param action      The component's `action`.
 * @param componentId Id of the component that owns the action.
 */
export function useAction(
	action: Action | undefined,
	componentId: string
): () => void {
	const processor = useProcessor();
	const surface = useSurface();
	const scopePath = useScopePath();
	return useCallback( () => {
		if ( ! action ) {
			return;
		}
		try {
			processor.dispatchAction(
				surface.id,
				componentId,
				action,
				scopePath
			);
		} catch ( error ) {
			// eslint-disable-next-line no-console
			console.error( '[a2ui-wp] action failed:', error );
		}
	}, [ processor, surface, componentId, action, scopePath ] );
}

export function useAccessibility(
	attributes: AccessibilityAttributes | undefined
): { label?: string; description?: string } {
	const scope = useResolveScope();
	if ( ! attributes ) {
		return {};
	}
	return {
		label:
			attributes.label === undefined
				? undefined
				: resolveString( attributes.label, scope ),
		description:
			attributes.description === undefined
				? undefined
				: resolveString( attributes.description, scope ),
	};
}
