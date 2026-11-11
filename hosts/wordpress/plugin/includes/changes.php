<?php
/**
 * What happened to customizations and why one is not showing: safe mode,
 * the change log, and the reason a version is not served.
 *
 * @package Graft
 */

namespace Graft;

use WP_Post;
use WP_REST_Response;
use WP_REST_Server;

defined( 'ABSPATH' ) || exit;

const CHANGE_LOG_OPTION = 'graft_change_log';
const CHANGE_LOG_LENGTH = 500;

/**
 * Whether the site serves no customization and runs no trigger: the way
 * back when one of them breaks wp-admin. Tools → Customizations still
 * works, so the customization can be archived there.
 *
 * @return bool
 */
function safe_mode(): bool {
	/**
	 * Filters whether Graft is in safe mode. `define( 'GRAFT_SAFE_MODE', true )`
	 * in wp-config.php turns it on.
	 *
	 * @param bool $on Whether the constant is set.
	 */
	return (bool) apply_filters( 'graft_safe_mode', defined( 'GRAFT_SAFE_MODE' ) && GRAFT_SAFE_MODE );
}

/**
 * Why a version is not served to anyone on this site, or null when it is
 * (to the users it applies to). servable_specs() and trigger_specs() serve
 * exactly the versions this returns null for.
 *
 * @param array<string, mixed>      $record  Version record.
 * @param array<string, mixed>|null $surface The site's current surface (default: looked up).
 * @return array{code: string, message: string}|null
 */
function not_served_reason( array $record, ?array $surface = null ): ?array {
	$surface = $surface ?? current_surface();
	$reason  = static fn( string $code, string $message ): array => array(
		'code'    => $code,
		'message' => $message,
	);
	if ( safe_mode() ) {
		return $reason( 'safe_mode', __( 'Safe mode is on (GRAFT_SAFE_MODE): no customization is shown.', 'graft' ) );
	}
	if ( 'active' !== $record['state'] ) {
		/* translators: %s: lifecycle state, e.g. needs_approval. */
		return $reason( 'not_active', sprintf( __( 'It is not active (%s).', 'graft' ), str_replace( '_', ' ', (string) $record['state'] ) ) );
	}
	if ( ! $surface ) {
		return $reason( 'no_surface', __( 'This version of WordPress, or what this site adds to it, is not one the plugin has a surface for.', 'graft' ) );
	}
	$build = $record['builds'][ $surface['hash'] ]['build'] ?? null;
	if ( ! is_array( $build ) ) {
		return $reason( 'no_build', __( 'It has no build for this site as it is now. It was built for an earlier version of the site.', 'graft' ) );
	}
	if ( ! build_is_verified( $record, $surface['hash'] ) ) {
		return $reason( 'unverified', __( 'Its build for this site has not passed its checks.', 'graft' ) );
	}
	if ( ! grant_covers( $record['grant'], build_scopes( $build ) ) ) {
		return $reason( 'not_granted', __( 'Its build needs permissions that were not approved.', 'graft' ) );
	}
	return null;
}

/**
 * Appends to the change log: who did what to which customization, when.
 * The latest CHANGE_LOG_LENGTH entries are kept.
 *
 * @param string               $what    What happened: `created`, `build_attached`, or a lifecycle event.
 * @param string               $spec_id Spec id.
 * @param int                  $version Version number.
 * @param array<string, mixed> $details More about it.
 */
function record_change( string $what, string $spec_id, int $version, array $details = array() ): void {
	$entry = array_merge(
		array(
			'time'    => gmdate( 'c' ),
			// 0 when no one is signed in: the site's own code (a managed bundle, an upgrade on a surface change).
			'user'    => get_current_user_id(),
			'what'    => $what,
			'spec'    => $spec_id,
			'version' => $version,
		),
		$details
	);
	$log   = change_log();
	$log[] = $entry;
	update_option( CHANGE_LOG_OPTION, array_slice( $log, -CHANGE_LOG_LENGTH ), false );
	/**
	 * Fires when a customization changes: for a log that outlives this one.
	 *
	 * @param array<string, mixed> $entry time, user, what, spec, version, and details.
	 */
	do_action( 'graft_change_recorded', $entry );
}

/**
 * The change log, oldest first.
 *
 * @return array<int, array<string, mixed>>
 */
function change_log(): array {
	$log = get_option( CHANGE_LOG_OPTION, array() );
	return is_array( $log ) ? array_values( $log ) : array();
}

add_action(
	'graft_spec_transition',
	static function ( string $next, string $state, string $event, WP_Post $version ): void {
		$record  = version_record( $version );
		$details = array(
			'from' => $state,
			'to'   => $next,
		);
		if ( 'approve' === $event ) {
			// What was approved, as it stood then: the grant is replaced by the next approval.
			$details['granted']     = $record['grant']['scopes'] ?? array();
			$details['approved_by'] = $record['grant']['approved_by'] ?? null;
			if ( ! empty( $record['grant']['triggers'] ) ) {
				$details['granted_triggers'] = $record['grant']['triggers'];
			}
		}
		record_change( $event, $record['spec_id'], $record['version'], $details );
	},
	10,
	4
);

add_action(
	'rest_api_init',
	static function (): void {
		register_rest_route(
			REST_NAMESPACE,
			'/changes',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => static function () {
					$names = array();
					return new WP_REST_Response(
						array_map(
							static function ( array $entry ) use ( &$names ): array {
								$id = (int) ( $entry['user'] ?? 0 );
								if ( ! isset( $names[ $id ] ) ) {
									$user         = $id ? get_userdata( $id ) : false;
									$names[ $id ] = $user ? $user->display_name : '';
								}
								return $entry + array( 'user_name' => $names[ $id ] );
							},
							array_reverse( change_log() )
						)
					);
				},
				'permission_callback' => static fn() => current_user_can( 'manage_options' ),
			)
		);
	}
);
