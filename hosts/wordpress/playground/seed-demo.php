<?php
/**
 * Seeds the public Playground demo: a small newsroom with a few people and
 * posts, and every example customization installed with its verification
 * record. All are approved except waiting-posts, which is left for the
 * visitor to review and approve under Tools → Customizations.
 *
 * Reads the examples from /wordpress/graft-demo/demo.json, which the demo
 * build writes (see adapter/src/demo.ts).
 */

require_once '/wordpress/wp-load.php';

// Known passwords, so visitors can sign in as anyone: it is their own
// throwaway site in the browser.
wp_update_user(
	array(
		'ID'        => 1,
		'user_pass' => 'password',
	)
);

$people = array(
	'ada'   => array( 'Ada Lovelace', 'contributor' ),
	'grace' => array( 'Grace Hopper', 'contributor' ),
	'alan'  => array( 'Alan Turing', 'author' ),
	'edna'  => array( 'Edna Editor', 'editor' ),
);
$users  = array();
foreach ( $people as $login => list( $name, $role ) ) {
	$users[ $login ] = wp_insert_user(
		array(
			'user_login'   => $login,
			'user_pass'    => 'password',
			'role'         => $role,
			'display_name' => $name,
		)
	);
}

// Title, status, author, days since it was last touched.
$posts = array(
	array( 'City council votes on the new cycling plan', 'pending', 'ada', 1 ),
	array( 'BUDGET SHOWDOWN TONIGHT', 'pending', 'ada', 2 ),
	array( 'Library hours', 'pending', 'grace', 1 ),
	array( 'A long look at how the harbor redevelopment changed three neighborhoods over ten years', 'pending', 'grace', 3 ),
	array( 'Interview notes: the new school principal', 'draft', 'alan', 2 ),
	array( 'Winter storm preparedness guide', 'draft', 'alan', 12 ),
	array( 'Year in review (outline)', 'draft', 'edna', 45 ),
	array( 'Welcome to the newsroom', 'publish', 'edna', 60 ),
);
foreach ( $posts as list( $title, $status, $author, $days ) ) {
	$date = gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS );
	wp_insert_post(
		array(
			'post_title'    => $title,
			'post_status'   => $status,
			'post_author'   => $users[ $author ],
			'post_date'     => $date,
			'post_date_gmt' => $date,
		)
	);
}

wp_set_current_user( 1 );
$examples = json_decode( (string) file_get_contents( '/wordpress/graft-demo/demo.json' ), true );
// The builds decoded as objects, so they are stored exactly as written (empty objects stay objects).
$raw_examples = json_decode( (string) file_get_contents( '/wordpress/graft-demo/demo.json' ) );
foreach ( $examples as $spec_id => $example ) {
	$version = Graft\create_version(
		array(
			'source'   => $example['source'],
			'manifest' => $example['manifest'],
			'title'    => $example['title'],
		)
	);
	Graft\attach_build( $spec_id, $version['version'], $raw_examples->{ $spec_id }->build, $example['verification'] ?? null );
	if ( 'waiting-posts' !== $spec_id ) {
		Graft\approve_version( $spec_id, $version['version'] );
	}
}
