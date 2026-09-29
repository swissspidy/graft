<?php
/**
 * The plugin as a zip, for the verification sandbox that runs in the
 * admin's browser (WordPress Playground in an iframe). The browser fetches
 * it with the REST nonce and installs it into its private, throwaway
 * WordPress; nothing from this site's database goes along.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_REST_Response;
use WP_REST_Server;

/**
 * Registers GET /graft/v1/sandbox-package.
 */
function register_sandbox_package_route(): void {
	register_rest_route(
		REST_NAMESPACE,
		'/sandbox-package',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => __NAMESPACE__ . '\rest_sandbox_package',
			'permission_callback' => static function (): bool {
				return current_user_can( 'manage_options' );
			},
		)
	);
}

/**
 * Zips the plugin directory, without the browser bundles (the sandbox is
 * headless), and returns it base64-encoded.
 *
 * @return WP_REST_Response|WP_Error `{ zip }`.
 */
function rest_sandbox_package() {
	if ( ! class_exists( 'ZipArchive' ) ) {
		return new WP_Error( 'graft_no_zip', __( 'This server cannot create zip files.', 'graft' ), array( 'status' => 501 ) );
	}
	$root = dirname( __DIR__ );
	$file = tempnam( get_temp_dir(), 'graft' );
	$zip  = new \ZipArchive();
	if ( true !== $zip->open( $file, \ZipArchive::OVERWRITE ) ) {
		return new WP_Error( 'graft_zip_failed', __( 'Could not create the package.', 'graft' ), array( 'status' => 500 ) );
	}
	$files = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $root, \FilesystemIterator::SKIP_DOTS ) );
	foreach ( $files as $path => $info ) {
		$relative = ltrim( str_replace( '\\', '/', substr( $path, strlen( $root ) ) ), '/' );
		if ( $info->isFile() && ! preg_match( '#^build/.*\.(js|asset\.php)$#', $relative ) ) {
			$zip->addFile( $path, 'graft/' . $relative );
		}
	}
	$zip->close();
	$data = (string) file_get_contents( $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
	wp_delete_file( $file );
	return new WP_REST_Response( array( 'zip' => base64_encode( $data ) ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
}
