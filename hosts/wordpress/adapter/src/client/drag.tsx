import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAction, useChecks, useDynamicBoolean, wordPressCatalog, type A2UIComponentProps } from '@swissspidy/a2ui-wp';

/**
 * Dragging in the Graft catalog: a `draggable` Card can be dropped on a
 * Column, Row or Card with a `dropTarget`, and the drop presses the
 * Button inside the dragged Card with that `dropTarget`. A drop is only
 * another way to press a button the viewer already has: a container takes
 * a card only if the card shows an enabled Button for it, and keyboard and
 * screen reader users press the Button itself.
 */

type Press = () => void;

/** What a dropped card does, by drop target: its visible, enabled Buttons. */
type Presses = ReadonlyMap<string, Press>;

const DragContext = createContext<{ dragging: Presses | undefined; setDragging(presses: Presses | undefined): void }>({ dragging: undefined, setDragging() {} });

/** The draggable Card a Button is in, which a Button tells what dropping the card presses. */
const CardContext = createContext<((target: string, press: Press | undefined) => void) | undefined>(undefined);

/** Around a surface: which card, if any, is being dragged. */
export function DragProvider({ children }: { children: ReactNode }) {
	const [dragging, setDragging] = useState<Presses | undefined>(undefined);
	return <DragContext.Provider value={{ dragging, setDragging }}>{children}</DragContext.Provider>;
}

/** A container that takes dropped cards: outlined while a card it takes is dragged. */
function DropZone({ name, flex, children }: { name: string; flex: boolean; children: ReactNode }) {
	const { dragging, setDragging } = useContext(DragContext);
	const [over, setOver] = useState(false);
	const press = dragging?.get(name);
	return (
		<div
			data-graft-drop-target={name}
			data-graft-drop={dragging ? (press ? 'accepts' : 'refuses') : undefined}
			onDragOver={(event) => {
				// Only a zone the dragged card has a button for takes the drop.
				if (press) {
					event.preventDefault();
					event.dataTransfer.dropEffect = 'move';
					setOver(true);
				}
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(event) => {
				if (!press) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				setOver(false);
				setDragging(undefined);
				press();
			}}
			style={{
				...(flex ? { flex: '1 1 0', minWidth: 0 } : {}),
				borderRadius: 4,
				outline: over ? '2px solid var(--wp-admin-theme-color, #3858e9)' : press ? '2px dashed #8c8f94' : 'none',
				outlineOffset: 2,
			}}
		>
			{children}
		</div>
	);
}

const BaseCard = wordPressCatalog.Card!;
const BaseColumn = wordPressCatalog.Column!;
const BaseRow = wordPressCatalog.Row!;

/** a2ui-wp's Card, draggable when `draggable` holds and a drop target when it has a `dropTarget`. */
export function Card(props: A2UIComponentProps<{ draggable?: unknown; dropTarget?: string }>) {
	const draggable = useDynamicBoolean(props.props.draggable ?? false);
	const { dragging, setDragging } = useContext(DragContext);
	const [presses, setPresses] = useState<Presses>(() => new Map());
	const register = useCallback(
		(target: string, press: Press | undefined) =>
			setPresses((current) => {
				const next = new Map(current);
				if (press) {
					next.set(target, press);
				} else {
					next.delete(target);
				}
				return next;
			}),
		[],
	);
	let card = <BaseCard {...props} />;
	if (draggable) {
		const movable = presses.size > 0;
		card = (
			<CardContext.Provider value={register}>
				<div
					data-graft-draggable={props.id}
					draggable={movable}
					onDragStart={(event) => {
						event.dataTransfer.effectAllowed = 'move';
						event.dataTransfer.setData('text/plain', props.id);
						setDragging(presses);
					}}
					onDragEnd={() => setDragging(undefined)}
					style={{ cursor: movable ? 'grab' : undefined, opacity: dragging === presses ? 0.5 : 1 }}
				>
					{card}
				</div>
			</CardContext.Provider>
		);
	}
	return props.props.dropTarget ? (
		<DropZone name={props.props.dropTarget} flex={false}>
			{card}
		</DropZone>
	) : (
		card
	);
}

/** a2ui-wp's Column and Row, drop targets when they have a `dropTarget`. */
export const Column = (props: A2UIComponentProps<{ dropTarget?: string }>) =>
	props.props.dropTarget ? (
		<DropZone name={props.props.dropTarget} flex>
			<BaseColumn {...props} />
		</DropZone>
	) : (
		<BaseColumn {...props} />
	);

export const Row = (props: A2UIComponentProps<{ dropTarget?: string }>) =>
	props.props.dropTarget ? (
		<DropZone name={props.props.dropTarget} flex>
			<BaseRow {...props} />
		</DropZone>
	) : (
		<BaseRow {...props} />
	);

/**
 * For a Button with a `dropTarget`: tells its draggable Card that a drop
 * there presses it, while it is drawn and its checks pass.
 */
export function useDropButton(id: string, props: { dropTarget?: string; action?: unknown; checks?: unknown }) {
	const register = useContext(CardContext);
	const { valid } = useChecks(props.checks as never);
	const fire = useAction(props.action as never, id);
	const latest = useRef(fire);
	latest.current = fire;
	const target = props.dropTarget;
	useEffect(() => {
		if (!register || !target || !valid) {
			return undefined;
		}
		register(target, () => latest.current());
		return () => register(target, undefined);
	}, [register, target, valid]);
}
