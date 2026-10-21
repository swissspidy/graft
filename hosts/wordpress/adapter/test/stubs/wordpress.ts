// Test stand-ins for WordPress globals the client bundle maps to window.wp.*.
import { createElement, type ReactNode } from 'react';

export default function apiFetch(): Promise<never> {
	return Promise.reject(new Error('apiFetch is not available in tests'));
}
const stub = () => null;
/** Draws its children in a plain element, so tests can find and use them. */
const element =
	(tag: string) =>
	({ children, onClick, disabled, ...props }: { children?: ReactNode; onClick?: () => void; disabled?: boolean; [prop: string]: unknown }) =>
		createElement(tag, { onClick, disabled, ...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('data-') || key.startsWith('aria-'))) }, children);
export const Button = element('button');
export const Notice = stub;
export const Card = element('div');
export const CardHeader = element('div');
export const CardBody = element('div');
export const Spinner = stub;
export const __experimentalVStack = element('div');
export const __experimentalHStack = element('div');
export const __experimentalHeading = element('h3');
export const __experimentalText = element('span');
export const __experimentalDivider = element('hr');
