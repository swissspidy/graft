<?php
/**
 * Synthetic host changes for the canary. Loaded as a must-use plugin in the
 * verification sandbox only. Reads a patch from the graft_canary_patch
 * option and applies it through the plugin's own surface filters, so the
 * sandbox really behaves like the changed host (surface B is then generated
 * from it like any other snapshot).
 *
 * Patch keys:
 * - capabilities.rename: { old: new } capability names.
 * - capabilities.remove: [ names ].
 * - capabilities.scopes: { name: [ scopes ] }.
 * - capabilities.ability: { name: ability } points a capability at another ability.
 * - scopes.add: { scope: { title, host: [ caps ] } }.
 * - slots.alias: { new: existing } adds a slot with the same definition.
 * - slots.deprecate: { slot: successor }.
 * - variants: [ "posts-list-statuses" ] registers alternative abilities.
 */

namespace Graft\Canary;

defined( 'ABSPATH' ) || exit;

function patch(): array {
	$patch = get_option( 'graft_canary_patch', array() );
	return is_array( $patch ) ? $patch : array();
}

add_filter(
	'graft_surface_capability_map',
	static function ( array $map ): array {
		$patch = patch();
		foreach ( $patch['capabilities']['ability'] ?? array() as $name => $ability ) {
			if ( isset( $map[ $name ] ) ) {
				$map[ $name ]['ability'] = $ability;
			}
		}
		foreach ( $patch['capabilities']['scopes'] ?? array() as $name => $scopes ) {
			if ( isset( $map[ $name ] ) ) {
				$map[ $name ]['scopes'] = $scopes;
			}
		}
		foreach ( $patch['capabilities']['rename'] ?? array() as $from => $to ) {
			if ( isset( $map[ $from ] ) ) {
				$map[ $to ] = $map[ $from ];
				unset( $map[ $from ] );
			}
		}
		foreach ( $patch['capabilities']['remove'] ?? array() as $name ) {
			unset( $map[ $name ] );
		}
		return $map;
	},
	20
);

add_filter(
	'graft_surface_scopes',
	static function ( array $scopes ): array {
		return array_merge( $scopes, patch()['scopes']['add'] ?? array() );
	},
	20
);

add_filter(
	'graft_surface_slots',
	static function ( array $slots ): array {
		$patch = patch();
		foreach ( $patch['slots']['alias'] ?? array() as $new => $existing ) {
			if ( isset( $slots[ $existing ] ) ) {
				$slots[ $new ] = $slots[ $existing ];
			}
		}
		foreach ( $patch['slots']['deprecate'] ?? array() as $slot => $successor ) {
			if ( isset( $slots[ $slot ] ) ) {
				$slots[ $slot ]['deprecated'] = true;
				$slots[ $slot ]['successor']  = $successor;
			}
		}
		return $slots;
	},
	20
);

add_action(
	'wp_abilities_api_init',
	static function (): void {
		if ( ! in_array( 'posts-list-statuses', patch()['variants'] ?? array(), true ) ) {
			return;
		}
		// posts-list whose status filter is called "statuses": an input
		// change no migration describes, which forces regeneration.
		$base   = wp_get_ability( 'graft/posts-list' );
		$schema = $base->get_input_schema();
		$schema['properties']['statuses'] = $schema['properties']['status'];
		unset( $schema['properties']['status'] );
		wp_register_ability(
			'graft-canary/posts-list',
			array(
				'label'               => 'List posts (statuses)',
				'description'         => $base->get_description(),
				'category'            => 'graft',
				'input_schema'        => $schema,
				'output_schema'       => $base->get_output_schema(),
				'execute_callback'    => static function ( $input = null ) {
					$input = is_array( $input ) ? $input : array();
					if ( isset( $input['statuses'] ) ) {
						$input['status'] = $input['statuses'];
						unset( $input['statuses'] );
					}
					return \Graft\execute_posts_list( $input );
				},
				'permission_callback' => static function ( $input = null ) {
					return \Graft\can_list_posts( $input );
				},
				'meta'                => $base->get_meta(),
			)
		);
	},
	20
);
