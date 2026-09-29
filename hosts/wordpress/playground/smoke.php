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

function user_named( string $role, string $login ): int {
	return wp_insert_user(
		array(
			'user_login' => 'graft-' . $login,
			'user_pass'  => wp_generate_password(),
			'role'       => $role,
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

// ---------------------------------------------------------------------------
// Store, lifecycle and gateway (milestone 3).
// ---------------------------------------------------------------------------

$examples = json_decode( (string) file_get_contents( '/graft-fixtures/examples.json' ), true );
$queue    = $examples['review-queue'];
$admin    = user( 'administrator' );

function call( string $spec, string $capability, $input = null ) {
	$request = new WP_REST_Request( 'POST', '/graft/v1/call' );
	$request->set_body_params( array( 'spec' => $spec, 'capability' => $capability, 'input' => $input ) );
	$response = rest_do_request( $request );
	$data     = $response->get_data();
	return array(
		'status' => $response->get_status(),
		'code'   => $data['code'] ?? null,
		'data'   => $data,
	);
}

check( 'PHP and TypeScript hash specs the same', Graft\hash_spec( $queue['source'] ) === $queue['hash'] && $queue['build']['spec']['hash'] === $queue['hash'] );
check( 'PHP hash ignores CRLF and trailing spaces', Graft\hash_spec( str_replace( "\n", "  \r\n", $queue['source'] ) ) === $queue['hash'] );
check( 'the plugin recognizes this surface', null !== Graft\current_surface() && Graft\current_surface()['hash'] === $queue['build']['surface']['hash'], Graft\current_surface()['hash'] ?? null );
check( 'the lifecycle table is loaded', 'draft' === Graft\lifecycle()['initial'] && count( Graft\lifecycle()['transitions'] ) > 10 );

wp_set_current_user( $admin );
$bad = Graft\create_version( array( 'source' => 'x', 'manifest' => array_merge( $queue['manifest'], array( 'permissions' => array( 'comments:write' ) ) ) ) );
check( 'unknown permission scopes are rejected', is_wp_error( $bad ) );

$v1 = Graft\create_version( array( 'source' => $queue['source'], 'manifest' => $queue['manifest'], 'title' => $queue['title'] ) );
check( 'a new spec starts as version 1 in draft', 1 === ( $v1['version'] ?? null ) && 'draft' === $v1['state'], $v1 );
$again = Graft\create_version( array( 'source' => $queue['source'] . "\n", 'manifest' => $queue['manifest'] ) );
check( 'saving the same content again is a no-op', 1 === ( $again['version'] ?? null ) );

$unverified = Graft\attach_build( 'review-queue', 1, $queue['build'], null );
check( 'an unverified build does not change the state', 'draft' === ( $unverified['state'] ?? null ), $unverified['state'] ?? $unverified );

$wrong       = $queue['build'];
$wrong['spec']['hash'] = 'sha256:' . str_repeat( '0', 64 );
check( 'a build for other content is rejected', is_wp_error( Graft\attach_build( 'review-queue', 1, $wrong, array( 'passed' => true ) ) ) );

$verified = Graft\attach_build( 'review-queue', 1, $queue['build'], array( 'passed' => true, 'runner' => 'smoke' ) );
check( 'a verified build without a grant needs approval', 'needs_approval' === ( $verified['state'] ?? null ), $verified['state'] ?? $verified );

wp_set_current_user( $editor );
$call = call( 'review-queue', 'posts.list', array( 'status' => array( 'pending' ) ) );
check( 'a spec that is not active is not served', 403 === $call['status'] && 'graft_spec_unavailable' === $call['code'], $call );

wp_set_current_user( $admin );
$approved = Graft\approve_version( 'review-queue', 1 );
check( 'approval activates it with the requested scopes', 'active' === ( $approved['state'] ?? null ) && array( 'posts:read', 'posts.status:write' ) === ( $approved['grant']['scopes'] ?? null ), $approved );

// servable_specs() caches per user id for the request, so use users that
// have not been looked at yet for each state.
$editor2 = user_named( 'editor', 'editor2' );
wp_set_current_user( $editor2 );
$pending2 = wp_insert_post( array( 'post_title' => 'Draft D', 'post_status' => 'pending', 'post_author' => $contributor ) );
$call     = call( 'review-queue', 'posts.list', array( 'status' => array( 'pending' ) ) );
check( 'the gateway runs a granted capability the build uses', 200 === $call['status'] && ids( $call['data'] ) === array( $pending2 ), $call );
$call = call( 'review-queue', 'site.info' );
check( 'the gateway refuses capabilities the build does not use', 403 === $call['status'] && 'graft_capability_not_in_build' === $call['code'], $call );
$scopes = Graft\usable_scopes( Graft\servable_specs()['review-queue']['record'] );
check( 'editors can use both granted scopes', array( 'posts:read' => true, 'posts.status:write' => true ) === $scopes, $scopes );

$contributor2 = user_named( 'contributor', 'contributor2' );
wp_set_current_user( $contributor2 );
$call = call( 'review-queue', 'posts.update_status', array( 'id' => $pending2, 'status' => 'publish' ) );
check( 'the ability still checks WordPress permissions behind the grant', 403 === $call['status'] && 'pending' === get_post_status( $pending2 ), $call );
check( 'contributors cannot use the write scope', false === Graft\usable_scopes( Graft\servable_specs()['review-queue']['record'] )['posts.status:write'] );

$subscriber2 = user_named( 'subscriber', 'subscriber2' );
wp_set_current_user( $subscriber2 );
$call = call( 'review-queue', 'posts.list' );
check( 'users outside the audience are not served', 403 === $call['status'] && 'graft_spec_unavailable' === $call['code'], $call );

// The host moves a capability behind a new scope while the stored build is
// unchanged: the gateway must refuse the call.
$widen = static function ( array $map ): array {
	$map['posts.update_status']['scopes'][] = 'posts.publish:write';
	return $map;
};
add_filter( 'graft_surface_capability_map', $widen );
$editor3 = user_named( 'editor', 'editor3' );
wp_set_current_user( $editor3 );
$call = call( 'review-queue', 'posts.update_status', array( 'id' => $pending2, 'status' => 'publish' ) );
check( 'the gateway enforces the grant per capability', 403 === $call['status'] && 'graft_not_granted' === $call['code'] && 'pending' === get_post_status( $pending2 ), $call );
remove_filter( 'graft_surface_capability_map', $widen );

// Narrow the grant behind the spec's back: it is no longer served at all.
$version_post = Graft\get_version_post( 'review-queue', 1 );
Graft\set_json_meta( $version_post->ID, '_graft_grant', array( 'scopes' => array( 'posts:read' ) ) );
wp_set_current_user( user_named( 'editor', 'editor3b' ) );
$call = call( 'review-queue', 'posts.list' );
check( 'a build the grant does not cover is not served', 403 === $call['status'] && 'graft_spec_unavailable' === $call['code'], $call );
Graft\set_json_meta( $version_post->ID, '_graft_grant', $approved['grant'] );

wp_set_current_user( $admin );
$v2 = Graft\create_version( array( 'source' => $queue['source'] . "\n## Notes\n\nKeep it short.\n", 'manifest' => $queue['manifest'] ) );
check( 'an edit creates version 2 with the inherited grant', 2 === ( $v2['version'] ?? null ) && $approved['grant'] === $v2['grant'], $v2 );
$build2                 = $queue['build'];
$build2['spec']['hash'] = $v2['hash'];
$v2                     = Graft\attach_build( 'review-queue', 2, $build2, array( 'passed' => true ) );
check( 'within the inherited grant it activates without approval', 'active' === ( $v2['state'] ?? null ), $v2['state'] ?? $v2 );
check( 'and supersedes version 1', 'superseded' === Graft\version_record( Graft\get_version_post( 'review-queue', 1 ) )['state'] );
$archived = Graft\apply_event( 'review-queue', 2, 'archive' );
check( 'archiving stops serving it', 'archived' === ( $archived['state'] ?? null ) && '' === get_post_meta( Graft\get_spec_post( 'review-queue' )->ID, '_graft_active_version', true ) );
check( 'invalid events are refused', is_wp_error( Graft\apply_event( 'review-queue', 2, 'approve' ) ) );

// ---------------------------------------------------------------------------
// Host changes and upgrades prepared ahead of them (milestone 6).
// ---------------------------------------------------------------------------

$qa = $examples['quick-approve'];
wp_set_current_user( $admin );
Graft\create_version( array( 'source' => $qa['source'], 'manifest' => $qa['manifest'], 'title' => $qa['title'] ) );
Graft\attach_build( 'quick-approve', 1, $qa['build'], array( 'passed' => true ) );
Graft\approve_version( 'quick-approve', 1 );
Graft\check_surface_change();
$state = static function (): string {
	return Graft\version_record( Graft\get_version_post( 'quick-approve', 1 ) )['state'];
};
check( 'quick-approve is active on surface A', 'active' === $state() );

$surface_a = Graft\current_surface();
$snapshot  = static function ( string $hash, string $fingerprint ) use ( $surface_a ) {
	return static function ( array $snapshots ) use ( $surface_a, $hash, $fingerprint ): array {
		$snapshots[ $hash ] = array_merge( $surface_a, array( 'hash' => $hash, 'fingerprint' => $fingerprint ) );
		return $snapshots;
	};
};
$with_scope = static function ( string $scope ) {
	return static function ( array $scopes ) use ( $scope ): array {
		$scopes[ $scope ] = array(
			'title' => $scope,
			'host'  => array( 'read' ),
		);
		return $scopes;
	};
};

// Host B: nothing prepared.
$hash_b  = 'sha256:' . str_repeat( 'b', 64 );
$scope_b = $with_scope( 'canary-b:read' );
add_filter( 'graft_surface_scopes', $scope_b );
add_filter( 'graft_surface_snapshots', $snapshot( $hash_b, Graft\host_fingerprint() ) );
check( 'the plugin finds the snapshot for the changed host', $hash_b === ( Graft\current_surface( true )['hash'] ?? null ) );
Graft\check_surface_change();
check( 'without a prepared build the version goes to upgrading', 'upgrading' === $state(), $state() );
wp_set_current_user( user_named( 'editor', 'editor4' ) );
check( 'an upgrading version is not served', ! isset( Graft\servable_specs()['quick-approve'] ) );

wp_set_current_user( $admin );
$build_b                    = $qa['build'];
$build_b['surface']['hash'] = $hash_b;
$attached                   = Graft\attach_build( 'quick-approve', 1, $build_b, array( 'passed' => true ) );
check( 'a verified build for the new surface makes it active again', 'active' === ( $attached['state'] ?? null ), $attached['state'] ?? $attached );
wp_set_current_user( user_named( 'editor', 'editor5' ) );
check( 'and serves that build', $hash_b === ( Graft\servable_specs()['quick-approve']['build']['surface']['hash'] ?? null ) );

// Host C: prepared in advance, but needing a wider grant.
wp_set_current_user( $admin );
$hash_c  = 'sha256:' . str_repeat( 'c', 64 );
$scope_c = $with_scope( 'canary-c:read' );
add_filter( 'graft_surface_scopes', $scope_c );
$fingerprint_c = Graft\host_fingerprint();
remove_filter( 'graft_surface_scopes', $scope_c );
add_filter( 'graft_surface_snapshots', $snapshot( $hash_c, $fingerprint_c ) );

$build_c                    = $qa['build'];
$build_c['surface']['hash'] = $hash_c;
$build_c['refs']['scopes'][] = 'posts.publish:write';
$prepared                   = Graft\attach_build( 'quick-approve', 1, $build_c, array( 'passed' => true ) );
check( 'a build needing a new scope can be prepared for an active version', 'active' === ( $prepared['state'] ?? null ), $prepared );

$moved                           = $qa['build'];
$moved['surface']['hash']        = $hash_c;
$moved['mount']['slot']          = 'dashboard.widget';
check( 'a build mounted elsewhere is refused', is_wp_error( Graft\attach_build( 'quick-approve', 1, $moved, array( 'passed' => true ) ) ) );
$moved['provenance']['strategy'] = 'reanchored';
$moved['refs']['scopes'][]       = 'posts.publish:write';
check( 'unless it was re-anchored to a slot the surface has', ! is_wp_error( Graft\attach_build( 'quick-approve', 1, $moved, array( 'passed' => true ) ) ) );

add_filter( 'graft_surface_scopes', $scope_c );
Graft\current_surface( true );
Graft\check_surface_change();
check( 'on the change the wider build waits for approval', 'needs_approval' === $state(), $state() );
wp_set_current_user( user_named( 'editor', 'editor6' ) );
check( 'and is not served meanwhile', ! isset( Graft\servable_specs()['quick-approve'] ) );
wp_set_current_user( $admin );
$approved_c = Graft\approve_version( 'quick-approve', 1 );
check( 'approval widens the grant to what the build needs', 'active' === ( $approved_c['state'] ?? null ) && in_array( 'posts.publish:write', $approved_c['grant']['scopes'] ?? array(), true ), $approved_c );

global $wp_version;
echo wp_json_encode(
	array(
		'wp'     => $wp_version,
		'php'    => PHP_VERSION,
		'checks' => $checks,
	),
	JSON_UNESCAPED_SLASHES
), "\n";
