<?php
/**
 * Seeds the Riverside Arts Centre site (sites/riverside.php) for the agency
 * end-to-end tests: users, events with fields and types, the site surface
 * an administrator's browser would have recorded, the agency's managed
 * customizations, and the centre's own Family friendly action waiting for
 * approval.
 */

require_once '/wordpress/wp-load.php';

wp_update_user(
	array(
		'ID'        => 1,
		'user_pass' => 'password',
	)
);
$users = array();
foreach ( array( 'editor', 'author' ) as $role ) {
	$users[ $role ] = wp_insert_user(
		array(
			'user_login'   => $role,
			'user_pass'    => 'password',
			'role'         => $role,
			'display_name' => ucfirst( $role ) . ' User',
		)
	);
}

$types = array();
foreach ( array( 'Family', 'Music', 'Theatre' ) as $name ) {
	$types[ strtolower( $name ) ] = wp_insert_term( $name, 'event_type' )['term_id'];
}

$events = array(
	array( 'Poetry slam', 10, 'Studio', 60, array( 'music' ) ),
	array( 'Open rehearsal', 20, null, 120, array( 'theatre' ) ),
	array( 'Jazz night', 30, 'Main hall', 240, array( 'music' ) ),
	array( 'Puppet show', 40, 'Studio', 80, array( 'family', 'theatre' ) ),
);
foreach ( $events as list( $title, $in_days, $venue, $capacity, $slugs ) ) {
	$id = wp_insert_post(
		array(
			'post_title'  => $title,
			'post_type'   => 'event',
			'post_status' => 'publish',
			'post_author' => $users['author'],
		)
	);
	update_post_meta( $id, 'event_date', gmdate( 'Y-m-d', time() + $in_days * DAY_IN_SECONDS ) );
	update_post_meta( $id, 'capacity', $capacity );
	if ( $venue ) {
		update_post_meta( $id, 'venue', $venue );
	}
	wp_set_object_terms( $id, $slugs, 'event_type' );
}
wp_insert_post(
	array(
		'post_title'  => 'Season announcement',
		'post_status' => 'publish',
		'post_author' => $users['editor'],
	)
);

wp_set_current_user( 1 );

// The surface an administrator's browser records on first visit to Tools →
// Customizations (the e2e tests exercise that when the agency changes the
// content model).
$surface = Graft\store_site_surface( json_decode( (string) file_get_contents( '/graft-agency/surface.json' ), true ) );
if ( is_wp_error( $surface ) ) {
	fwrite( STDERR, 'Site surface: ' . $surface->get_error_message() . "\n" );
	exit( 1 );
}
Graft\check_surface_change();
Graft\sync_managed( true );

// The centre's own customization, verified by e2e/agency-server.ts and
// waiting for an administrator.
$examples = json_decode( (string) file_get_contents( '/graft-fixtures/examples.json' ), true );
$example  = $examples['family-friendly'];
$version  = Graft\create_version(
	array(
		'source'   => $example['source'],
		'manifest' => $example['manifest'],
		'title'    => $example['title'],
	)
);
Graft\attach_build( 'family-friendly', $version['version'], $example['build'], $example['verification'] ?? null );

list( $app_password ) = WP_Application_Passwords::create_new_application_password( 1, array( 'name' => 'graft-e2e' ) );
file_put_contents( '/graft-fixtures/app-password.txt', $app_password );

// Test hook: lets the tests "deploy" the agency's next release (see the
// riverside_release option in sites/riverside.php). Administrators only.
file_put_contents(
	'/wordpress/wp-content/mu-plugins/riverside-release.php',
	<<<'PHP'
<?php
add_action(
	'rest_api_init',
	static function (): void {
		register_rest_route(
			'riverside-test/v1',
			'/release',
			array(
				'methods'             => 'POST',
				'callback'            => static function ( WP_REST_Request $request ) {
					update_option( 'riverside_release', (int) $request['release'] );
					return array( 'release' => (int) get_option( 'riverside_release' ) );
				},
				'permission_callback' => static function (): bool {
					return current_user_can( 'manage_options' );
				},
			)
		);
	}
);
PHP
);
