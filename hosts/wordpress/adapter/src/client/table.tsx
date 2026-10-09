import { useState } from 'react';
import { Button, Spinner } from '@wordpress/components';
import { cell, type Field, type Tone } from '../cells.ts';

/**
 * Graft's WordPress table: wp-admin list table markup, with cells and their
 * tones formatted as the verifier reads them (../cells.ts) and row actions
 * as buttons. The A2UI catalog's Table draws with it (./a2ui.tsx).
 */

export interface TableProps {
	props: { rows?: Array<Record<string, unknown>>; fields?: Field[]; empty?: string };
	/** Unevaluated fields (per-row value and tone) and row actions. */
	raw: { fields?: Field[]; actions?: unknown[] };
	/** Evaluates a field's value or tone, or a row action, for a row. */
	evaluate(value: unknown, row?: unknown): unknown;
	/** Runs what a row action's `onClick` evaluated to. */
	invoke(action: unknown): Promise<void>;
}

/** WordPress admin colors for text that carries a tone. */
const toneColors: Record<Tone, string> = { success: '#00a32a', warning: '#996800', error: '#d63638', info: '#2271b1' };

const locale = () => document.documentElement.lang || undefined;

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
	invoke: TableProps['invoke'];
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

interface TableAction {
	id: string;
	label: string;
	onClick: unknown;
	visible?: unknown;
	primary?: boolean;
	destructive?: boolean;
	confirm?: string;
}

export function Table({ props, raw, evaluate, invoke }: TableProps) {
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
