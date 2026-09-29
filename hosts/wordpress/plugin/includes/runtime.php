<?php
/**
 * Serving: which specs render for the current user on this surface, and the
 * client configuration for them.
 *
 * @package Graft
 */

namespace Graft;

use WP_User;

/**
 * Whether a spec applies to a user: its scope (org, team = role, user =
 * owner) and its audience. Audience only decides visibility; the gateway
 * enforces the grant on every call.
 *
 * @param array<string, mixed> $record Active version record.
 * @param WP_User              $user   User.
 * @return bool
 */
function applies_to_user( array $record, WP_User $user ): bool {
	if ( ! $user->exists() ) {
		return false;
	}
	$scope = $record['scope'] ?? array( 'type' => 'org' );
	switch ( $scope['type'] ?? 'org' ) {
		case 'user':
			if ( (int) $record['owner'] !== $user->ID ) {
				return false;
			}
			break;
		case 'team':
			if ( ! in_array( $scope['role'] ?? '', $user->roles, true ) ) {
				return false;
			}
			break;
	}
	$audience = $record['manifest']['audience'] ?? array();
	return array() === $audience || array() !== array_intersect( $audience, $user->roles );
}

/**
 * Active specs that have a build for the current surface and apply to the
 * current user, keyed by spec id. Each entry has the version record and the
 * build for this surface.
 *
 * @return array<string, array{record: array<string, mixed>, build: array<string, mixed>}>
 */
function servable_specs(): array {
	static $cache = array();
	$user_id = get_current_user_id();
	if ( isset( $cache[ $user_id ] ) ) {
		return $cache[ $user_id ];
	}
	$servable = array();
	$surface  = current_surface();
	if ( $surface && $user_id ) {
		$user  = wp_get_current_user();
		$specs = get_posts(
			array(
				'post_type'        => SPEC_POST_TYPE,
				'post_status'      => 'private',
				'numberposts'      => -1,
				'meta_key'         => '_graft_active_version', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'suppress_filters' => true,
			)
		);
		foreach ( $specs as $spec ) {
			$version = get_version_post( $spec->post_name, (int) get_post_meta( $spec->ID, '_graft_active_version', true ) );
			if ( ! $version ) {
				continue;
			}
			$record = version_record( $version );
			$build  = $record['builds'][ $surface['hash'] ]['build'] ?? null;
			// Never serve a build whose scopes the grant does not cover.
			$covered = is_array( $build ) && grant_covers( $record['grant'], $build['refs']['scopes'] ?? array() );
			if ( 'active' === $record['state'] && $covered && applies_to_user( $record, $user ) ) {
				$servable[ $spec->post_name ] = array(
					'record' => $record,
					'build'  => $build,
				);
			}
		}
	}
	$cache[ $user_id ] = $servable;
	return $servable;
}

/**
 * Granted scopes the current user can actually use: the grant intersected
 * with the WordPress capabilities each scope maps to.
 *
 * @param array<string, mixed> $record Version record.
 * @return array<string, bool>
 */
function usable_scopes( array $record ): array {
	$usable = array();
	$scopes = surface_scopes();
	foreach ( $record['grant']['scopes'] ?? array() as $scope ) {
		$caps             = $scopes[ $scope ]['host'] ?? array();
		$usable[ $scope ] = array() !== $caps && count( array_filter( $caps, 'current_user_can' ) ) === count( $caps );
	}
	return $usable;
}

/**
 * Specs rendered on this request; their builds go into the client config.
 *
 * @param string|null $spec_id Spec id to add.
 * @return array<string, true>
 */
function rendered_specs( ?string $spec_id = null ): array {
	static $rendered = array();
	if ( null !== $spec_id ) {
		$rendered[ $spec_id ] = true;
	}
	return $rendered;
}

/**
 * Markup for a mount point the client renders into.
 *
 * @param string               $spec_id Spec id.
 * @param array<string, mixed> $slot    Props the slot provides.
 * @param string               $tag     Element.
 * @return string
 */
function mount_point( string $spec_id, array $slot = array(), string $tag = 'div' ): string {
	rendered_specs( $spec_id );
	return sprintf(
		'<%1$s data-graft-mount data-graft-spec="%2$s" data-graft-slot="%3$s"></%1$s>',
		tag_escape( $tag ),
		esc_attr( $spec_id ),
		esc_attr( (string) wp_json_encode( (object) $slot ) )
	);
}

/**
 * Enqueues the client runtime with the config for the specs rendered on this
 * request. Runs in the admin footer, after every slot had its chance.
 */
function enqueue_runtime(): void {
	$rendered = rendered_specs();
	if ( ! $rendered ) {
		return;
	}
	$asset_file = dirname( __DIR__ ) . '/build/runtime.asset.php';
	if ( ! is_readable( $asset_file ) ) {
		return;
	}
	$asset = require $asset_file;
	wp_enqueue_script( 'graft-runtime', plugins_url( 'build/runtime.js', __DIR__ ), $asset['dependencies'], $asset['version'], true );
	wp_enqueue_style( 'wp-components' );

	$specs    = array();
	$servable = servable_specs();
	foreach ( array_keys( $rendered ) as $spec_id ) {
		if ( isset( $servable[ $spec_id ] ) ) {
			$specs[ $spec_id ] = array(
				'build'  => $servable[ $spec_id ]['build'],
				'scopes' => (object) usable_scopes( $servable[ $spec_id ]['record'] ),
			);
		}
	}
	wp_add_inline_script(
		'graft-runtime',
		'window.graftRuntime = ' . wp_json_encode( array( 'specs' => (object) $specs ), JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP ) . ';',
		'before'
	);
}

/**
 * Tells administrators about customizations that are not shown because the
 * host changed and no build for the new surface is ready.
 */
function surface_change_notice(): void {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$waiting = array();
	foreach ( list_specs() as $spec ) {
		foreach ( $spec['versions'] as $version ) {
			if ( in_array( $version['state'], array( 'upgrading', 'suspended', 'needs_approval' ), true ) && (int) $spec['active_version'] === $version['version'] ) {
				$waiting[] = sprintf( '%s (%s)', $spec['title'], str_replace( '_', ' ', $version['state'] ) );
			}
		}
	}
	if ( $waiting ) {
		printf(
			'<div class="notice notice-warning"><p>%s</p></div>',
			esc_html(
				sprintf(
					/* translators: %s: list of customizations. */
					__( 'These customizations are not shown until they are upgraded for this version of WordPress: %s', 'graft' ),
					implode( ', ', $waiting )
				)
			)
		);
	}
}

/**
 * Tools → Customizations: review and approve specs.
 */
function register_admin_screen(): void {
	$hook = add_management_page(
		__( 'Customizations', 'graft' ),
		__( 'Customizations', 'graft' ),
		'manage_options',
		'graft-customizations',
		static function (): void {
			printf( '<div class="wrap"><h1>%s</h1><div id="graft-admin"></div></div>', esc_html__( 'Customizations', 'graft' ) );
		}
	);
	add_action(
		'admin_enqueue_scripts',
		static function ( string $current ) use ( $hook ): void {
			if ( $current !== $hook ) {
				return;
			}
			$asset_file = dirname( __DIR__ ) . '/build/admin.asset.php';
			if ( ! is_readable( $asset_file ) ) {
				return;
			}
			$asset = require $asset_file;
			wp_enqueue_script( 'graft-admin', plugins_url( 'build/admin.js', __DIR__ ), $asset['dependencies'], $asset['version'], true );
			wp_enqueue_style( 'wp-components' );
			$surface = current_surface();
			wp_add_inline_script(
				'graft-admin',
				'window.graftAdmin = ' . wp_json_encode(
					array(
						'scopes'  => (object) array_map(
							static function ( array $scope ): string {
								return $scope['title'];
							},
							surface_scopes()
						),
						'surface' => $surface ? array(
							'hash'        => $surface['hash'],
							'hostVersion' => $surface['hostVersion'],
						) : null,
					),
					JSON_HEX_TAG | JSON_HEX_AMP
				) . ';',
				'before'
			);
		}
	);
}
