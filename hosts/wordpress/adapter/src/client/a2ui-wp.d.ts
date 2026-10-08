// The part of @swissspidy/a2ui-wp the client uses. 0.1.0 was published
// without its build (dist/), so the bundle compiles its src/ (see
// scripts/build-client.ts) and these declarations stand in for its types.
// Drop this file once a release ships dist/.

declare module '@swissspidy/a2ui-wp' {
	import type { ComponentType } from 'react';
	import type { Catalog, ComponentApi, DataContext, SurfaceModel } from '@a2ui/web_core/v0_9';

	export type Surface = SurfaceModel<ComponentApi>;
	export interface ActionMessage {
		version: string;
		action: { name: string; surfaceId: string; sourceComponentId: string; context?: Record<string, unknown> };
	}

	export class A2UIProcessor {
		constructor(options?: { locale?: string; catalogs?: Catalog<ComponentApi>[] });
		processMessage(message: unknown): void;
		processMessages(messages: unknown[]): void;
		getSurface(surfaceId: string): Surface | undefined;
		createScope(surface: Surface, scopePath?: string): DataContext;
		dispatchAction(surfaceId: string, sourceComponentId: string, action: never, scopePath?: string): void;
	}

	export interface A2UIComponentProps<P = Record<string, unknown>> {
		id: string;
		props: P;
	}
	// Components take their own props; a catalog holds any.
	export type ComponentCatalog = Record<string, ComponentType<A2UIComponentProps<any>>>;

	export const A2UIRenderer: ComponentType<{ processor: A2UIProcessor; catalog?: ComponentCatalog; onAction?(message: ActionMessage): void | Promise<void> }>;
	export const wordPressCatalog: ComponentCatalog;
	export function createCatalog(overrides: ComponentCatalog): ComponentCatalog;
	export function useDynamicBoolean(value: unknown): boolean;
	export function useDynamicString(value: unknown): string;
	export function useBoundValue<T>(value: unknown, coerce: (resolved: unknown) => T): [T, (next: T) => void];
	export function useProcessor(): A2UIProcessor;
	export function useSurface(): Surface;
	export function useScopePath(): string | undefined;
}
