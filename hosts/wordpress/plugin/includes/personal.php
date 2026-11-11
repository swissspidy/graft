<?php
/**
 * Customizations people write for themselves (ADR 0014): who may, what
 * goes live without an administrator, and how many model calls a person
 * may spend of the site's.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;

defined( 'ABSPATH' ) || exit;

/** Model calls a person who is not an administrator may make a day. A compile makes two to six. */
const PERSONAL_GENERATE_LIMIT = 30;

/**
 * Whether people who can edit posts may write customizations for
 * themselves on this site.
 *
 * @return bool
 */
function personal_authoring(): bool {
	/**
	 * Filters whether people who are not administrators may write
	 * customizations for themselves. The site's policy must also allow
	 * new customizations.
	 *
	 * @param bool $allowed Default true.
	 */
	return true === policy_allows_authoring() && (bool) apply_filters( 'graft_personal_authoring', true );
}

/**
 * Whether the current user may write customizations for themselves.
 *
 * @return bool
 */
function can_author_personal(): bool {
	return current_user_can( 'manage_options' ) || ( current_user_can( 'edit_posts' ) && personal_authoring() );
}

/**
 * Whether a spec is the current user's own personal one.
 *
 * @param string $spec_id Spec id.
 * @return bool
 */
function owns_personal( string $spec_id ): bool {
	$spec  = get_spec_post( $spec_id );
	$scope = $spec ? get_json_meta( $spec->ID, '_graft_scope' ) : null;
	return $spec && 'user' === ( $scope['type'] ?? '' ) && (int) $spec->post_author === get_current_user_id() && get_current_user_id() > 0;
}

/**
 * The scopes a person may grant a customization of their own: the ones
 * that only read, as far as the site's policy allows them at all. The
 * gateway still runs every call as that person, so such a customization
 * shows them nothing they could not already see.
 *
 * @return string[]
 */
function self_service_scopes(): array {
	$scopes = array_values(
		array_filter(
			array_map( 'strval', array_keys( surface_scopes() ) ),
			static fn( string $scope ): bool => ':read' === substr( $scope, -5 ) && true === policy_allows_scopes( array( $scope ) )
		)
	);
	/**
	 * Filters the scopes people may grant customizations of their own
	 * without an administrator. Return an empty list to have every
	 * personal customization approved by an administrator.
	 *
	 * @param string[] $scopes Default: the scopes that only read.
	 */
	return array_values( array_intersect( (array) apply_filters( 'graft_self_service_scopes', $scopes ), array_map( 'strval', array_keys( surface_scopes() ) ) ) );
}

/**
 * Whether a version goes live without an administrator: it is its owner's
 * alone, it does not act on its own, and all it asks for (in its spec and
 * in this build) is what people may grant themselves.
 *
 * @param array<string, mixed> $record Version record.
 * @param array<string, mixed> $build  The build about to be served.
 * @return bool
 */
function self_approvable( array $record, array $build ): bool {
	if ( 'user' !== ( $record['scope']['type'] ?? '' ) || ! empty( $record['manifest']['triggers'] ) || ! empty( $build['triggers'] ) ) {
		return false;
	}
	if ( null !== managed_by( (string) $record['spec_id'] ) || ! personal_authoring() || true !== policy_allows_manifest( (array) $record['manifest'] ) ) {
		return false;
	}
	$wanted = array_unique( array_merge( (array) ( $record['manifest']['permissions'] ?? array() ), build_scopes( $build ) ) );
	return array() === array_diff( $wanted, self_service_scopes() );
}

/**
 * Counts a model call against the current user's day, or refuses it.
 * Administrators are not counted: they spend the site's calls on the
 * site's customizations.
 *
 * @return true|WP_Error
 */
function spend_generate_call() {
	if ( current_user_can( 'manage_options' ) ) {
		return true;
	}
	/**
	 * Filters how many model calls a person who is not an administrator
	 * may make a day when writing customizations for themselves.
	 *
	 * @param int $limit   Default PERSONAL_GENERATE_LIMIT.
	 * @param int $user_id User.
	 */
	$limit = (int) apply_filters( 'graft_personal_generate_limit', PERSONAL_GENERATE_LIMIT, get_current_user_id() );
	$today = gmdate( 'Y-m-d' );
	$spent = get_user_meta( get_current_user_id(), '_graft_generate_calls', true );
	$count = is_array( $spent ) && ( $spent['day'] ?? '' ) === $today ? (int) $spent['count'] : 0;
	if ( $count >= $limit ) {
		return new WP_Error(
			'graft_generate_limit',
			__( 'You have built as much as one person may in a day on this site. Try again tomorrow, or ask an administrator.', 'graft' ),
			array( 'status' => 429 )
		);
	}
	update_user_meta(
		get_current_user_id(),
		'_graft_generate_calls',
		array(
			'day'   => $today,
			'count' => $count + 1,
		)
	);
	return true;
}
