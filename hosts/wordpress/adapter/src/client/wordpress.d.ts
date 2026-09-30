// Minimal types for the WordPress globals the client uses. The packages
// themselves are not installed: the bundle maps them to window.wp.*.

declare module '@wordpress/components' {
	import type { ComponentType, ReactNode } from 'react';
	export const Button: ComponentType<{
		variant?: 'primary' | 'secondary' | 'tertiary' | 'link';
		isBusy?: boolean;
		disabled?: boolean;
		accessibleWhenDisabled?: boolean;
		isDestructive?: boolean;
		size?: 'default' | 'compact' | 'small';
		onClick?: () => void;
		children?: ReactNode;
		[data: `data-${string}`]: string | undefined;
	}>;
	export const Notice: ComponentType<{
		status?: 'info' | 'success' | 'warning' | 'error';
		isDismissible?: boolean;
		onRemove?: () => void;
		children?: ReactNode;
	}>;
	export const Card: ComponentType<{ children?: ReactNode }>;
	export const CardHeader: ComponentType<{ children?: ReactNode }>;
	export const CardBody: ComponentType<{ children?: ReactNode }>;
	export const Spinner: ComponentType<Record<string, never>>;
	interface ControlProps {
		label?: string;
		help?: string;
		__nextHasNoMarginBottom?: boolean;
		__next40pxDefaultSize?: boolean;
		[data: `data-${string}`]: string | undefined;
	}
	export const TextControl: ComponentType<ControlProps & { value: string; placeholder?: string; onChange(value: string): void }>;
	export const TextareaControl: ComponentType<ControlProps & { value: string; rows?: number; onChange(value: string): void }>;
	export const CheckboxControl: ComponentType<ControlProps & { checked: boolean; onChange(checked: boolean): void }>;
	export const SelectControl: ComponentType<ControlProps & { value: string; options: Array<{ value: string; label: string }>; onChange(value: string): void }>;
}

declare module '@wordpress/api-fetch' {
	export default function apiFetch<T = unknown>(options: { path: string; method?: string; data?: unknown }): Promise<T>;
}

// PHP files imported as text (esbuild's text loader), e.g. the sandbox endpoint.
declare module '*.php' {
	const content: string;
	export default content;
}
