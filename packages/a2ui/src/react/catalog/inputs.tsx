import { useState } from '@wordpress/element';
import {
	BaseControl,
	Button as WPButton,
	CheckboxControl,
	DatePicker,
	DateTimePicker,
	Dropdown,
	Modal as WPModal,
	RadioControl,
	RangeControl,
	SearchControl,
	TextControl,
	TextareaControl,
	TimePicker,
	__experimentalHStack as HStack,
	__experimentalText as WPText,
	__experimentalToggleGroupControl as ToggleGroupControl,
	__experimentalToggleGroupControlOption as ToggleGroupControlOption,
	__experimentalVStack as VStack,
} from '@wordpress/components';
import { calendar } from '@wordpress/icons';
import { __ } from '@wordpress/i18n';
import type {
	Action,
	CheckRule,
	DynamicBoolean,
	DynamicNumber,
	DynamicString,
	DynamicStringList,
} from '../../core/types';
import { coerceToString } from '../../core/functions';
import { resolveString } from '../../core/resolver';
import type { A2UIComponentProps } from '../context';
import {
	useAccessibility,
	useAction,
	useBoundValue,
	useChecks,
	useDynamicString,
	useResolveScope,
} from '../hooks';
import { A2UINode } from '../node';

interface Checkable {
	checks?: CheckRule[];
	accessibility?: { label?: DynamicString; description?: DynamicString };
}

const toStringValue = ( value: unknown ) => coerceToString( value );
const toBoolean = ( value: unknown ) => Boolean( value );
const toStringList = ( value: unknown ): string[] => {
	if ( Array.isArray( value ) ) {
		return value.map( String );
	}
	return typeof value === 'string' && value !== '' ? [ value ] : [];
};

function ErrorText( { messages }: { messages: string[] } ) {
	if ( messages.length === 0 ) {
		return null;
	}
	return (
		<WPText
			className="a2ui-wp-error"
			isDestructive
			size="small"
			as="p"
			style={ { margin: 0 } }
		>
			{ messages.join( ' ' ) }
		</WPText>
	);
}

// ---------------------------------------------------------------------------

export interface ButtonProps extends Checkable {
	child: string;
	variant?: 'default' | 'primary' | 'borderless';
	action: Action;
}

const BUTTON_VARIANTS = {
	default: 'secondary',
	primary: 'primary',
	borderless: 'tertiary',
} as const;

export function Button( { id, props }: A2UIComponentProps< ButtonProps > ) {
	const { valid, messages } = useChecks( props.checks );
	const fire = useAction( props.action, id );
	const a11y = useAccessibility( props.accessibility );
	const disabled = ! valid;
	return (
		<WPButton
			className="a2ui-wp-button"
			variant={ BUTTON_VARIANTS[ props.variant ?? 'default' ] }
			__next40pxDefaultSize
			disabled={ disabled }
			accessibleWhenDisabled
			label={ a11y.label }
			description={ disabled ? messages[ 0 ] : a11y.description }
			showTooltip={ Boolean( a11y.label ) }
			onClick={ fire }
			style={ { justifyContent: 'center' } }
		>
			{ props.child ? <A2UINode id={ props.child } /> : null }
		</WPButton>
	);
}

// ---------------------------------------------------------------------------

export interface TextFieldProps extends Checkable {
	label: DynamicString;
	value?: DynamicString;
	variant?: 'shortText' | 'longText' | 'number' | 'obscured';
	validationRegexp?: string;
}

const INPUT_TYPES = {
	shortText: 'text',
	longText: 'text',
	number: 'number',
	obscured: 'password',
} as const;

export function TextField( {
	id,
	props,
}: A2UIComponentProps< TextFieldProps > ) {
	const label = useDynamicString( props.label );
	const [ value, setValue ] = useBoundValue(
		props.value ?? '',
		toStringValue
	);
	const [ touched, setTouched ] = useState( false );
	const regexpRule: CheckRule[] = props.validationRegexp
		? [
				{
					condition: {
						call: 'regex',
						args: {
							value: props.value ?? '',
							pattern: props.validationRegexp,
						},
					},
					message: __( 'Invalid format.', 'a2ui-wp' ),
				},
			]
		: [];
	const { valid, messages } = useChecks( props.checks, regexpRule );
	const showError = touched && ! valid;
	const onChange = ( next: string ) => {
		setTouched( true );
		setValue( next );
	};
	const common = {
		className: `a2ui-wp-text-field${ showError ? ' is-invalid' : '' }`,
		label,
		value,
		onChange,
		__nextHasNoMarginBottom: true as const,
		help: showError ? <ErrorText messages={ messages } /> : undefined,
		id: `a2ui-${ id }`,
	};
	if ( props.variant === 'longText' ) {
		return <TextareaControl { ...common } rows={ 4 } />;
	}
	const type = INPUT_TYPES[ props.variant ?? 'shortText' ];
	return <TextControl { ...common } type={ type } __next40pxDefaultSize />;
}

// ---------------------------------------------------------------------------

export interface CheckBoxProps extends Checkable {
	label: DynamicString;
	value: DynamicBoolean;
}

export function CheckBox( { props }: A2UIComponentProps< CheckBoxProps > ) {
	const label = useDynamicString( props.label );
	const [ checked, setChecked ] = useBoundValue(
		props.value ?? false,
		toBoolean
	);
	const { valid, messages } = useChecks( props.checks );
	return (
		<CheckboxControl
			className="a2ui-wp-checkbox"
			label={ label }
			checked={ checked }
			onChange={ setChecked }
			__nextHasNoMarginBottom
			help={ ! valid ? <ErrorText messages={ messages } /> : undefined }
		/>
	);
}

// ---------------------------------------------------------------------------

export interface ChoicePickerProps extends Checkable {
	label?: DynamicString;
	variant?: 'mutuallyExclusive' | 'multipleSelection';
	options: Array< { label: DynamicString; value: string } >;
	value: DynamicStringList;
	displayStyle?: 'checkbox' | 'chips';
	filterable?: boolean;
}

export function ChoicePicker( {
	id,
	props,
}: A2UIComponentProps< ChoicePickerProps > ) {
	const scope = useResolveScope();
	const label = useDynamicString( props.label ?? '' );
	const [ selected, setSelected ] = useBoundValue(
		props.value ?? [],
		toStringList
	);
	const { valid, messages } = useChecks( props.checks );
	const [ filter, setFilter ] = useState( '' );

	const multiple = props.variant === 'multipleSelection';
	const chips = props.displayStyle === 'chips';
	const options = ( props.options ?? [] )
		.map( ( option ) => ( {
			value: String( option.value ),
			label: resolveString( option.label, scope ),
		} ) )
		.filter(
			( option ) =>
				! props.filterable ||
				! filter ||
				option.label.toLowerCase().includes( filter.toLowerCase() )
		);

	const toggle = ( value: string ) => {
		if ( multiple ) {
			setSelected(
				selected.includes( value )
					? selected.filter( ( v ) => v !== value )
					: [ ...selected, value ]
			);
		} else {
			setSelected( [ value ] );
		}
	};

	let control;
	if ( ! multiple && chips ) {
		control = (
			<ToggleGroupControl
				label={ label }
				hideLabelFromVision
				value={ selected[ 0 ] }
				onChange={ ( value ) =>
					value !== undefined && setSelected( [ String( value ) ] )
				}
				isBlock
				__nextHasNoMarginBottom
				__next40pxDefaultSize
			>
				{ options.map( ( option ) => (
					<ToggleGroupControlOption
						key={ option.value }
						value={ option.value }
						label={ option.label }
					/>
				) ) }
			</ToggleGroupControl>
		);
	} else if ( ! multiple ) {
		control = (
			<RadioControl
				label={ label }
				hideLabelFromVision
				selected={ selected[ 0 ] }
				options={ options }
				onChange={ ( value ) => setSelected( [ value ] ) }
			/>
		);
	} else if ( chips ) {
		control = (
			<HStack wrap justify="flex-start" spacing={ 2 }>
				{ options.map( ( option ) => (
					<WPButton
						key={ option.value }
						variant={
							selected.includes( option.value )
								? 'primary'
								: 'secondary'
						}
						isPressed={ selected.includes( option.value ) }
						size="compact"
						onClick={ () => toggle( option.value ) }
					>
						{ option.label }
					</WPButton>
				) ) }
			</HStack>
		);
	} else {
		control = (
			<VStack spacing={ 2 }>
				{ options.map( ( option ) => (
					<CheckboxControl
						key={ option.value }
						label={ option.label }
						checked={ selected.includes( option.value ) }
						onChange={ () => toggle( option.value ) }
						__nextHasNoMarginBottom
					/>
				) ) }
			</VStack>
		);
	}

	return (
		<BaseControl
			className="a2ui-wp-choice-picker"
			__nextHasNoMarginBottom
			label={ label || undefined }
			id={ `a2ui-${ id }` }
		>
			<VStack spacing={ 2 }>
				{ props.filterable ? (
					<SearchControl
						__nextHasNoMarginBottom
						size="compact"
						value={ filter }
						onChange={ setFilter }
						label={ __( 'Filter options', 'a2ui-wp' ) }
						placeholder={ __( 'Filter options…', 'a2ui-wp' ) }
					/>
				) : null }
				{ control }
				{ ! valid ? <ErrorText messages={ messages } /> : null }
			</VStack>
		</BaseControl>
	);
}

// ---------------------------------------------------------------------------

export interface SliderProps extends Checkable {
	label?: DynamicString;
	min?: number;
	max: number;
	value: DynamicNumber;
}

export function Slider( { props }: A2UIComponentProps< SliderProps > ) {
	const label = useDynamicString( props.label ?? '' );
	const min = props.min ?? 0;
	const max = props.max ?? 100;
	const [ value, setValue ] = useBoundValue( props.value ?? min, ( raw ) => {
		const n = Number( raw );
		return Number.isNaN( n ) ? min : n;
	} );
	return (
		<RangeControl
			className="a2ui-wp-slider"
			label={ label || undefined }
			min={ min }
			max={ max }
			value={ value }
			onChange={ ( next ) => setValue( next ?? min ) }
			__nextHasNoMarginBottom
			__next40pxDefaultSize
		/>
	);
}

// ---------------------------------------------------------------------------

export interface DateTimeInputProps extends Checkable {
	value: DynamicString;
	enableDate?: boolean;
	enableTime?: boolean;
	min?: DynamicString;
	max?: DynamicString;
	label?: DynamicString;
}

function formatDisplay(
	value: string,
	withDate: boolean,
	withTime: boolean
): string {
	if ( ! value ) {
		if ( withDate && withTime ) {
			return __( 'Select date and time', 'a2ui-wp' );
		}
		return withDate
			? __( 'Select date', 'a2ui-wp' )
			: __( 'Select time', 'a2ui-wp' );
	}
	const date = new Date( value );
	if ( Number.isNaN( date.getTime() ) ) {
		return value;
	}
	return date.toLocaleString( undefined, {
		...( withDate
			? { year: 'numeric', month: 'short', day: 'numeric' }
			: {} ),
		...( withTime ? { hour: 'numeric', minute: '2-digit' } : {} ),
	} );
}

export function DateTimeInput( {
	id,
	props,
}: A2UIComponentProps< DateTimeInputProps > ) {
	const label = useDynamicString( props.label ?? '' );
	const min = useDynamicString( props.min ?? '' );
	const max = useDynamicString( props.max ?? '' );
	const [ value, setValue ] = useBoundValue(
		props.value ?? '',
		toStringValue
	);
	const withDate = props.enableDate ?? true;
	const withTime = props.enableTime ?? false;

	const isInvalidDate = ( date: Date ) => {
		if ( min && date < new Date( min ) ) {
			return true;
		}
		if ( max && date > new Date( max ) ) {
			return true;
		}
		return false;
	};
	const onChange = ( next: string | null | undefined ) =>
		setValue( next ?? '' );
	const controlId = `a2ui-${ id }`;
	const renderPicker = () => {
		if ( withDate && withTime ) {
			return (
				<DateTimePicker
					currentDate={ value || null }
					onChange={ onChange }
					isInvalidDate={ isInvalidDate }
				/>
			);
		}
		if ( withDate ) {
			return (
				<DatePicker
					currentDate={ value || null }
					onChange={ onChange }
					isInvalidDate={ isInvalidDate }
				/>
			);
		}
		return (
			<TimePicker currentTime={ value || null } onChange={ onChange } />
		);
	};

	return (
		<BaseControl
			className="a2ui-wp-date-time"
			__nextHasNoMarginBottom
			label={ label || undefined }
			id={ controlId }
		>
			<Dropdown
				popoverProps={ { placement: 'bottom-start' } }
				renderToggle={ ( { isOpen, onToggle } ) => (
					<WPButton
						id={ controlId }
						variant="secondary"
						icon={ calendar }
						onClick={ onToggle }
						aria-expanded={ isOpen }
						__next40pxDefaultSize
					>
						{ formatDisplay( value, withDate, withTime ) }
					</WPButton>
				) }
				renderContent={ renderPicker }
			/>
		</BaseControl>
	);
}

// ---------------------------------------------------------------------------

export interface ModalProps {
	trigger?: string;
	content?: string;
	accessibility?: { label?: DynamicString; description?: DynamicString };
}

export function Modal( { props }: A2UIComponentProps< ModalProps > ) {
	const [ open, setOpen ] = useState( false );
	const a11y = useAccessibility( props.accessibility );
	return (
		<>
			{ props.trigger ? (
				// The trigger is usually a Button; a click anywhere inside opens the modal
				// in addition to the trigger's own action, matching the reference renderer.
				// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
				<div
					className="a2ui-wp-modal-trigger"
					style={ { display: 'inline-block' } }
					onClick={ () => setOpen( true ) }
				>
					<A2UINode id={ props.trigger } />
				</div>
			) : null }
			{ open && props.content ? (
				<WPModal
					className="a2ui-wp-modal"
					title={ a11y.label ?? '' }
					contentLabel={ a11y.label ?? __( 'Dialog', 'a2ui-wp' ) }
					onRequestClose={ () => setOpen( false ) }
				>
					<A2UINode id={ props.content } />
				</WPModal>
			) : null }
		</>
	);
}
