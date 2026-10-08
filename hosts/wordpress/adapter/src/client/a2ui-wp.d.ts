// The part of a2ui-wp the client uses (bundled from packages/a2ui-wp until it
// is published; scripts/build-client.ts aliases "a2ui-wp"). Declared here so
// the adapter does not type-check its sources (that package checks itself).

declare module 'a2ui-wp' {
	import type { ComponentType } from 'react';

	export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
	export type FunctionRegistry = Record<string, (args: Record<string, unknown>, context: { resolve(value: unknown): unknown; locale?: string }) => unknown>;

	export interface DataModel {
		get(path?: string): unknown;
		set(path: string, value: JsonValue | undefined): void;
		subscribe(listener: (path: string) => void): () => void;
	}
	export interface Surface {
		readonly id: string;
		readonly dataModel: DataModel;
	}
	export interface ResolveScope {
		dataModel: DataModel;
		functions: FunctionRegistry;
		scopePath?: string;
		locale?: string;
	}
	export interface ActionMessage {
		action: { name: string; surfaceId: string; sourceComponentId: string; context?: Record<string, unknown> };
	}
	export type A2UIMessage = Record<string, unknown> & { version?: string };

	export class A2UIProcessor {
		constructor(options: { supportedCatalogIds?: string[]; locale?: string; functions?: FunctionRegistry });
		readonly functions: FunctionRegistry;
		processMessage(message: A2UIMessage): void;
		processMessages(messages: A2UIMessage[]): void;
		getSurface(surfaceId: string): Surface | undefined;
		createScope(surface: Surface, scopePath?: string): ResolveScope;
		dispatchAction(surfaceId: string, componentId: string, action: unknown, scopePath?: string): void;
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
	export function joinPointer(base: string | undefined, path: string): string;
	export function resolveDynamicValue(value: unknown, scope: ResolveScope): unknown;
	export function resolveBoolean(value: unknown, scope: ResolveScope): boolean;
	export function useDynamicBoolean(value: unknown): boolean;
	export function useDynamicString(value: unknown): string;
	export function useProcessor(): A2UIProcessor;
	export function useSurface(): Surface;
	export function useScopePath(): string | undefined;
}
