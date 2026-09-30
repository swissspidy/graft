<?php
/**
 * REST API: spec management and the capability gateway.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

const REST_NAMESPACE = 'graft/v1';

/**
 * Registers the routes.
 */
function register_routes(): void {
	$manage = static function (): bool {
		return current_user_can( 'manage_options' );
	};
	$version_args = array(
		'spec_id' => array(
			'type'    => 'string',
			'pattern' => '^[a-z0-9][a-z0-9-]{1,62}$',
		),
		'version' => array(
			'type'    => 'integer',
			'minimum' => 1,
		),
	);

	register_rest_route(
		REST_NAMESPACE,
		'/specs',
		array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => static function (): WP_REST_Response {
					return new WP_REST_Response( list_specs() );
				},
				'permission_callback' => $manage,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => __NAMESPACE__ . '\rest_create_version',
				'permission_callback' => static function ( WP_REST_Request $request ): bool {
					$scope = $request['scope']['type'] ?? 'org';
					return 'user' === $scope ? current_user_can( 'edit_posts' ) : current_user_can( 'manage_options' );
				},
				'args'                => array(
					'source'   => array(
						'type'     => 'string',
						'required' => true,
					),
					'manifest' => array(
						'type'     => 'object',
						'required' => true,
					),
					'title'    => array( 'type' => 'string' ),
					'scope'    => array( 'type' => 'object' ),
				),
			),
		)
	);

	register_rest_route(
		REST_NAMESPACE,
		'/audit',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => static fn() => new WP_REST_Response( audit_log() ),
			'permission_callback' => $manage,
		)
	);

	register_rest_route(
		REST_NAMESPACE,
		'/surface',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => static function () {
				$surface = current_surface();
				return new WP_REST_Response(
					array(
						'hash'        => $surface['hash'] ?? null,
						'hostVersion' => $GLOBALS['wp_version'],
						'fingerprint' => host_fingerprint(),
					)
				);
			},
			'permission_callback' => $manage,
		)
	);

	// The host half of this site's surface, for assembling a site surface in
	// the browser (see store_site_surface()).
	register_rest_route(
		REST_NAMESPACE,
		'/host-surface',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => static function () {
				$dump                = host_surface();
				$dump['fingerprint'] = host_fingerprint( $dump );
				return new WP_REST_Response( $dump );
			},
			'permission_callback' => $manage,
		)
	);

	register_rest_route(
		REST_NAMESPACE,
		'/surfaces',
		array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => static function () {
					return new WP_REST_Response( site_surfaces() );
				},
				'permission_callback' => $manage,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => static function ( WP_REST_Request $request ) {
					$stored = store_site_surface( $request['surface'] );
					if ( is_wp_error( $stored ) ) {
						return $stored;
					}
					check_surface_change();
					return new WP_REST_Response( array( 'hash' => $stored['hash'] ), 201 );
				},
				'permission_callback' => $manage,
				'args'                => array(
					'surface' => array(
						'type'     => 'object',
						'required' => true,
					),
				),
			),
		)
	);

	register_rest_route(
		REST_NAMESPACE,
		'/surfaces/(?P<hash>sha256:[0-9a-f]{64})',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => static function ( WP_REST_Request $request ) {
				$surface = surface_snapshot( (string) $request['hash'] );
				return $surface ? new WP_REST_Response( $surface ) : new WP_Error( 'graft_unknown_surface', __( 'No such surface.', 'graft' ), array( 'status' => 404 ) );
			},
			'permission_callback' => $manage,
		)
	);

	register_rest_route(
		REST_NAMESPACE,
		'/specs/(?P<spec_id>[a-z0-9-]+)/versions/(?P<version>\d+)/builds',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => static function ( WP_REST_Request $request ) {
				$build = $request['build'];
				if ( ! is_array( $build ) ) {
					return new WP_Error( 'graft_invalid_build', __( 'Missing build.', 'graft' ), array( 'status' => 400 ) );
				}
				$verification = is_array( $request['verification'] ) ? $request['verification'] : null;
				return rest_ensure_response( attach_build( $request['spec_id'], (int) $request['version'], $build, $verification ) );
			},
			'permission_callback' => $manage,
			'args'                => array_merge(
				$version_args,
				array(
					'build'        => array(
						'type'     => 'object',
						'required' => true,
					),
					'verification' => array( 'type' => array( 'object', 'null' ) ),
				)
			),
		)
	);

	foreach ( array( 'approve', 'decline', 'archive', 'upgrade_failed', 'retry' ) as $event ) {
		register_rest_route(
			REST_NAMESPACE,
			'/specs/(?P<spec_id>[a-z0-9-]+)/versions/(?P<version>\d+)/' . $event,
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => static function ( WP_REST_Request $request ) use ( $event ) {
					$allowed = policy_allows_changing( $request['spec_id'] );
					if ( is_wp_error( $allowed ) ) {
						return $allowed;
					}
					if ( 'approve' === $event ) {
						$allowed = policy_allows_version( $request['spec_id'], (int) $request['version'] );
						if ( is_wp_error( $allowed ) ) {
							return $allowed;
						}
					}
					$result = 'approve' === $event
						? approve_version( $request['spec_id'], (int) $request['version'] )
						: apply_event( $request['spec_id'], (int) $request['version'], $event );
					return rest_ensure_response( $result );
				},
				'permission_callback' => $manage,
				'args'                => $version_args,
			)
		);
	}

	register_rest_route(
		REST_NAMESPACE,
		'/call',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => __NAMESPACE__ . '\rest_call',
			'permission_callback' => 'is_user_logged_in',
			'args'                => array(
				'spec'       => array(
					'type'     => 'string',
					'required' => true,
				),
				'capability' => array(
					'type'     => 'string',
					'required' => true,
				),
				'input'      => array(
					'type' => array( 'object', 'array', 'string', 'number', 'integer', 'boolean', 'null' ),
				),
			),
		)
	);
}

/**
 * POST /specs: stores a new spec version.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function rest_create_version( WP_REST_Request $request ) {
	$manifest = is_array( $request['manifest'] ) ? $request['manifest'] : array();
	foreach ( array( policy_allows_authoring(), policy_allows_manifest( $manifest ), policy_allows_changing( (string) ( $manifest['id'] ?? '' ) ) ) as $allowed ) {
		if ( is_wp_error( $allowed ) ) {
			return $allowed;
		}
	}
	$args = array(
		'source'   => $request['source'],
		'manifest' => $request['manifest'],
		'title'    => $request['title'] ?? null,
		'scope'    => $request['scope'] ?? array( 'type' => 'org' ),
	);
	$record = create_version( array_filter( $args, static fn( $value ) => null !== $value ) );
	if ( is_wp_error( $record ) ) {
		return $record;
	}
	return new WP_REST_Response( $record, 201 );
}

/**
 * The capability gateway. Every call a rendered build makes comes through
 * here and is checked, in order: the spec serves the current user, the
 * capability is one the build uses, and the approved grant covers the
 * capability's scopes. Only then does the ability run, with its own
 * permission check on top.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function rest_call( WP_REST_Request $request ) {
	$spec_id    = (string) $request['spec'];
	$capability = (string) $request['capability'];
	$servable   = servable_specs();
	if ( ! isset( $servable[ $spec_id ] ) ) {
		return audit_refusal( $spec_id, $capability, new WP_Error( 'graft_spec_unavailable', __( 'This customization is not available to you.', 'graft' ), array( 'status' => 403 ) ) );
	}
	$record = $servable[ $spec_id ]['record'];
	$build  = $servable[ $spec_id ]['build'];
	if ( ! in_array( $capability, $build['refs']['capabilities'] ?? array(), true ) ) {
		return audit_refusal( $spec_id, $capability, new WP_Error( 'graft_capability_not_in_build', __( 'This customization does not use that capability.', 'graft' ), array( 'status' => 403 ) ) );
	}
	$map = surface_capability_map();
	if ( ! isset( $map[ $capability ] ) || ! grant_covers( $record['grant'], $map[ $capability ]['scopes'] ) ) {
		return audit_refusal( $spec_id, $capability, new WP_Error( 'graft_not_granted', __( 'This customization has not been granted that permission.', 'graft' ), array( 'status' => 403 ) ) );
	}
	// A policy tightened after approval applies at once; the maintainer's own customizations are exempt.
	$allowed = null === managed_by( $spec_id ) ? policy_allows_scopes( $map[ $capability ]['scopes'] ) : true;
	if ( is_wp_error( $allowed ) ) {
		return audit_refusal( $spec_id, $capability, $allowed );
	}
	$ability = wp_get_ability( $map[ $capability ]['ability'] );
	if ( ! $ability ) {
		return new WP_Error( 'graft_capability_unavailable', __( 'That capability is not available on this site.', 'graft' ), array( 'status' => 501 ) );
	}
	$input  = $request->has_param( 'input' ) ? $request['input'] : null;
	$result = $ability->execute( $input );
	if ( is_wp_error( $result ) ) {
		$status = 'ability_invalid_permissions' === $result->get_error_code() ? 403 : 400;
		$result->add_data( array( 'status' => $status ) );
		return $result;
	}
	return new WP_REST_Response( $result );
}

/**
 * Records a call the gateway refused: a customization asked for something
 * it did not declare, or was not granted. Keeps the latest 100 refusals for
 * administrators (GET graft/v1/audit) and fires graft_gateway_refused for
 * site logging.
 *
 * @param string   $spec_id    Spec the call named.
 * @param string   $capability Capability it asked for.
 * @param WP_Error $error      The refusal.
 * @return WP_Error The same refusal.
 */
function audit_refusal( string $spec_id, string $capability, WP_Error $error ): WP_Error {
	$entry   = array(
		'time'       => gmdate( 'c' ),
		'user'       => get_current_user_id(),
		'spec'       => $spec_id,
		'capability' => $capability,
		'code'       => $error->get_error_code(),
	);
	$log     = audit_log();
	$log[]   = $entry;
	$trimmed = array_slice( $log, -100 );
	update_option( 'graft_audit_log', $trimmed, false );
	/**
	 * Fires when the capability gateway refuses a call.
	 *
	 * @param array<string, mixed> $entry The refusal: time, user, spec, capability, code.
	 */
	do_action( 'graft_gateway_refused', $entry );
	return $error;
}

/**
 * The gateway's latest refusals, oldest first.
 *
 * @return array<int, array<string, mixed>>
 */
function audit_log(): array {
	$log = get_option( 'graft_audit_log', array() );
	return is_array( $log ) ? array_values( $log ) : array();
}
