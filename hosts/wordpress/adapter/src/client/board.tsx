import { useState, type DragEvent } from 'react';
import { Button, Card, CardBody, CardHeader } from '@wordpress/components';
import { boardLanes, movesFrom, tableField, type BoardColumn, type BoardMove } from '@swissspidy/graft-a2ui/client';
import { useProcessor, useScopePath, useSurface, type A2UIComponentProps } from '@swissspidy/a2ui-wp';
import { cell, type Field, type Tone } from '../cells.ts';

/**
 * The catalog's Board, drawn with @wordpress/components: a column per
 * value of `columnBy`, a card per item, and on each card a button per
 * move it may make. The buttons are the keyboard (and screen reader) way
 * to move a card; dragging a card onto a column uses the same move, and
 * a column only takes a card that has a move to it. Either way the move
 * dispatches its A2UI action, the event its build binds to a capability.
 */

const toneColors: Record<Tone, string> = { success: '#00a32a', warning: '#996800', error: '#d63638', info: '#2271b1' };

/** A move a card offers, resolved for it. */
export interface CardMove {
	id: string;
	label: string;
	to: string;
	primary: boolean;
	run(): void;
}

/** A card as drawn: its title, its other fields, its moves. */
export interface BoardCard {
	key: string;
	title: string;
	lines: Array<{ label: string; text: string; tone?: Tone }>;
	moves: CardMove[];
}

export interface BoardViewProps {
	columns: Array<{ id: string; title: string; empty: string; cards: BoardCard[] }>;
}

/** The board itself, from cards already resolved: what the A2UI Board draws, and what the unit tests render. */
export function BoardView({ columns }: BoardViewProps) {
	// The card being dragged, and the column it is over.
	const [dragging, setDragging] = useState<BoardCard | undefined>(undefined);
	const [over, setOver] = useState<string | undefined>(undefined);
	const moveTo = (column: string) => dragging?.moves.find((move) => move.to === column);

	const drop = (event: DragEvent, column: string) => {
		event.preventDefault();
		const move = moveTo(column);
		setDragging(undefined);
		setOver(undefined);
		move?.run();
	};

	return (
		<div className="graft-board" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, minmax(14rem, 1fr))`, gap: 16, alignItems: 'start', overflowX: 'auto' }}>
			{columns.map((column) => {
				const accepts = moveTo(column.id) !== undefined;
				return (
					<section
						key={column.id}
						className="graft-board__column"
						aria-labelledby={`graft-board-${column.id}`}
						data-graft-column={column.id}
						data-graft-drop={dragging ? (accepts ? 'accepts' : 'refuses') : undefined}
						onDragOver={(event) => {
							// Only a column the card has a move to takes the drop.
							if (accepts) {
								event.preventDefault();
								event.dataTransfer.dropEffect = 'move';
								setOver(column.id);
							}
						}}
						onDragLeave={() => setOver((current) => (current === column.id ? undefined : current))}
						onDrop={(event) => drop(event, column.id)}
						style={{
							background: '#f0f0f1',
							borderRadius: 4,
							padding: 8,
							minHeight: 120,
							outline: over === column.id ? '2px solid var(--wp-admin-theme-color, #3858e9)' : accepts ? '2px dashed #c3c4c7' : 'none',
						}}
					>
						<h2 id={`graft-board-${column.id}`} style={{ fontSize: 14, margin: '4px 4px 8px' }}>
							{column.title} <span style={{ color: '#646970', fontWeight: 'normal' }}>({column.cards.length})</span>
						</h2>
						{column.cards.length === 0 ? (
							<p style={{ color: '#646970', margin: 4 }}>{column.empty}</p>
						) : (
							<ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
								{column.cards.map((card) => (
									<li
										key={card.key}
										data-graft-card={card.title}
										draggable={card.moves.length > 0}
										onDragStart={(event) => {
											event.dataTransfer.effectAllowed = 'move';
											event.dataTransfer.setData('text/plain', card.title);
											setDragging(card);
										}}
										onDragEnd={() => {
											setDragging(undefined);
											setOver(undefined);
										}}
										style={{ cursor: card.moves.length > 0 ? 'grab' : 'default', opacity: dragging?.key === card.key ? 0.5 : 1 }}
									>
										<Card size="small">
											<CardHeader size="small">
												<strong>{card.title}</strong>
											</CardHeader>
											<CardBody size="small">
												{card.lines.map((line) => (
													<div key={line.label} style={{ color: line.tone ? toneColors[line.tone] : '#50575e' }}>
														<span className="screen-reader-text">{line.label}: </span>
														{line.text}
													</div>
												))}
												{card.moves.length > 0 && (
													<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
														{card.moves.map((move) => (
															<span key={move.id} data-graft-action={move.id}>
																<Button
																	variant={move.primary ? 'primary' : 'secondary'}
																	size="compact"
																	onClick={move.run}
																	aria-label={`${move.label}: ${card.title}`}
																>
																	{move.label}
																</Button>
															</span>
														))}
													</div>
												)}
											</CardBody>
										</Card>
									</li>
								))}
							</ul>
						)}
					</section>
				);
			})}
		</div>
	);
}

interface BoardProps {
	items?: { path: string };
	columnBy?: string;
	columns?: BoardColumn[];
	fields?: Field[];
	moves?: BoardMove[];
}

/**
 * The A2UI Board: resolves every card in its item's scope (fields as the
 * verifier formats them, `visible` of each move with `can` refined on
 * the item) and dispatches a move's action from that scope.
 */
export function Board({ id, props }: A2UIComponentProps<BoardProps>) {
	const processor = useProcessor();
	const surface = useSurface();
	const scope = processor.createScope(surface, useScopePath());
	const itemsScope = props.items?.path ? scope.nested(props.items.path) : undefined;
	const items = itemsScope ? surface.dataModel.get(itemsScope.path) : undefined;
	const fields = (props.fields ?? []).map(tableField);
	const primary = fields.find((field) => field.primary) ?? fields[0];
	const locale = document.documentElement.lang || undefined;

	const lanes = boardLanes(Array.isArray(items) ? (items as unknown[]) : [], props.columnBy ?? '', props.columns ?? []);
	return (
		<BoardView
			columns={lanes.map(({ column, cards }) => ({
				id: column.id,
				title: column.title,
				empty: column.empty === undefined ? 'No items.' : String(scope.resolveDynamicValue(column.empty as never) ?? ''),
				cards: cards.map(({ item, index }) => {
					const itemScope = itemsScope!.nested(String(index));
					const evaluate = (value: unknown) => itemScope.resolveDynamicValue(value as never);
					return {
						key: String((item as { id?: unknown }).id ?? index),
						title: primary ? String(evaluate(primary.value) ?? '') : '',
						lines: fields.filter((field) => field !== primary).map((field) => ({ label: field.label, ...cell(field, item, evaluate, locale) })),
						moves: movesFrom(props.moves, column.id)
							.filter((move) => move.visible === undefined || Boolean(evaluate(move.visible)))
							.map((move) => ({
								id: move.id,
								label: move.label,
								to: move.to,
								primary: move.variant === 'primary',
								run: () => processor.dispatchAction(surface.id, id, move.action as never, itemScope.path),
							})),
					};
				}),
			}))}
		/>
	);
}
