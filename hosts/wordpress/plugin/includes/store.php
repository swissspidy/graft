<?php
/**
 * Spec store: specs and their versions as private post types.
 *
 * A `graft_spec` post (post_name = spec id) holds who the spec applies to
 * and which version is active. Each `graft_spec_version` child post is one
 * immutable version: its source, manifest, grant, lifecycle state and the
 * builds for it keyed by surface hash. One site is one tenant.
 *
 * The manifest is parsed from the source by the TypeScript core before it
 * reaches the server (PHP has no YAML parser). It is authoritative for
 * enforcement: grants are approved from the manifest's permissions and the
 * build's computed scopes, never from the prose.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_Post;

const SPEC_POST_TYPE    = 'graft_spec';
const VERSION_POST_TYPE = 'graft_spec_version';

/**
 * Registers the post types.
 */
function register_post_types(): void {
	$args = array(
		'public'       => false,
		'show_ui'      => false,
		'show_in_rest' => false,
		'rewrite'      => false,
		'query_var'    => false,
		'supports'     => array( 'title' ),
	);
	register_post_type( SPEC_POST_TYPE, array_merge( $args, array( 'label' => __( 'Graft specs', 'graft' ) ) ) );
	register_post_type( VERSION_POST_TYPE, array_merge( $args, array( 'label' => __( 'Graft spec versions', 'graft' ) ) ) );
}

/**
 * Normalizes a spec file the same way the TypeScript core does before
 * hashing: no BOM, LF line endings, no trailing whitespace, one final
 * newline.
 *
 * @param string $source Spec file.
 * @return string
 */
function normalize_spec_source( string $source ): string {
	$source = preg_replace( '/^\x{FEFF}/u', '', $source );
	$source = str_replace( array( "\r\n", "\r" ), "\n", (string) $source );
	$lines  = array_map( 'rtrim', explode( "\n", $source ) );
	return rtrim( implode( "\n", $lines ) ) . "\n";
}

/**
 * Content hash of a spec file, matching hashSpec() in the core.
 *
 * @param string $source Spec file.
 * @return string
 */
function hash_spec( string $source ): string {
	return 'sha256:' . hash( 'sha256', normalize_spec_source( $source ) );
}

/**
 * Reads a JSON meta value.
 *
 * @param int    $post_id Post id.
 * @param string $key     Meta key.
 * @return mixed
 */
function get_json_meta( int $post_id, string $key ) {
	$value = get_post_meta( $post_id, $key, true );
	return is_string( $value ) && '' !== $value ? json_decode( $value, true ) : null;
}

/**
 * Writes a JSON meta value.
 *
 * @param int    $post_id Post id.
 * @param string $key     Meta key.
 * @param mixed  $value   Value.
 */
function set_json_meta( int $post_id, string $key, $value ): void {
	update_post_meta( $post_id, $key, wp_slash( (string) wp_json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) ) );
}

/**
 * The spec post for an id.
 *
 * @param string $spec_id Spec id.
 * @return WP_Post|null
 */
function get_spec_post( string $spec_id ): ?WP_Post {
	$posts = get_posts(
		array(
			'post_type'        => SPEC_POST_TYPE,
			'name'             => $spec_id,
			'post_status'      => 'private',
			'numberposts'      => 1,
			'suppress_filters' => true,
		)
	);
	return $posts[0] ?? null;
}

/**
 * The version post for a spec id and version number.
 *
 * @param string $spec_id Spec id.
 * @param int    $version Version number.
 * @return WP_Post|null
 */
function get_version_post( string $spec_id, int $version ): ?WP_Post {
	$spec = get_spec_post( $spec_id );
	if ( ! $spec ) {
		return null;
	}
	$posts = get_posts(
		array(
			'post_type'        => VERSION_POST_TYPE,
			'post_parent'      => $spec->ID,
			'post_status'      => 'private',
			'numberposts'      => 1,
			'meta_key'         => '_graft_version', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
			'meta_value'       => (string) $version, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
			'suppress_filters' => true,
		)
	);
	return $posts[0] ?? null;
}

/**
 * All versions of a spec, newest first.
 *
 * @param WP_Post $spec Spec post.
 * @return WP_Post[]
 */
function get_version_posts( WP_Post $spec ): array {
	return get_posts(
		array(
			'post_type'        => VERSION_POST_TYPE,
			'post_parent'      => $spec->ID,
			'post_status'      => 'private',
			'numberposts'      => -1,
			'orderby'          => 'meta_value_num',
			'meta_key'         => '_graft_version', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
			'order'            => 'DESC',
			'suppress_filters' => true,
		)
	);
}

/** Longest spec source accepted, in bytes. */
const MAX_SOURCE_LENGTH = 20000;

/** Per-user limits for people who are not administrators. */
const MAX_SPECS_PER_USER    = 10;
const MAX_VERSIONS_PER_SPEC = 25;

/**
 * Validates a mount (a spec manifest's or a build's) against its slot's
 * option schema, server side.
 *
 * @param mixed $mount Mount: { slot, ...options }.
 * @return true|WP_Error
 */
function validate_mount( $mount ) {
	$slots = surface_slots();
	$slot  = is_array( $mount ) ? (string) ( $mount['slot'] ?? '' ) : '';
	if ( ! isset( $slots[ $slot ] ) ) {
		return new WP_Error( 'graft_invalid_mount', __( 'Unknown slot.', 'graft' ), array( 'status' => 400 ) );
	}
	$options = $mount;
	unset( $options['slot'] );
	if ( isset( $slots[ $slot ]['options'] ) ) {
		$valid = rest_validate_value_from_schema( $options, $slots[ $slot ]['options'], 'mount' );
		if ( is_wp_error( $valid ) ) {
			return new WP_Error( 'graft_invalid_mount', $valid->get_error_message(), array( 'status' => 400 ) );
		}
	}
	return true;
}

/**
 * Every scope a build needs: the scopes it declares plus those the host's
 * capability map requires for each capability it calls. Computed on the
 * server so a build cannot understate what it needs.
 *
 * @param array<string, mixed> $build Build.
 * @return string[]
 */
function build_scopes( array $build ): array {
	$scopes = is_array( $build['refs']['scopes'] ?? null ) ? $build['refs']['scopes'] : array();
	$map    = surface_capability_map();
	foreach ( (array) ( $build['refs']['capabilities'] ?? array() ) as $capability ) {
		$scopes = array_merge( $scopes, $map[ $capability ]['scopes'] ?? array() );
	}
	return array_values( array_unique( $scopes ) );
}

/**
 * Validates a manifest against the current surface (phase two of spec
 * validation, done again server side because the manifest comes from the
 * client).
 *
 * @param mixed $manifest Manifest.
 * @return true|WP_Error
 */
function validate_manifest( $manifest ) {
	$error = static function ( string $message ) {
		return new WP_Error( 'graft_invalid_manifest', $message, array( 'status' => 400 ) );
	};
	if ( ! is_array( $manifest ) ) {
		return $error( __( 'The manifest must be an object.', 'graft' ) );
	}
	if ( 1 !== ( $manifest['graft'] ?? null ) ) {
		return $error( __( 'Unsupported spec format.', 'graft' ) );
	}
	if ( ! is_string( $manifest['id'] ?? null ) || ! preg_match( '/^[a-z0-9][a-z0-9-]{1,62}$/', $manifest['id'] ) ) {
		return $error( __( 'Invalid spec id.', 'graft' ) );
	}
	if ( 'wordpress' !== ( $manifest['host'] ?? null ) ) {
		return $error( __( 'The spec is not for WordPress.', 'graft' ) );
	}
	$mount = validate_mount( $manifest['mount'] ?? null );
	if ( is_wp_error( $mount ) ) {
		return $mount;
	}
	$scopes = surface_scopes();
	if ( ! isset( $manifest['permissions'] ) || ! is_array( $manifest['permissions'] ) ) {
		return $error( __( 'Missing permissions.', 'graft' ) );
	}
	foreach ( $manifest['permissions'] as $scope ) {
		if ( ! is_string( $scope ) || ! isset( $scopes[ $scope ] ) ) {
			return $error( __( 'Unknown permission scope.', 'graft' ) );
		}
	}
	$roles = array_keys( wp_roles()->roles );
	foreach ( $manifest['audience'] ?? array() as $audience ) {
		if ( ! in_array( $audience, $roles, true ) ) {
			return $error( __( 'Unknown audience.', 'graft' ) );
		}
	}
	return true;
}

/**
 * Stores a new version of a spec. Saving the same content as the latest
 * version returns that version instead of creating a new one.
 *
 * @param array<string, mixed> $args {
 *     @type string               $source   Spec file.
 *     @type array<string, mixed> $manifest Frontmatter as parsed by the core.
 *     @type string               $title    Spec title.
 *     @type array<string, mixed> $scope    { type: org|team|user, role?: string }. Default org.
 *     @type int                  $owner    Owner user id. Default current user.
 *     @type bool                 $system   Created by the plugin itself (managed customizations):
 *                                          no user limits apply. Never set from a request.
 * }
 * @return array<string, mixed>|WP_Error Version record.
 */
function create_version( array $args ) {
	$source   = (string) ( $args['source'] ?? '' );
	$manifest = $args['manifest'] ?? null;
	$valid    = validate_manifest( $manifest );
	if ( is_wp_error( $valid ) ) {
		return $valid;
	}
	$scope = $args['scope'] ?? array( 'type' => 'org' );
	if ( ! in_array( $scope['type'] ?? '', array( 'org', 'team', 'user' ), true ) || ( 'team' === $scope['type'] && ! isset( wp_roles()->roles[ $scope['role'] ?? '' ] ) ) ) {
		return new WP_Error( 'graft_invalid_scope', __( 'Invalid scope.', 'graft' ), array( 'status' => 400 ) );
	}
	if ( strlen( $source ) > MAX_SOURCE_LENGTH ) {
		return new WP_Error( 'graft_too_long', __( 'The spec is too long.', 'graft' ), array( 'status' => 400 ) );
	}
	$owner   = (int) ( $args['owner'] ?? get_current_user_id() );
	$spec_id = $manifest['id'];
	$hash    = hash_spec( $source );
	$admin   = ! empty( $args['system'] ) || current_user_can( 'manage_options' );

	$spec = get_spec_post( $spec_id );
	if ( $spec ) {
		// Only administrators may add versions to shared specs; people may
		// only add versions to their own personal ones. The stored scope
		// decides, never the scope in the request.
		$stored = get_json_meta( $spec->ID, '_graft_scope' );
		$mine   = 'user' === ( $stored['type'] ?? '' ) && (int) $spec->post_author === get_current_user_id();
		if ( ! $admin && ! $mine ) {
			return new WP_Error( 'graft_forbidden', __( 'You cannot change this customization.', 'graft' ), array( 'status' => 403 ) );
		}
		if ( ( $stored['type'] ?? 'org' ) !== $scope['type'] ) {
			return new WP_Error( 'graft_id_in_use', __( 'This id is already used by a customization with another scope.', 'graft' ), array( 'status' => 409 ) );
		}
		if ( ! $admin && count( get_version_posts( $spec ) ) >= MAX_VERSIONS_PER_SPEC ) {
			return new WP_Error( 'graft_limit', __( 'This customization has too many versions.', 'graft' ), array( 'status' => 429 ) );
		}
	} elseif ( ! $admin ) {
		$owned = get_posts(
			array(
				'post_type'        => SPEC_POST_TYPE,
				'post_status'      => 'private',
				'author'           => get_current_user_id(),
				'numberposts'      => MAX_SPECS_PER_USER,
				'fields'           => 'ids',
				'suppress_filters' => true,
			)
		);
		if ( count( $owned ) >= MAX_SPECS_PER_USER ) {
			return new WP_Error( 'graft_limit', __( 'You have too many customizations.', 'graft' ), array( 'status' => 429 ) );
		}
	}
	if ( ! $spec ) {
		$spec_post_id = wp_insert_post(
			array(
				'post_type'   => SPEC_POST_TYPE,
				'post_status' => 'private',
				'post_name'   => $spec_id,
				'post_title'  => (string) ( $args['title'] ?? $spec_id ),
				'post_author' => $owner,
			),
			true
		);
		if ( is_wp_error( $spec_post_id ) ) {
			return $spec_post_id;
		}
		$spec = get_post( $spec_post_id );
		set_json_meta( $spec->ID, '_graft_scope', $scope );
	}

	$versions = get_version_posts( $spec );
	$latest   = $versions[0] ?? null;
	if ( $latest && get_post_meta( $latest->ID, '_graft_hash', true ) === $hash ) {
		return version_record( $latest );
	}

	// A new version inherits the grant of the active one: grants never widen
	// silently, and unchanged permissions need no new approval.
	$active_version = (int) get_post_meta( $spec->ID, '_graft_active_version', true );
	$active         = $active_version ? get_version_post( $spec_id, $active_version ) : null;
	$grant          = $active ? get_json_meta( $active->ID, '_graft_grant' ) : null;

	$number     = $latest ? (int) get_post_meta( $latest->ID, '_graft_version', true ) + 1 : 1;
	$version_id = wp_insert_post(
		array(
			'post_type'    => VERSION_POST_TYPE,
			'post_status'  => 'private',
			'post_parent'  => $spec->ID,
			'post_title'   => (string) ( $args['title'] ?? $spec_id ),
			'post_content' => wp_slash( $source ),
			'post_author'  => $owner,
		),
		true
	);
	if ( is_wp_error( $version_id ) ) {
		return $version_id;
	}
	update_post_meta( $version_id, '_graft_version', $number );
	update_post_meta( $version_id, '_graft_hash', $hash );
	update_post_meta( $version_id, '_graft_state', lifecycle()['initial'] );
	set_json_meta( $version_id, '_graft_manifest', $manifest );
	set_json_meta( $version_id, '_graft_builds', (object) array() );
	if ( $grant ) {
		set_json_meta( $version_id, '_graft_grant', $grant );
	}
	return version_record( get_post( $version_id ) );
}

/**
 * Plain data for a version post.
 *
 * @param WP_Post $post Version post.
 * @return array<string, mixed>
 */
function version_record( WP_Post $post ): array {
	$spec   = get_post( $post->post_parent );
	$builds = get_json_meta( $post->ID, '_graft_builds' );
	return array(
		'spec_id'    => $spec ? $spec->post_name : '',
		'version'    => (int) get_post_meta( $post->ID, '_graft_version', true ),
		'title'      => $post->post_title,
		'hash'       => (string) get_post_meta( $post->ID, '_graft_hash', true ),
		'state'      => (string) get_post_meta( $post->ID, '_graft_state', true ),
		'unverified' => (bool) get_post_meta( $post->ID, '_graft_unverified', true ),
		'source'     => $post->post_content,
		'manifest'   => get_json_meta( $post->ID, '_graft_manifest' ),
		'grant'      => get_json_meta( $post->ID, '_graft_grant' ),
		'builds'     => is_array( $builds ) ? $builds : array(),
		'owner'      => (int) $post->post_author,
		'scope'      => $spec ? get_json_meta( $spec->ID, '_graft_scope' ) : null,
		'created'    => mysql_to_rfc3339( $post->post_date_gmt ),
	);
}

/**
 * Applies a lifecycle event to a version, with the side effects that belong
 * to it: activating a version supersedes the previously active one.
 *
 * @param WP_Post $version Version post.
 * @param string  $event   Event.
 * @return array<string, mixed>|WP_Error Updated record.
 */
function transition( WP_Post $version, string $event ) {
	$state = (string) get_post_meta( $version->ID, '_graft_state', true );
	$next  = next_state( $state, $event );
	if ( is_wp_error( $next ) ) {
		return $next;
	}
	update_post_meta( $version->ID, '_graft_state', $next );

	if ( 'active' === $next ) {
		$spec     = get_post( $version->post_parent );
		$previous = (int) get_post_meta( $spec->ID, '_graft_active_version', true );
		$number   = (int) get_post_meta( $version->ID, '_graft_version', true );
		if ( $previous && $previous !== $number ) {
			$old = get_version_post( $spec->post_name, $previous );
			if ( $old && 'active' === get_post_meta( $old->ID, '_graft_state', true ) ) {
				transition( $old, 'supersede' );
			}
		}
		update_post_meta( $spec->ID, '_graft_active_version', $number );
	} elseif ( 'archived' === $next ) {
		$spec   = get_post( $version->post_parent );
		$number = (int) get_post_meta( $version->ID, '_graft_version', true );
		if ( (int) get_post_meta( $spec->ID, '_graft_active_version', true ) === $number ) {
			delete_post_meta( $spec->ID, '_graft_active_version' );
		}
	}

	/**
	 * Fires after a spec version changes lifecycle state.
	 *
	 * @param string  $next    New state.
	 * @param string  $state   Previous state.
	 * @param string  $event   Event.
	 * @param WP_Post $version Version post.
	 */
	do_action( 'graft_spec_transition', $next, $state, $event, $version );

	return version_record( get_post( $version->ID ) );
}

/**
 * Whether a grant covers every scope in a list.
 *
 * @param array<string, mixed>|null $grant  Grant.
 * @param string[]                  $scopes Scopes.
 * @return bool
 */
function grant_covers( ?array $grant, array $scopes ): bool {
	$granted = is_array( $grant['scopes'] ?? null ) ? $grant['scopes'] : array();
	return array() === array_diff( $scopes, $granted );
}

/**
 * Attaches a build for one surface to a version and moves the version on:
 * verified builds activate when the grant covers them and otherwise wait for
 * approval.
 *
 * A build without a passing verification is stored but does not change the
 * state, unless GRAFT_ALLOW_UNVERIFIED_BUILDS is true (development only), in
 * which case the version is flagged as unverified.
 *
 * @param string               $spec_id      Spec id.
 * @param int                  $version      Version number.
 * @param array<string, mixed> $build        Build.
 * @param array<string, mixed> $verification { passed: bool, results?: array, runner?: string }.
 * @return array<string, mixed>|WP_Error Updated record.
 */
function attach_build( string $spec_id, int $version, array $build, ?array $verification ) {
	$post = get_version_post( $spec_id, $version );
	if ( ! $post ) {
		return new WP_Error( 'graft_not_found', __( 'Spec version not found.', 'graft' ), array( 'status' => 404 ) );
	}
	$record = version_record( $post );
	if ( ( $build['spec']['id'] ?? null ) !== $spec_id || ( $build['spec']['hash'] ?? null ) !== $record['hash'] ) {
		return new WP_Error( 'graft_build_mismatch', __( 'The build is for a different spec or version.', 'graft' ), array( 'status' => 400 ) );
	}
	$surface_hash = (string) ( $build['surface']['hash'] ?? '' );
	$snapshot     = surface_snapshot( $surface_hash );
	if ( ! $snapshot ) {
		return new WP_Error( 'graft_unknown_surface', __( 'The build targets a surface this plugin does not know.', 'graft' ), array( 'status' => 400 ) );
	}
	$slot       = (string) ( $build['mount']['slot'] ?? '' );
	$reanchored = 'reanchored' === ( $build['provenance']['strategy'] ?? null ) && isset( $snapshot['slots'][ $slot ] );
	// Validate the mount against the slot on this host. A build re-anchored
	// to a slot of a future surface is validated when that surface is live.
	if ( isset( surface_slots()[ $slot ] ) ) {
		$mount = validate_mount( $build['mount'] ?? null );
		if ( is_wp_error( $mount ) ) {
			return $mount;
		}
	}
	if ( $slot !== ( $record['manifest']['mount']['slot'] ?? null ) && ! $reanchored ) {
		return new WP_Error( 'graft_build_mismatch', __( 'The build mounts somewhere else than the spec.', 'graft' ), array( 'status' => 400 ) );
	}
	// An upgraded build may need scopes the spec never asked for (the host
	// moved a capability behind a new permission). It is stored, but only
	// served once an admin widens the grant.
	$scopes = build_scopes( $build );
	if ( array_diff( $scopes, $record['manifest']['permissions'] ) && 'active' !== $record['state'] && 'upgrading' !== $record['state'] ) {
		return new WP_Error( 'graft_build_scope', __( 'The build needs permissions the spec does not request.', 'graft' ), array( 'status' => 400 ) );
	}

	$verified = ! empty( $verification['passed'] );
	$allowed  = defined( 'GRAFT_ALLOW_UNVERIFIED_BUILDS' ) && GRAFT_ALLOW_UNVERIFIED_BUILDS;
	if ( 'active' === $record['state'] && ! $verified && ! $allowed ) {
		// Never replace what an active version serves (or will serve after an
		// upgrade) with something unverified.
		return new WP_Error( 'graft_unverified', __( 'Only verified builds can be attached to an active customization.', 'graft' ), array( 'status' => 400 ) );
	}

	$builds                  = $record['builds'];
	$builds[ $surface_hash ] = array(
		'build'        => $build,
		'verification' => $verification,
		'attached'     => gmdate( 'c' ),
	);
	set_json_meta( $post->ID, '_graft_builds', $builds );

	if ( ! $verified ) {
		if ( ! $allowed ) {
			return version_record( get_post( $post->ID ) );
		}
		update_post_meta( $post->ID, '_graft_unverified', 1 );
	}

	if ( 'upgrading' === $record['state'] ) {
		$current = current_surface();
		if ( $current && $current['hash'] === $surface_hash ) {
			return transition( $post, grant_covers( $record['grant'], $scopes ) ? 'upgraded' : 'upgrade_needs_grant' );
		}
		return version_record( get_post( $post->ID ) );
	}
	if ( 'draft' === $record['state'] ) {
		$result = transition( $post, 'submit' );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
	}
	if ( 'building' !== get_post_meta( $post->ID, '_graft_state', true ) ) {
		return version_record( get_post( $post->ID ) );
	}
	return transition( $post, grant_covers( $record['grant'], $scopes ) ? 'verified_within_grant' : 'verified_needs_grant' );
}

/**
 * Approves a version waiting for approval: the grant becomes a snapshot of
 * the permissions the spec requests.
 *
 * @param string          $spec_id  Spec id.
 * @param int             $version  Version number.
 * @param string|int|null $approver Who approves: a user id (default the current user), or `policy` for
 *                                  managed customizations.
 * @return array<string, mixed>|WP_Error Updated record.
 */
function approve_version( string $spec_id, int $version, $approver = null ) {
	$post = get_version_post( $spec_id, $version );
	if ( ! $post ) {
		return new WP_Error( 'graft_not_found', __( 'Spec version not found.', 'graft' ), array( 'status' => 404 ) );
	}
	$record = version_record( $post );
	if ( 'needs_approval' !== $record['state'] ) {
		return next_state( $record['state'], 'approve' );
	}
	// Grant what the spec requests, plus what the build for the current
	// surface needs (an upgrade may need a new scope).
	$current = current_surface();
	$build   = $current ? ( $record['builds'][ $current['hash'] ]['build'] ?? null ) : null;
	$needed  = is_array( $build ) ? build_scopes( $build ) : array();
	set_json_meta(
		$post->ID,
		'_graft_grant',
		array(
			'scopes'      => array_values( array_unique( array_merge( $record['manifest']['permissions'], $needed ) ) ),
			'approved_by' => $approver ?? get_current_user_id(),
			'approved_at' => gmdate( 'c' ),
		)
	);
	return transition( $post, 'approve' );
}

/**
 * Applies a plain lifecycle event (decline, archive, ...) to a version.
 *
 * @param string $spec_id Spec id.
 * @param int    $version Version number.
 * @param string $event   Event.
 * @return array<string, mixed>|WP_Error Updated record.
 */
function apply_event( string $spec_id, int $version, string $event ) {
	$post = get_version_post( $spec_id, $version );
	if ( ! $post ) {
		return new WP_Error( 'graft_not_found', __( 'Spec version not found.', 'graft' ), array( 'status' => 404 ) );
	}
	return transition( $post, $event );
}

/**
 * All specs with their versions.
 *
 * @return array<int, array<string, mixed>>
 */
function list_specs(): array {
	$specs = get_posts(
		array(
			'post_type'        => SPEC_POST_TYPE,
			'post_status'      => 'private',
			'numberposts'      => -1,
			'orderby'          => 'title',
			'order'            => 'ASC',
			'suppress_filters' => true,
		)
	);
	return array_map(
		static function ( WP_Post $spec ): array {
			return array(
				'spec_id'        => $spec->post_name,
				'title'          => $spec->post_title,
				'scope'          => get_json_meta( $spec->ID, '_graft_scope' ),
				'owner'          => (int) $spec->post_author,
				'active_version' => (int) get_post_meta( $spec->ID, '_graft_active_version', true ) ?: null,
				'managed_by'     => managed_by( $spec->post_name ),
				'versions'       => array_map( __NAMESPACE__ . '\version_record', get_version_posts( $spec ) ),
			);
		},
		$specs
	);
}

/**
 * Reacts to the host changing surface (a WordPress update, a plugin that
 * filters the surface). Active versions with a build prepared for the new
 * surface keep serving; those whose build needs a wider grant wait for
 * approval; the rest go to upgrading and are not served until a build for
 * the new surface is attached. Runs once per change.
 */
function check_surface_change(): void {
	$current = current_surface();
	$hash    = $current['hash'] ?? 'unknown';
	$last    = get_option( 'graft_surface_hash' );
	if ( $last === $hash ) {
		return;
	}
	update_option( 'graft_surface_hash', $hash );
	if ( false === $last ) {
		return;
	}
	foreach ( list_specs() as $spec ) {
		if ( ! $spec['active_version'] ) {
			continue;
		}
		$post   = get_version_post( $spec['spec_id'], (int) $spec['active_version'] );
		$record = $post ? version_record( $post ) : null;
		if ( ! $record || ! in_array( $record['state'], array( 'active', 'upgrading', 'suspended' ), true ) ) {
			continue;
		}
		$ready = $record['builds'][ $hash ] ?? null;
		$ready = $ready && ! empty( $ready['verification']['passed'] ) ? $ready['build'] : null;
		if ( 'active' === $record['state'] ) {
			if ( $ready && grant_covers( $record['grant'], build_scopes( $ready ) ) ) {
				continue;
			}
			transition( $post, 'host_changed' );
		} elseif ( 'suspended' === $record['state'] ) {
			transition( $post, 'host_changed' );
		}
		if ( $ready ) {
			transition( $post, grant_covers( $record['grant'], build_scopes( $ready ) ) ? 'upgraded' : 'upgrade_needs_grant' );
		}
	}
}
