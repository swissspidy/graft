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
			$covered = is_array( $build ) && grant_covers( $record['grant'], build_scopes( $build ) );
			// Nor one with code where this surface runs none.
			$covered = $covered && ( ! isset( $build['code'] ) || isset( $surface['functions'] ) );
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
 * with the WordPress capabilities each scope maps to, and with the site's
 * policy (see policy.php).
 *
 * @param array<string, mixed> $record Version record.
 * @return array<string, bool>
 */
function usable_scopes( array $record ): array {
	$usable  = array();
	$scopes  = surface_scopes();
	$managed = null !== managed_by( (string) ( $record['spec_id'] ?? '' ) );
	foreach ( $record['grant']['scopes'] ?? array() as $scope ) {
		$caps             = $scopes[ $scope ]['host'] ?? array();
		$usable[ $scope ] = array() !== $caps && count( array_filter( $caps, 'current_user_can' ) ) === count( $caps )
			// The policy as it is now, not as it was when the grant was approved.
			&& ( $managed || true === policy_allows_scopes( array( $scope ) ) );
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
	$asset  = require $asset_file;
	$editor = editor_runtime_config();
	// In the block editor, panels register with the editor's own plugin API.
	$deps = $editor ? array_merge( $asset['dependencies'], array( 'wp-plugins', 'wp-editor', 'wp-data' ) ) : $asset['dependencies'];
	wp_enqueue_script( 'graft-runtime', plugins_url( 'build/runtime.js', __DIR__ ), $deps, $asset['version'], true );
	wp_enqueue_style( 'wp-components' );

	$specs     = array();
	$servable  = servable_specs();
	$with_code = false;
	foreach ( array_keys( $rendered ) as $spec_id ) {
		if ( isset( $servable[ $spec_id ] ) ) {
			$specs[ $spec_id ] = array(
				'build'  => $servable[ $spec_id ]['build'],
				'scopes' => (object) usable_scopes( $servable[ $spec_id ]['record'] ),
			);
			$with_code = $with_code || isset( $servable[ $spec_id ]['build']['code'] );
		}
	}
	$config  = array( 'specs' => (object) $specs );
	$surface = current_surface();
	if ( $editor ) {
		// Reads may run while the editor has unsaved changes; everything
		// else waits for a save (see editorGuard in the client).
		$editor['reads']  = array_keys(
			array_filter(
				$surface['capabilities'] ?? array(),
				static function ( $capability ): bool {
					return 'read' === ( $capability['kind'] ?? '' );
				}
			)
		);
		$config['editor'] = $editor;
	}
	// Only screens with code learn where the functions worker is; the page
	// starts it (and fetches QuickJS) on the first function call.
	if ( $with_code && isset( $surface['functions']['limits'] ) ) {
		$config['functions'] = array(
			'worker' => plugins_url( 'build/functions-worker.js', __DIR__ ),
			'wasm'   => plugins_url( 'build/quickjs.wasm', __DIR__ ),
			'limits' => $surface['functions']['limits'],
		);
		if ( isset( $surface['functions']['widgets'] ) ) {
			$config['functions']['widgets'] = $surface['functions']['widgets'];
		}
	}
	wp_add_inline_script(
		'graft-runtime',
		'window.graftRuntime = ' . wp_json_encode( $config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP ) . ';',
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
	// Runs on every admin page: read only titles and states, not versions.
	$waiting = array();
	$specs   = get_posts(
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
		$state   = $version ? (string) get_post_meta( $version->ID, '_graft_state', true ) : '';
		if ( in_array( $state, array( 'upgrading', 'suspended', 'needs_approval' ), true ) ) {
			$waiting[] = sprintf( '%s (%s)', $spec->post_title, str_replace( '_', ' ', $state ) );
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
 * The policy as the admin screen shows it: who maintains the site, and
 * what their customizations may do, in plain language.
 *
 * @return array<string, mixed>
 */
function admin_policy(): array {
	$policy = policy();
	$slots  = surface_slots();
	$scopes = surface_scopes();
	return array(
		'managedBy' => $policy['managed_by'],
		'contact'   => $policy['contact'],
		'authoring' => $policy['authoring'],
		'slots'     => null === $policy['slots'] ? null : array_values(
			array_map(
				static function ( string $slot ) use ( $slots ): string {
					return (string) ( $slots[ $slot ]['title'] ?? $slot );
				},
				$policy['slots']
			)
		),
		'scopes'    => null === $policy['scopes'] ? null : array_values(
			array_map(
				static function ( string $scope ) use ( $scopes ): string {
					return (string) ( $scopes[ $scope ]['title'] ?? $scope );
				},
				$policy['scopes']
			)
		),
	);
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
						// The whole snapshot: the editor validates and compiles against it.
						'surface'             => $surface,
						'policy'              => admin_policy(),
						// QuickJS, for verifying builds with code in the browser.
						'quickjsWasm'         => plugins_url( 'build/quickjs.wasm', __DIR__ ),
						/**
						 * Filters whether wp-admin verifies builds in WordPress Playground
						 * in the admin's browser (needs access to playground.wordpress.net).
						 * GRAFT_BROWSER_VERIFICATION overrides the default.
						 *
						 * @param bool $enabled Default true.
						 */
						'browserVerification' => (bool) apply_filters( 'graft_browser_verification', defined( 'GRAFT_BROWSER_VERIFICATION' ) ? (bool) GRAFT_BROWSER_VERIFICATION : true ),
					),
					JSON_HEX_TAG | JSON_HEX_AMP
				) . ';',
				'before'
			);
		}
	);
}
