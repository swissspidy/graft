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

echo wp_json_encode( Graft\host_surface(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ), "\n";
