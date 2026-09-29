<?php
/**
 * Smoke test for the Graft plugin: seeds users and posts, then runs the
 * abilities as each user and checks results and permission decisions.
 * Prints one JSON line: { "wp", "php", "checks": [{ "name", "ok", "detail" }] }.
 */

require '/wordpress/wp-load.php';

$checks = array();
function check( string $name, bool $ok, $detail = null ): void {
	global $checks;
	$checks[] = array(
		'name'   => $name,
		'ok'     => $ok,
		'detail' => $detail,
	);
}

function user( string $role ): int {
	$login = 'graft-' . $role;
	$user  = get_user_by( 'login', $login );
	return $user ? $user->ID : wp_insert_user(
		array(
			'user_login'   => $login,
			'user_pass'    => wp_generate_password(),
			'role'         => $role,
			'display_name' => ucfirst( $role ),
		)
	);
}

function run( string $ability, $input = null ) {
	$result = wp_get_ability( $ability )->execute( $input );
	return is_wp_error( $result ) ? array( 'error' => $result->get_error_code() ) : $result;
}

function ids( array $result ): array {
	return array_map(
		static function ( $item ) {
			return $item['id'];
		},
		$result['items'] ?? array()
	);
}

$editor      = user( 'editor' );
$contributor = user( 'contributor' );
$subscriber  = user( 'subscriber' );

$pending = wp_insert_post(
	array(
		'post_title'  => 'Draft A',
		'post_status' => 'pending',
		'post_author' => $contributor,
	)
);
$draft   = wp_insert_post(
	array(
		'post_title'  => 'Draft B',
		'post_status' => 'draft',
		'post_author' => $editor,
	)
);

// The abilities are registered with the expected annotations.
foreach ( array( 'graft/posts-list' => true, 'graft/post-update-status' => false ) as $name => $readonly ) {
	$ability = wp_get_ability( $name );
	check( "$name is registered", (bool) $ability );
	check( "$name readonly annotation", $ability && $readonly === $ability->get_meta_item( 'annotations' )['readonly'] );
}

// Editor.
wp_set_current_user( $editor );
$list = run( 'graft/posts-list', array( 'status' => array( 'pending' ) ) );
check( 'editor lists only pending posts', ids( $list ) === array( $pending ), $list );
check( 'editor may publish the pending post', ( $list['items'][0]['can']['publish'] ?? null ) === true, $list );
check( 'dates are RFC 3339 UTC', (bool) preg_match( '/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', $list['items'][0]['date'] ?? '' ), $list['items'][0]['date'] ?? null );
check( 'author is resolved', ( $list['items'][0]['author']['name'] ?? '' ) === 'Contributor', $list['items'][0]['author'] ?? null );
check( 'default input lists all editable statuses', count( ids( run( 'graft/posts-list' ) ) ) >= 2 );

// Contributor.
wp_set_current_user( $contributor );
$list = run( 'graft/posts-list', array( 'status' => array( 'pending', 'draft' ) ) );
check( 'contributor sees only own posts', ids( $list ) === array( $pending ), $list );
check( 'contributor may not publish', ( $list['items'][0]['can']['publish'] ?? null ) === false, $list );
$denied = run( 'graft/post-update-status', array( 'id' => $pending, 'status' => 'publish' ) );
check( 'contributor cannot publish via ability', isset( $denied['error'] ), $denied );
check( 'post is still pending', 'pending' === get_post_status( $pending ) );

// Subscriber.
wp_set_current_user( $subscriber );
$denied = run( 'graft/posts-list' );
check( 'subscriber cannot list posts', isset( $denied['error'] ), $denied );

// Editor approves.
wp_set_current_user( $editor );
$updated = run( 'graft/post-update-status', array( 'id' => $pending, 'status' => 'publish' ) );
check( 'editor publishes the pending post', ( $updated['status'] ?? null ) === 'publish', $updated );
check( 'post is published', 'publish' === get_post_status( $pending ) );
check( 'pending queue is empty', ids( run( 'graft/posts-list', array( 'status' => array( 'pending' ) ) ) ) === array() );

$invalid = run( 'graft/post-update-status', array( 'id' => $draft, 'status' => 'trash' ) );
check( 'invalid status is rejected by the input schema', isset( $invalid['error'] ), $invalid );

// The surface only lists capabilities whose ability exists.
$surface = Graft\host_surface();
check( 'surface lists the graft capabilities', isset( $surface['capabilities']['posts.list'], $surface['capabilities']['posts.update_status'] ) );

global $wp_version;
echo wp_json_encode(
	array(
		'wp'     => $wp_version,
		'php'    => PHP_VERSION,
		'checks' => $checks,
	),
	JSON_UNESCAPED_SLASHES
), "\n";
