<?php
/**
 * Verification sandbox endpoint. Mounted only into the Playground the
 * verifier boots (at /graft-sandbox/), never shipped with the plugin.
 *
 * Accepts POST JSON { op, ... } with the X-Graft-Sandbox header set to the
 * GRAFT_SANDBOX_TOKEN constant, and answers JSON. Operations:
 *
 * - reset: delete all posts and all users but the admin.
 * - seed { fixtures: { users: [{ as, role }], posts: [{ title, status, author?, type? }] } }
 * - scopes { as, scopes[] }: which scopes the user can use (WordPress caps).
 * - call { as, capability, input }: run the capability's ability as the user.
 * - slot { as, slot }: slot props for every place the slot renders.
 * - assert { kind, expected }: host assertions (kind "post").
 * - patch { patch }: store a synthetic host change for canary.php.
 * - dump: the host half of the surface and its fingerprint.
 */

require dirname( __DIR__ ) . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/user.php';

header( 'Content-Type: application/json' );

function respond( $data, int $status = 200 ): void {
	http_response_code( $status );
	echo wp_json_encode( $data, JSON_UNESCAPED_SLASHES );
	exit;
}

$token = $_SERVER['HTTP_X_GRAFT_SANDBOX'] ?? '';
if ( ! defined( 'GRAFT_SANDBOX_TOKEN' ) || ! is_string( $token ) || ! hash_equals( (string) GRAFT_SANDBOX_TOKEN, $token ) ) {
	respond( array( 'error' => 'forbidden' ), 403 );
}

$request = json_decode( (string) file_get_contents( 'php://input' ), true );
if ( ! is_array( $request ) ) {
	respond( array( 'ok' => true ) );
}

/**
 * User id for a fixture alias.
 *
 * @param string $alias Alias.
 * @return int
 */
function alias_user( string $alias ): int {
	$user = get_user_by( 'login', 'graft-' . $alias );
	return $user ? $user->ID : 0;
}

switch ( $request['op'] ?? '' ) {
	case 'reset':
		global $wpdb;
		foreach ( $wpdb->get_col( "SELECT ID FROM {$wpdb->posts}" ) as $id ) {
			wp_delete_post( (int) $id, true );
		}
		foreach ( get_users( array( 'exclude' => array( 1 ), 'fields' => 'ID' ) ) as $id ) {
			wp_delete_user( (int) $id );
		}
		wp_cache_flush();
		respond( array( 'ok' => true ) );

	case 'seed':
		$fixtures = $request['fixtures'] ?? array();
		$users    = array();
		foreach ( $fixtures['users'] ?? array() as $user ) {
			$id = wp_insert_user(
				array(
					'user_login'   => 'graft-' . $user['as'],
					'user_pass'    => wp_generate_password(),
					'role'         => $user['role'],
					'display_name' => $user['name'] ?? ucfirst( $user['as'] ),
				)
			);
			if ( is_wp_error( $id ) ) {
				respond( array( 'error' => $id->get_error_message() ), 400 );
			}
			$users[ $user['as'] ] = array( $user['role'] );
		}
		foreach ( array_values( $fixtures['posts'] ?? array() ) as $i => $post ) {
			$id = wp_insert_post(
				array(
					'post_title'  => $post['title'],
					'post_status' => $post['status'] ?? 'publish',
					'post_type'   => $post['type'] ?? 'post',
					'post_author' => isset( $post['author'] ) ? alias_user( $post['author'] ) : 1,
					// Oldest first, one hour apart, so ordering is deterministic.
					'post_date'   => gmdate( 'Y-m-d H:i:s', time() - ( 100 - $i ) * HOUR_IN_SECONDS ),
				),
				true
			);
			if ( is_wp_error( $id ) ) {
				respond( array( 'error' => $id->get_error_message() ), 400 );
			}
		}
		respond( array( 'users' => (object) $users ) );

	case 'scopes':
		wp_set_current_user( alias_user( (string) $request['as'] ) );
		$defined = Graft\surface_scopes();
		$usable  = array();
		foreach ( $request['scopes'] ?? array() as $scope ) {
			$caps             = $defined[ $scope ]['host'] ?? array();
			$usable[ $scope ] = array() !== $caps && count( array_filter( $caps, 'current_user_can' ) ) === count( $caps );
		}
		respond( array( 'scopes' => (object) $usable ) );

	case 'call':
		wp_set_current_user( alias_user( (string) $request['as'] ) );
		$map = Graft\surface_capability_map();
		$cap = (string) $request['capability'];
		if ( ! isset( $map[ $cap ] ) || ! wp_get_ability( $map[ $cap ]['ability'] ) ) {
			respond( array( 'error' => array( 'code' => 'graft_capability_unavailable', 'message' => "Unknown capability $cap" ) ) );
		}
		$result = wp_get_ability( $map[ $cap ]['ability'] )->execute( $request['input'] ?? null );
		if ( is_wp_error( $result ) ) {
			respond( array( 'error' => array( 'code' => $result->get_error_code(), 'message' => $result->get_error_message() ) ) );
		}
		respond( array( 'result' => $result ) );

	case 'slot':
		wp_set_current_user( alias_user( (string) $request['as'] ) );
		// Resolve by anchor, so renamed or aliased slots render like the
		// original.
		$slot = Graft\surface_slots()[ (string) $request['slot'] ] ?? null;
		if ( ! $slot ) {
			respond( array( 'instances' => array() ) );
		}
		if ( 'filter:post_row_actions' === ( $slot['anchor'] ?? '' ) ) {
			// The Posts screen's "All" view: every status it lists, private
			// posts only where readable.
			$query     = new WP_Query(
				array(
					'post_type'      => 'post',
					'post_status'    => array( 'publish', 'future', 'draft', 'pending', 'private' ),
					'perm'           => 'readable',
					'posts_per_page' => -1,
					'orderby'        => 'date',
					'order'          => 'DESC',
				)
			);
			$instances = array_map( 'Graft\post_slot_props', $query->posts );
			respond( array( 'instances' => $instances ) );
		}
		respond( array( 'instances' => 'owned' === $slot['kind'] ? array( (object) array() ) : array() ) );

	case 'patch':
		update_option( 'graft_canary_patch', $request['patch'] ?? array() );
		respond( array( 'ok' => true ) );

	case 'dump':
		$surface                = Graft\host_surface();
		$surface['fingerprint'] = Graft\host_fingerprint( $surface );
		respond( $surface );

	case 'assert':
		if ( 'post' === ( $request['kind'] ?? '' ) ) {
			$expected = $request['expected'] ?? array();
			$posts    = get_posts(
				array(
					'post_type'   => 'any',
					'post_status' => 'any',
					'title'       => $expected['title'] ?? '',
					'numberposts' => 1,
				)
			);
			$post     = $posts[0] ?? null;
			$actual   = $post ? array(
				'title'  => $post->post_title,
				'status' => $post->post_status,
				'type'   => $post->post_type,
			) : null;
			$ok       = null !== $actual && array() === array_diff_assoc( array_map( 'strval', $expected ), array_map( 'strval', $actual ) );
			respond( array( 'ok' => $ok, 'actual' => $actual ) );
		}
		respond( array( 'ok' => false, 'actual' => 'unknown assertion ' . ( $request['kind'] ?? '' ) ) );
}

respond( array( 'error' => 'unknown op' ), 400 );
