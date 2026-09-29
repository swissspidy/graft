<?php
/**
 * Seeds a Playground site for the end-to-end tests: users with known
 * passwords, posts, and the example specs installed with their hand-written
 * builds and the verification records e2e/server.ts produced, then approved.
 */

require_once '/wordpress/wp-load.php';

$users = array();
wp_update_user(
	array(
		'ID'        => 1,
		'user_pass' => 'password',
	)
);
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

// A draft nobody has touched for forty days, for stale-drafts.
wp_insert_post(
	array(
		'post_title'  => 'Old draft D',
		'post_status' => 'draft',
		'post_author' => $users['editor'],
		'post_date'   => gmdate( 'Y-m-d H:i:s', time() - 40 * DAY_IN_SECONDS ),
	)
);

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
	Graft\attach_build( $spec_id, $version['version'], $example['build'], $example['verification'] ?? null );
	// waiting-posts is left for the admin to approve in the e2e tests.
	if ( 'waiting-posts' !== $spec_id ) {
		Graft\approve_version( $spec_id, $version['version'] );
	}
}

// An application password for the CLI (graft site ...), read by the tests.
list( $app_password ) = WP_Application_Passwords::create_new_application_password( 1, array( 'name' => 'graft-e2e' ) );
file_put_contents( '/graft-fixtures/app-password.txt', $app_password );
