<?php
/**
 * Prints the host half of the Graft surface as JSON. Run inside WordPress
 * Playground with the plugin mounted and active; see
 * hosts/wordpress/adapter/src/playground.ts.
 */

require '/wordpress/wp-load.php';

if ( ! function_exists( 'Graft\host_surface' ) ) {
	fwrite( STDERR, "The Graft plugin is not active.\n" );
	exit( 1 );
}

$surface                = Graft\host_surface();
$surface['fingerprint'] = Graft\host_fingerprint( $surface );

echo wp_json_encode( $surface, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ), "\n";
