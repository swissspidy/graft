<?php
/**
 * What the people who maintain a site's code (typically the agency that
 * built it) allow customizations to do, and the customizations they manage
 * themselves.
 *
 * The policy is code (the `graft_policy` filter), never an option, so a
 * site's administrators cannot loosen it from wp-admin. It limits what they
 * may build and approve; it never widens what WordPress lets anyone do.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;

/**
 * The site's policy.
 *
 * @return array{managed_by: ?string, contact: ?string, authoring: bool, slots: ?string[], scopes: ?string[], managed: ?string}
 */
function policy(): array {
	$defaults = array(
		'managed_by' => null,
		'contact'    => null,
		'authoring'  => true,
		'slots'      => null,
		'scopes'     => null,
		'managed'    => null,
	);

	/**
	 * Filters what customizations may do on this site.
	 *
	 * @param array $policy {
	 *     @type string|null   $managed_by Who maintains the site, shown to its administrators (e.g. an agency).
	 *     @type string|null   $contact    Where to ask for more (a URL or an email address).
	 *     @type bool          $authoring  Whether the site's own people may write and build customizations. Default true.
	 *     @type string[]|null $slots      Slots their customizations may use; null for all.
	 *     @type string[]|null $scopes     Permission scopes their administrators may approve; null for all.
	 *     @type string|null   $managed    Directory of customization bundles the maintainer ships and manages
	 *                                     (graft bundle): installed, updated and removed with the code.
	 * }
	 */
	$policy = apply_filters( 'graft_policy', $defaults );
	$policy = is_array( $policy ) ? array_merge( $defaults, $policy ) : $defaults;

	$list = static function ( $value ): ?array {
		return is_array( $value ) ? array_values( array_map( 'strval', $value ) ) : null;
	};
	return array(
		'managed_by' => is_string( $policy['managed_by'] ) && '' !== $policy['managed_by'] ? $policy['managed_by'] : null,
		'contact'    => is_string( $policy['contact'] ) && '' !== $policy['contact'] ? $policy['contact'] : null,
		'authoring'  => (bool) $policy['authoring'],
		'slots'      => $list( $policy['slots'] ),
		'scopes'     => $list( $policy['scopes'] ),
		'managed'    => is_string( $policy['managed'] ) && '' !== $policy['managed'] ? $policy['managed'] : null,
	);
}

/**
 * Who the policy says maintains the site, for messages.
 *
 * @return string
 */
function maintainer(): string {
	return policy()['managed_by'] ?? __( 'Whoever maintains this site', 'graft' );
}

/**
 * Whether the site's own people may write customizations at all.
 *
 * @return true|WP_Error
 */
function policy_allows_authoring() {
	if ( policy()['authoring'] ) {
		return true;
	}
	return new WP_Error(
		'graft_policy_authoring',
		/* translators: %s: who maintains the site. */
		sprintf( __( '%s does not allow new customizations on this site.', 'graft' ), maintainer() ),
		array( 'status' => 403 )
	);
}

/**
 * Whether the policy allows a manifest's slot and permissions.
 *
 * @param array<string, mixed> $manifest Manifest.
 * @return true|WP_Error
 */
function policy_allows_manifest( array $manifest ) {
	$policy = policy();
	$slot   = (string) ( $manifest['mount']['slot'] ?? '' );
	if ( null !== $policy['slots'] && ! in_array( $slot, $policy['slots'], true ) ) {
		$title = surface_slots()[ $slot ]['title'] ?? $slot;
		return new WP_Error(
			'graft_policy_slot',
			/* translators: 1: who maintains the site, 2: slot title. */
			sprintf( __( '%1$s does not allow customizations in this place: %2$s.', 'graft' ), maintainer(), $title ),
			array( 'status' => 403 )
		);
	}
	return policy_allows_scopes( (array) ( $manifest['permissions'] ?? array() ) );
}

/**
 * Whether the policy lets administrators grant these scopes.
 *
 * @param string[] $scopes Scopes.
 * @return true|WP_Error
 */
function policy_allows_scopes( array $scopes ) {
	$allowed = policy()['scopes'];
	if ( null === $allowed ) {
		return true;
	}
	$refused = array_diff( $scopes, $allowed );
	if ( array() === $refused ) {
		return true;
	}
	$titles = array_map(
		static function ( string $scope ): string {
			return surface_scopes()[ $scope ]['title'] ?? $scope;
		},
		array_values( $refused )
	);
	return new WP_Error(
		'graft_policy_scope',
		/* translators: 1: who maintains the site, 2: list of permissions. */
		sprintf( __( '%1$s does not allow customizations to: %2$s.', 'graft' ), maintainer(), implode( '; ', $titles ) ),
		array( 'status' => 403 )
	);
}

/**
 * Whether the policy lets an administrator approve a version: what it
 * requests, and what its build for this site needs.
 *
 * @param string $spec_id Spec id.
 * @param int    $version Version number.
 * @return true|WP_Error
 */
function policy_allows_version( string $spec_id, int $version ) {
	$post = get_version_post( $spec_id, $version );
	if ( ! $post ) {
		return true;
	}
	$record  = version_record( $post );
	$current = current_surface();
	$build   = $current ? ( $record['builds'][ $current['hash'] ]['build'] ?? null ) : null;
	$allowed = policy_allows_manifest( (array) $record['manifest'] );
	if ( is_wp_error( $allowed ) || ! is_array( $build ) ) {
		return $allowed;
	}
	return policy_allows_scopes( build_scopes( $build ) );
}

/**
 * Who manages a spec, when its maintainer ships it (see sync_managed()).
 *
 * @param string $spec_id Spec id.
 * @return string|null
 */
function managed_by( string $spec_id ): ?string {
	$spec    = get_spec_post( $spec_id );
	$managed = $spec ? get_json_meta( $spec->ID, '_graft_managed' ) : null;
	return is_array( $managed ) ? (string) ( $managed['by'] ?? maintainer() ) : null;
}

/**
 * Refuses changes to a managed spec from wp-admin.
 *
 * @param string $spec_id Spec id.
 * @return true|WP_Error
 */
function policy_allows_changing( string $spec_id ) {
	$by = managed_by( $spec_id );
	if ( null === $by ) {
		return true;
	}
	return new WP_Error(
		'graft_managed',
		/* translators: %s: who manages the customization. */
		sprintf( __( '%s manages this customization; ask them to change it.', 'graft' ), $by ),
		array( 'status' => 403 )
	);
}

/**
 * The bundle files in the managed directory, with their size and time.
 *
 * @return array<string, string> Path => "size:mtime".
 */
function managed_files(): array {
	$dir = policy()['managed'];
	if ( null === $dir || ! is_dir( $dir ) ) {
		return array();
	}
	$files = array();
	foreach ( glob( trailingslashit( $dir ) . '*.json' ) ?: array() as $file ) {
		$files[ $file ] = filesize( $file ) . ':' . filemtime( $file );
	}
	ksort( $files );
	return $files;
}

/**
 * Customization bundles in the managed directory, keyed by file name.
 *
 * A bundle (written by `graft bundle`) is one customization as its
 * maintainer verified it: `{ graft: 1, kind: "customization", title,
 * spec: { source, manifest, hash }, builds: [{ build, verification }] }`.
 *
 * @return array<string, array<string, mixed>>
 */
function managed_bundles(): array {
	$bundles = array();
	foreach ( array_keys( managed_files() ) as $file ) {
		$bundle = json_decode( (string) file_get_contents( $file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
		if ( is_array( $bundle ) && 1 === ( $bundle['graft'] ?? null ) && 'customization' === ( $bundle['kind'] ?? null ) ) {
			$bundles[ basename( $file ) ] = $bundle;
		}
	}
	ksort( $bundles );
	return $bundles;
}

/**
 * Brings the managed customizations in line with the bundles the
 * maintainer ships: new ones are installed, changed ones get a new
 * version, and those whose bundle is gone are archived. The maintainer's
 * verification of each build is trusted (it ships with the code), and so
 * is its grant: the policy approves what the bundle requests.
 *
 * Runs when the bundles change (a digest of the directory is kept).
 *
 * @param bool $force Sync even when nothing seems to have changed.
 * @return array<string, string> What happened, by bundle file.
 */
function sync_managed( bool $force = false ): array {
	$digest = md5( (string) wp_json_encode( array( managed_files(), policy()['managed_by'], current_surface()['hash'] ?? null ) ) );
	if ( ! $force && get_option( 'graft_managed_digest' ) === $digest ) {
		return array();
	}
	update_option( 'graft_managed_digest', $digest, false );
	$bundles = managed_bundles();

	$report = array();
	$seen   = array();
	foreach ( $bundles as $file => $bundle ) {
		$result          = install_managed( $bundle );
		$report[ $file ] = is_wp_error( $result ) ? $result->get_error_message() : $result;
		if ( ! is_wp_error( $result ) ) {
			$seen[] = (string) $bundle['spec']['manifest']['id'];
		}
	}
	foreach ( list_specs() as $spec ) {
		if ( null === managed_by( $spec['spec_id'] ) || in_array( $spec['spec_id'], $seen, true ) ) {
			continue;
		}
		if ( $spec['active_version'] ) {
			$post = get_version_post( $spec['spec_id'], (int) $spec['active_version'] );
			if ( $post ) {
				transition( $post, 'archive' );
			}
		}
		$post = get_spec_post( $spec['spec_id'] );
		if ( $post ) {
			delete_post_meta( $post->ID, '_graft_managed' );
		}
		$report[ $spec['spec_id'] ] = 'archived';
	}
	update_option( 'graft_managed_report', $report, false );
	return $report;
}

/**
 * Syncs managed customizations when their bundles changed (hooked to
 * admin_init and rest_api_init, after check_surface_change()).
 */
function maybe_sync_managed(): void {
	sync_managed();
}

/**
 * Installs or updates one managed customization.
 *
 * @param array<string, mixed> $bundle Bundle.
 * @return string|WP_Error What happened.
 */
function install_managed( array $bundle ) {
	$manifest = $bundle['spec']['manifest'] ?? null;
	$source   = $bundle['spec']['source'] ?? null;
	if ( ! is_array( $manifest ) || ! is_string( $source ) || ! is_array( $bundle['builds'] ?? null ) ) {
		return new WP_Error( 'graft_invalid_bundle', __( 'Not a customization bundle.', 'graft' ) );
	}
	$spec_id  = (string) ( $manifest['id'] ?? '' );
	$existing = get_spec_post( $spec_id );
	if ( $existing && null === managed_by( $spec_id ) ) {
		/* translators: %s: spec id. */
		return new WP_Error( 'graft_id_in_use', sprintf( __( 'The site already has its own customization %s.', 'graft' ), $spec_id ) );
	}
	$record = create_version(
		array(
			'source'   => $source,
			'manifest' => $manifest,
			'title'    => (string) ( $bundle['title'] ?? $spec_id ),
			'owner'    => 0,
			'system'   => true,
		)
	);
	if ( is_wp_error( $record ) ) {
		return $record;
	}
	$spec = get_spec_post( $spec_id );
	set_json_meta( $spec->ID, '_graft_managed', array( 'by' => maintainer() ) );

	foreach ( $bundle['builds'] as $entry ) {
		if ( ! is_array( $entry['build'] ?? null ) || empty( $entry['verification']['passed'] ) || ! surface_snapshot( (string) ( $entry['build']['surface']['hash'] ?? '' ) ) ) {
			continue;
		}
		$current = get_version_post( $spec_id, $record['version'] );
		if ( isset( version_record( $current )['builds'][ $entry['build']['surface']['hash'] ] ) ) {
			continue;
		}
		$attached = attach_build( $spec_id, $record['version'], $entry['build'], $entry['verification'] + array( 'runner' => 'managed' ) );
		if ( is_wp_error( $attached ) ) {
			return $attached;
		}
	}

	$record = version_record( get_version_post( $spec_id, $record['version'] ) );
	if ( 'needs_approval' === $record['state'] ) {
		$record = approve_version( $spec_id, $record['version'], 'policy' );
		if ( is_wp_error( $record ) ) {
			return $record;
		}
	}
	return $record['state'];
}
