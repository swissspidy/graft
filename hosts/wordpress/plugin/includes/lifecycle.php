<?php
/**
 * Spec version lifecycle, driven by the shared transition table in
 * schemas/spec-lifecycle.json (copied to build/ by the client build).
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;

/**
 * The transition table.
 *
 * @return array{initial: string, states: array<string, string>, transitions: array<int, array{from: string, event: string, to: string}>}
 */
function lifecycle(): array {
	static $machine = null;
	if ( null === $machine ) {
		$file    = dirname( __DIR__ ) . '/build/spec-lifecycle.json';
		$machine = is_readable( $file ) ? json_decode( (string) file_get_contents( $file ), true ) : null; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
		if ( ! is_array( $machine ) ) {
			$machine = array(
				'initial'     => 'draft',
				'states'      => array(),
				'transitions' => array(),
			);
		}
	}
	return $machine;
}

/**
 * The state after an event, or an error when the event is not allowed.
 *
 * @param string $state Current state.
 * @param string $event Event.
 * @return string|WP_Error
 */
function next_state( string $state, string $event ) {
	foreach ( lifecycle()['transitions'] as $transition ) {
		if ( $transition['from'] === $state && $transition['event'] === $event ) {
			return $transition['to'];
		}
	}
	return new WP_Error(
		'graft_invalid_transition',
		/* translators: 1: event, 2: state. */
		sprintf( __( 'Cannot %1$s a spec version that is %2$s.', 'graft' ), $event, $state ),
		array( 'status' => 409 )
	);
}
