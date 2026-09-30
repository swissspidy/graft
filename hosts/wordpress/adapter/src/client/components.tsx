import { useState, type CSSProperties } from 'react';
import { Button, Card, CardBody, CardHeader, CheckboxControl, Notice, SelectControl, Spinner, TextareaControl, TextControl } from '@wordpress/components';
import type { ComponentRegistry, RendererComponentProps } from '@graft/renderer-react';
import { cell, type Field, type Tone } from '../cells.ts';

/**
 * WordPress implementations of the surface components (see
 * ../components.ts for their contracts). They render wp-admin markup and
 * @wordpress/components, so customizations look native.
 */

type Props = RendererComponentProps;

/** WordPress admin colors for text that carries a tone. */
const toneColors: Record<Tone, string> = { success: '#00a32a', warning: '#996800', error: '#d63638', info: '#2271b1' };

const locale = () => document.documentElement.lang || undefined;

const gaps = [0, 4, 8, 12, 16, 20, 24, 32, 40];

function Stack({ props, children }: Props) {
	const style: CSSProperties = {
		display: 'flex',
		flexDirection: props.direction === 'row' ? 'row' : 'column',
		gap: gaps[Number(props.gap ?? 2)] ?? 8,
		alignItems: flexValue(props.align),
		justifyContent: flexValue(props.justify),
	};
	return <div style={style}>{children}</div>;
}

function Heading({ props, children }: Props) {
	const level = Math.min(4, Math.max(1, Number(props.level ?? 2)));
	const Tag = `h${level}` as 'h1';
	return <Tag className={level === 1 ? 'wp-heading-inline' : undefined}>{children}</Tag>;
}

function Text({ props, children }: Props) {
	if (props.variant === 'strong') {
		return (
			<p>
				<strong>{children}</strong>
			</p>
		);
	}
	return <p className={props.variant === 'muted' ? 'description' : undefined}>{children}</p>;
}

function ActionButton({
	label,
	action,
	variant,
	confirm,
	disabled,
	invoke,
	id,
}: {
	label: string;
	action: unknown;
	variant?: 'primary' | 'secondary' | 'tertiary' | 'link';
	confirm?: unknown;
	disabled?: boolean;
	invoke: Props['invoke'];
	id?: string;
}) {
	const [busy, setBusy] = useState(false);
	const run = async () => {
		if (typeof confirm === 'string' && !window.confirm(confirm)) {
			return;
		}
		setBusy(true);
		try {
			await invoke(action);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Button variant={variant ?? 'secondary'} size="compact" isBusy={busy} disabled={busy || disabled} accessibleWhenDisabled onClick={run} data-graft-action={id}>
			{label}
		</Button>
	);
}

function GraftButton({ props, invoke }: Props) {
	// A null action is a widget's action that is not offered here.
	if (props.visible === false || props.onClick === null) {
		return null;
	}
	return (
		<ActionButton
			id={String(props.id)}
			label={String(props.label)}
			action={props.onClick}
			variant={props.variant as 'primary'}
			confirm={props.confirm}
			disabled={props.disabled === true}
			invoke={invoke}
		/>
	);
}

function GraftNotice({ props, children }: Props) {
	const [open, setOpen] = useState(true);
	if (!open) {
		return null;
	}
	return (
		<Notice status={(props.status as 'info') ?? 'info'} isDismissible={props.dismissible === true} onRemove={() => setOpen(false)}>
			{children}
		</Notice>
	);
}

function GraftCard({ props, children }: Props) {
	return (
		<Card>
			{typeof props.title === 'string' && props.title ? <CardHeader>{props.title}</CardHeader> : null}
			<CardBody>{children}</CardBody>
		</Card>
	);
}

function EmptyState({ props }: Props) {
	return (
		<div className="graft-empty-state" style={{ padding: '24px 0', textAlign: 'center' }}>
			<p>
				<strong>{String(props.title)}</strong>
			</p>
			{typeof props.description === 'string' ? <p className="description">{props.description}</p> : null}
		</div>
	);
}

interface TableAction {
	id: string;
	label: string;
	onClick: unknown;
	visible?: unknown;
	primary?: boolean;
	destructive?: boolean;
	confirm?: string;
}

function Table({ props, raw, evaluate, invoke }: Props) {
	// Unevaluated, for per-row value and tone; as evaluated when the list itself comes from an expression.
	const fields = (Array.isArray(raw.fields) ? raw.fields : Array.isArray(props.fields) ? props.fields : []) as Field[];
	const rows = props.rows as Array<Record<string, unknown>> | undefined;
	const actions = (raw.actions as unknown[] | undefined) ?? [];
	const columns = fields.length + (actions.length > 0 ? 1 : 0);

	let body;
	if (rows === undefined) {
		body = (
			<tr>
				<td colSpan={columns}>
					<Spinner />
				</td>
			</tr>
		);
	} else if (rows.length === 0) {
		body = (
			<tr className="no-items">
				<td colSpan={columns} data-graft-empty="">
					{typeof props.empty === 'string' ? props.empty : 'No items.'}
				</td>
			</tr>
		);
	} else {
		body = rows.map((row, i) => (
			<tr key={String(row.id ?? i)} data-graft-row={String(row.id ?? i)}>
				{fields.map((field) => {
					const { text, tone } = cell(field, row, (value, r) => evaluate(value as never, r), locale());
					const content = tone ? <span className={`graft-tone graft-tone-${tone}`} data-graft-tone={tone} style={{ color: toneColors[tone], fontWeight: 600 }}>{text}</span> : text;
					return (
						<td key={field.id} className={field.primary ? 'column-primary' : undefined} data-graft-field={field.id}>
							{field.primary ? <strong>{content}</strong> : content}
						</td>
					);
				})}
				{actions.length > 0 ? (
					<td>
						<div style={{ display: 'flex', gap: 8 }}>
							{actions.map((rawAction) => {
								const action = evaluate(rawAction as never, row) as TableAction;
								if (action.visible === false || action.onClick === null) {
									return null;
								}
								return (
									<ActionButton
										key={action.id}
										id={action.id}
										label={action.label}
										action={action.onClick}
										variant={action.primary ? 'primary' : 'secondary'}
										confirm={action.confirm}
										invoke={invoke}
									/>
								);
							})}
						</div>
					</td>
				) : null}
			</tr>
		));
	}

	return (
		<table className="wp-list-table widefat fixed striped">
			<thead>
				<tr>
					{fields.map((field) => (
						<th key={field.id} scope="col" className={field.primary ? 'column-primary' : undefined}>
							{field.label}
						</th>
					))}
					{actions.length > 0 ? (
						<th scope="col">
							<span className="screen-reader-text">Actions</span>
						</th>
					) : null}
				</tr>
			</thead>
			<tbody>{body}</tbody>
		</table>
	);
}

function RowAction({ props, invoke }: Props) {
	const [busy, setBusy] = useState(false);
	if (props.visible === false) {
		return null;
	}
	return (
		<a
			href="#"
			role="button"
			aria-disabled={busy}
			data-graft-action={String(props.id)}
			onClick={async (event) => {
				event.preventDefault();
				if (busy || (typeof props.confirm === 'string' && !window.confirm(props.confirm))) {
					return;
				}
				setBusy(true);
				try {
					await invoke(props.onClick);
				} finally {
					setBusy(false);
				}
			}}
		>
			{String(props.label)}
		</a>
	);
}

// Inputs: the renderer keeps the value (props.field); they only display it and
// report changes. Outside a widget there is no field, and they render nothing.

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const help = (props: Props['props']) => (typeof props.help === 'string' ? props.help : undefined);

function GraftTextInput({ props, field }: Props) {
	if (!field) {
		return null;
	}
	return (
		<TextControl
			__nextHasNoMarginBottom
			__next40pxDefaultSize
			label={String(props.label ?? '')}
			help={help(props)}
			placeholder={typeof props.placeholder === 'string' ? props.placeholder : undefined}
			value={text(field.value)}
			onChange={(value: string) => field.change(value)}
			data-graft-input={String(props.id ?? '')}
		/>
	);
}

function GraftTextarea({ props, field }: Props) {
	if (!field) {
		return null;
	}
	return (
		<TextareaControl
			__nextHasNoMarginBottom
			label={String(props.label ?? '')}
			help={help(props)}
			rows={Number(props.rows ?? 4)}
			value={text(field.value)}
			onChange={(value: string) => field.change(value)}
			data-graft-input={String(props.id ?? '')}
		/>
	);
}

function GraftCheckbox({ props, field }: Props) {
	if (!field) {
		return null;
	}
	return (
		<CheckboxControl
			__nextHasNoMarginBottom
			label={String(props.label ?? '')}
			help={help(props)}
			checked={field.value === true}
			onChange={(checked: boolean) => field.change(checked)}
			data-graft-input={String(props.id ?? '')}
		/>
	);
}

function GraftSelect({ props, field }: Props) {
	if (!field) {
		return null;
	}
	const options = (Array.isArray(props.options) ? props.options : []) as Array<{ value: string; label: string }>;
	return (
		<SelectControl
			__nextHasNoMarginBottom
			__next40pxDefaultSize
			label={String(props.label ?? '')}
			help={help(props)}
			value={text(field.value)}
			options={options.map((option) => ({ value: String(option.value), label: String(option.label) }))}
			onChange={(value: string) => field.change(value)}
			data-graft-input={String(props.id ?? '')}
		/>
	);
}

export const components: ComponentRegistry = {
	stack: Stack,
	heading: Heading,
	text: Text,
	button: GraftButton,
	notice: GraftNotice,
	card: GraftCard,
	'empty-state': EmptyState,
	table: Table,
	'row-action': RowAction,
	'text-input': GraftTextInput,
	textarea: GraftTextarea,
	checkbox: GraftCheckbox,
	select: GraftSelect,
};

function flexValue(value: unknown): CSSProperties['alignItems'] {
	return value === 'start' ? 'flex-start' : value === 'end' ? 'flex-end' : (value as CSSProperties['alignItems']);
}

