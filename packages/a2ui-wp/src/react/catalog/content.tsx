import type { CSSProperties } from 'react';
import {
	__experimentalHeading as Heading,
	__experimentalText as WPText,
	Icon as WPIcon,
} from '@wordpress/components';
import type { DynamicString } from '../../core/types';
import type { A2UIComponentProps } from '../context';
import { useAccessibility, useDynamicString, useDynamicValue } from '../hooks';
import { getWordPressIcon } from './icons';

export interface TextProps {
	text: DynamicString;
	variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';
}

const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5 } as const;

export function Text( { props }: A2UIComponentProps< TextProps > ) {
	const text = useDynamicString( props.text );
	const variant = props.variant ?? 'body';

	if ( variant in HEADING_LEVELS ) {
		return (
			<Heading
				className="a2ui-wp-text"
				level={
					HEADING_LEVELS[ variant as keyof typeof HEADING_LEVELS ]
				}
			>
				{ text }
			</Heading>
		);
	}
	if ( variant === 'caption' ) {
		return (
			<WPText
				className="a2ui-wp-text is-caption"
				variant="muted"
				size="small"
				style={ { whiteSpace: 'pre-wrap' } }
			>
				{ text }
			</WPText>
		);
	}
	return (
		<WPText
			className="a2ui-wp-text"
			// Inherit rather than the component's own dark default, so text
			// inside a primary Button takes the button's color.
			color="inherit"
			style={ { whiteSpace: 'pre-wrap' } }
		>
			{ text }
		</WPText>
	);
}

export interface ImageProps {
	url: DynamicString;
	description?: DynamicString;
	fit?: 'contain' | 'cover' | 'fill' | 'none' | 'scaleDown';
	variant?:
		| 'icon'
		| 'avatar'
		| 'smallFeature'
		| 'mediumFeature'
		| 'largeFeature'
		| 'header';
	accessibility?: { label?: DynamicString; description?: DynamicString };
}

const IMAGE_VARIANTS: Record<
	NonNullable< ImageProps[ 'variant' ] >,
	CSSProperties
> = {
	icon: { width: 24, height: 24 },
	avatar: { width: 48, height: 48, borderRadius: '50%' },
	smallFeature: { width: 120, height: 120, borderRadius: 4 },
	mediumFeature: {
		width: '100%',
		maxWidth: 320,
		height: 'auto',
		borderRadius: 4,
	},
	largeFeature: {
		width: '100%',
		maxWidth: 640,
		height: 'auto',
		borderRadius: 4,
	},
	header: { width: '100%', height: 'auto' },
};

export function Image( { props }: A2UIComponentProps< ImageProps > ) {
	const url = useDynamicString( props.url );
	const description = useDynamicString( props.description ?? '' );
	const a11y = useAccessibility( props.accessibility );
	const fit =
		props.fit === 'scaleDown' ? 'scale-down' : ( props.fit ?? 'fill' );
	return (
		<img
			className={ `a2ui-wp-image is-${ props.variant ?? 'mediumFeature' }` }
			src={ url }
			alt={ a11y.label ?? description }
			style={ {
				objectFit: fit,
				display: 'block',
				...IMAGE_VARIANTS[ props.variant ?? 'mediumFeature' ],
			} }
		/>
	);
}

export interface IconProps {
	name: DynamicString | { svgPath: string };
	accessibility?: { label?: DynamicString; description?: DynamicString };
}

export function Icon( { props }: A2UIComponentProps< IconProps > ) {
	const resolved = useDynamicValue( props.name );
	const a11y = useAccessibility( props.accessibility );

	if (
		resolved &&
		typeof resolved === 'object' &&
		typeof ( resolved as { svgPath?: unknown } ).svgPath === 'string'
	) {
		const icon = (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				width="24"
				height="24"
				aria-hidden="true"
			>
				<path
					d={ ( resolved as { svgPath: string } ).svgPath }
					fill="currentColor"
				/>
			</svg>
		);
		return <WPIcon className="a2ui-wp-icon" icon={ icon } />;
	}

	const name = typeof resolved === 'string' ? resolved : '';
	const icon = getWordPressIcon( name );
	if ( ! icon ) {
		return (
			<span
				className="a2ui-wp-icon is-unknown"
				role="img"
				aria-label={ a11y.label ?? name }
			/>
		);
	}
	return (
		<span
			className="a2ui-wp-icon"
			role="img"
			aria-label={ a11y.label ?? name }
			title={ a11y.description }
		>
			<WPIcon icon={ icon } />
		</span>
	);
}

export interface VideoProps {
	url: DynamicString;
}

export function Video( { props }: A2UIComponentProps< VideoProps > ) {
	const url = useDynamicString( props.url );
	return (
		<video
			className="a2ui-wp-video"
			src={ url }
			controls
			style={ { maxWidth: '100%' } }
		/>
	);
}

export interface AudioPlayerProps {
	url: DynamicString;
	description?: DynamicString;
}

export function AudioPlayer( {
	props,
}: A2UIComponentProps< AudioPlayerProps > ) {
	const url = useDynamicString( props.url );
	const description = useDynamicString( props.description ?? '' );
	return (
		<div className="a2ui-wp-audio">
			{ description ? <WPText as="p">{ description }</WPText> : null }
			<audio
				src={ url }
				controls
				style={ { width: '100%' } }
				aria-label={ description || undefined }
			/>
		</div>
	);
}
