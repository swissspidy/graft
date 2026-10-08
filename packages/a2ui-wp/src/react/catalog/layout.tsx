import type { CSSProperties } from 'react';
import {
	__experimentalHStack as HStack,
	__experimentalVStack as VStack,
	__experimentalDivider as WPDivider,
	Card as WPCard,
	CardBody,
	TabPanel,
} from '@wordpress/components';
import type { ChildList, DynamicString } from '../../core/types';
import { resolveString } from '../../core/resolver';
import type { A2UIComponentProps } from '../context';
import { useResolveScope } from '../hooks';
import { A2UIChildren, A2UINode } from '../node';

type Justify =
	| 'start'
	| 'center'
	| 'end'
	| 'spaceBetween'
	| 'spaceAround'
	| 'spaceEvenly'
	| 'stretch';
type Align = 'start' | 'center' | 'end' | 'stretch';

const JUSTIFY: Record< Justify, CSSProperties[ 'justifyContent' ] > = {
	start: 'flex-start',
	center: 'center',
	end: 'flex-end',
	spaceBetween: 'space-between',
	spaceAround: 'space-around',
	spaceEvenly: 'space-evenly',
	stretch: 'stretch',
};

const ALIGN: Record< Align, CSSProperties[ 'alignItems' ] > = {
	start: 'flex-start',
	center: 'center',
	end: 'flex-end',
	stretch: 'stretch',
};

export interface RowProps {
	children: ChildList;
	justify?: Justify;
	align?: Align;
}

export function Row( { props }: A2UIComponentProps< RowProps > ) {
	return (
		<HStack
			className="a2ui-wp-row"
			spacing={ 3 }
			wrap
			justify={ JUSTIFY[ props.justify ?? 'start' ] }
			alignment={ ALIGN[ props.align ?? 'stretch' ] }
		>
			<A2UIChildren>{ props.children }</A2UIChildren>
		</HStack>
	);
}

export type ColumnProps = RowProps;

export function Column( { props }: A2UIComponentProps< ColumnProps > ) {
	return (
		<VStack
			className="a2ui-wp-column"
			spacing={ 3 }
			justify={ JUSTIFY[ props.justify ?? 'start' ] }
			alignment={ ALIGN[ props.align ?? 'stretch' ] }
		>
			<A2UIChildren>{ props.children }</A2UIChildren>
		</VStack>
	);
}

export interface ListProps {
	children: ChildList;
	direction?: 'vertical' | 'horizontal';
	align?: Align;
}

export function List( { props }: A2UIComponentProps< ListProps > ) {
	const horizontal = props.direction === 'horizontal';
	const Stack = horizontal ? HStack : VStack;
	return (
		<div
			className={ `a2ui-wp-list is-${ horizontal ? 'horizontal' : 'vertical' }` }
			style={ {
				overflow: 'auto',
				maxHeight: horizontal ? undefined : '60vh',
			} }
		>
			<Stack
				spacing={ 3 }
				wrap={ false }
				alignment={ ALIGN[ props.align ?? 'stretch' ] }
				justify="flex-start"
			>
				<A2UIChildren>{ props.children }</A2UIChildren>
			</Stack>
		</div>
	);
}

export interface CardProps {
	child: string;
}

export function Card( { props }: A2UIComponentProps< CardProps > ) {
	return (
		<WPCard className="a2ui-wp-card">
			<CardBody>
				<A2UINode id={ props.child } />
			</CardBody>
		</WPCard>
	);
}

export interface TabsProps {
	tabs: Array< { title: DynamicString; child: string } >;
}

export function Tabs( { id, props }: A2UIComponentProps< TabsProps > ) {
	const scope = useResolveScope();
	const tabs = ( props.tabs ?? [] ).map( ( tab, index ) => ( {
		name: `${ id }-tab-${ index }`,
		title: resolveString( tab.title, scope ),
		child: tab.child,
	} ) );
	if ( tabs.length === 0 ) {
		return null;
	}
	return (
		<TabPanel className="a2ui-wp-tabs" tabs={ tabs }>
			{ ( tab ) => (
				<A2UINode id={ ( tab as ( typeof tabs )[ number ] ).child } />
			) }
		</TabPanel>
	);
}

export interface DividerProps {
	axis?: 'horizontal' | 'vertical';
}

export function Divider( { props }: A2UIComponentProps< DividerProps > ) {
	return (
		<WPDivider orientation={ props.axis ?? 'horizontal' } margin={ 2 } />
	);
}
