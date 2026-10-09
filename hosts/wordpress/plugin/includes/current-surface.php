<?php
/**
 * Which of the shipped surface snapshots this install matches.
 *
 * @package Graft
 */

namespace Graft;

/** How many surfaces recorded on the site are kept (newest first). */
const MAX_SITE_SURFACES = 3;

/**
 * Surface snapshots shipped with the plugin, keyed by file name.
 *
 * @return array<string, array<string, mixed>>
 */
function shipped_snapshots(): array {
	static $snapshots = null;
	if ( null === $snapshots ) {
		$snapshots = array();
		foreach ( glob( dirname( __DIR__ ) . '/surfaces/*.json' ) ?: array() as $file ) {
			$surface = json_decode( (string) file_get_contents( $file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			if ( is_array( $surface ) && isset( $surface['hash'], $surface['fingerprint'] ) ) {
				$snapshots[ basename( $file, '.json' ) ] = $surface;
			}
		}
	}
	return $snapshots;
}

/**
 * Surfaces recorded on this site, newest first: its own content model (or
 * a WordPress version) that no shipped snapshot describes. See
 * store_site_surface().
 *
 * @return array<int, array<string, mixed>>
 */
function site_surfaces(): array {
	$surfaces = get_option( 'graft_site_surfaces', array() );
	return is_array( $surfaces ) ? array_values( array_filter( $surfaces, 'is_array' ) ) : array();
}

/**
 * Surface snapshots the plugin knows, keyed by name: the shipped ones, then
 * those recorded on the site (named site-<hash prefix>).
 *
 * @return array<string, array<string, mixed>>
 */
function surface_snapshots(): array {
	$snapshots = shipped_snapshots();
	foreach ( site_surfaces() as $surface ) {
		$snapshots[ 'site-' . substr( (string) $surface['hash'], 7, 12 ) ] = $surface;
	}
	/**
	 * Filters the surface snapshots the plugin knows, keyed by name.
	 *
	 * @param array<string, array<string, mixed>> $snapshots Snapshots.
	 */
	return apply_filters( 'graft_surface_snapshots', $snapshots );
}

/**
 * Records the site's own surface. The surface is assembled in an
 * administrator's browser from this host's dump (the same code that
 * generates the shipped snapshots), because only the TypeScript core
 * normalizes and hashes surfaces. It is accepted when it describes this
 * host (its fingerprint is the host's), so a site surface can only differ
 * from a shipped one in what the host itself exposes.
 *
 * @param mixed $surface Surface.
 * @return array<string, mixed>|\WP_Error The stored surface.
 */
function store_site_surface( $surface ) {
	$invalid = static function ( string $message ): \WP_Error {
		return new \WP_Error( 'graft_invalid_surface', $message, array( 'status' => 400 ) );
	};
	if ( ! is_array( $surface ) || 1 !== ( $surface['graft'] ?? null ) || 'wordpress' !== ( $surface['host'] ?? null ) ) {
		return $invalid( __( 'Not a WordPress surface.', 'graft' ) );
	}
	if ( ! is_string( $surface['hash'] ?? null ) || ! preg_match( '/^sha256:[0-9a-f]{64}$/', $surface['hash'] ) ) {
		return $invalid( __( 'The surface has no hash.', 'graft' ) );
	}
	if ( ( $surface['fingerprint'] ?? null ) !== host_fingerprint() ) {
		return $invalid( __( 'The surface does not describe this site as it is now.', 'graft' ) );
	}
	if ( surface_snapshot( $surface['hash'] ) ) {
		return $surface;
	}
	$surfaces = array_merge( array( $surface ), site_surfaces() );
	update_option( 'graft_site_surfaces', array_slice( $surfaces, 0, MAX_SITE_SURFACES ), false );
	current_surface( true );
	return $surface;
}

/**
 * The snapshot with a given surface hash.
 *
 * @param string $hash Surface hash.
 * @return array<string, mixed>|null
 */
function surface_snapshot( string $hash ): ?array {
	foreach ( surface_snapshots() as $surface ) {
		if ( $surface['hash'] === $hash ) {
			return $surface;
		}
	}
	return null;
}

/**
 * The snapshot matching this install's host fingerprint, or null when the
 * install exposes a surface no shipped snapshot describes (a WordPress
 * version or a filter the plugin has not been prepared for). Builds are only
 * served for a known surface.
 *
 * @param bool $refresh Recompute instead of using this request's answer.
 * @return array<string, mixed>|null
 */
function current_surface( bool $refresh = false ): ?array {
	static $current = false;
	if ( false === $current || $refresh ) {
		$current     = null;
		$fingerprint = host_fingerprint();
		foreach ( surface_snapshots() as $surface ) {
			if ( $surface['fingerprint'] === $fingerprint ) {
				$current = $surface;
				break;
			}
		}
	}
	return $current;
}

/**
 * Whether a surface hash belongs to a shipped snapshot.
 *
 * @param string $hash Surface hash.
 * @return bool
 */
function is_known_surface( string $hash ): bool {
	return null !== surface_snapshot( $hash );
}
