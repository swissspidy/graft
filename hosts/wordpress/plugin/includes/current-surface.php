<?php
/**
 * Which of the shipped surface snapshots this install matches.
 *
 * @package Graft
 */

namespace Graft;

/**
 * Surface snapshots shipped with the plugin, keyed by file name.
 *
 * @return array<string, array<string, mixed>>
 */
function surface_snapshots(): array {
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
 * The snapshot matching this install's host fingerprint, or null when the
 * install exposes a surface no shipped snapshot describes (a WordPress
 * version or a filter the plugin has not been prepared for). Builds are only
 * served for a known surface.
 *
 * @return array<string, mixed>|null
 */
function current_surface(): ?array {
	static $current = false;
	if ( false === $current ) {
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
	foreach ( surface_snapshots() as $surface ) {
		if ( $surface['hash'] === $hash ) {
			return true;
		}
	}
	return false;
}
