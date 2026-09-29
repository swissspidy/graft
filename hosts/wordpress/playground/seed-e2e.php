<?php
/**
 * Seeds a Playground site for the end-to-end tests: users with known
 * passwords, posts, and the example specs installed and approved with their
 * hand-written builds. Hand-written builds are not verified yet (the
 * verifier is milestone 4), so this relies on GRAFT_ALLOW_UNVERIFIED_BUILDS
 * and the versions are flagged as unverified.
 */

require_once '/wordpress/wp-load.php';

$users = array();
foreach ( array( 'editor', 'contributor', 'subscriber' ) as $role ) {
	$users[ $role ] = wp_insert_user(
		array(
			'user_login'   => $role,
			'user_pass'    => 'password',
			'role'         => $role,
			'display_name' => ucfirst( $role ) . ' User',
		)
	);
}

$posts = array(
	array( 'Draft A', 'pending', 'contributor' ),
	array( 'Draft B', 'draft', 'editor' ),
	array( 'Post C', 'publish', 'editor' ),
	array( 'Draft E', 'pending', 'contributor' ),
);
foreach ( $posts as $i => list( $title, $status, $author ) ) {
	wp_insert_post(
		array(
			'post_title'  => $title,
			'post_status' => $status,
			'post_author' => $users[ $author ],
			'post_date'   => gmdate( 'Y-m-d H:i:s', time() - ( 10 - $i ) * HOUR_IN_SECONDS ),
		)
	);
}

wp_set_current_user( 1 );
$examples = json_decode( (string) file_get_contents( '/graft-fixtures/examples.json' ), true );
foreach ( $examples as $spec_id => $example ) {
	$version = Graft\create_version(
		array(
			'source'   => $example['source'],
			'manifest' => $example['manifest'],
			'title'    => $example['title'],
		)
	);
	Graft\attach_build( $spec_id, $version['version'], $example['build'], null );
	Graft\approve_version( $spec_id, $version['version'] );
}
