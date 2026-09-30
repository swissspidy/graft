<?php
/**
 * Abilities the Graft surface exposes as capabilities.
 *
 * Core only ships read-only site and user abilities so far, so Graft
 * registers the content abilities its components need under the graft/
 * namespace. When core ships equivalents, the capability map in surface.php
 * points at the core ability instead and the surface records a migration.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_Query;

const ABILITY_CATEGORY = 'graft';

/**
 * Post statuses Graft reads and writes.
 *
 * @return string[]
 */
function post_statuses(): array {
	return array( 'publish', 'future', 'draft', 'pending', 'private' );
}

/**
 * Registers the ability category.
 */
function register_ability_category(): void {
	wp_register_ability_category(
		ABILITY_CATEGORY,
		array(
			'label'       => __( 'Graft', 'graft' ),
			'description' => __( 'Content abilities used by Graft customizations.', 'graft' ),
		)
	);
}

/**
 * Registers the Graft abilities.
 */
function register_abilities(): void {
	$post_item = array(
		'type'                 => 'object',
		'properties'           => array(
			'id'       => array( 'type' => 'integer' ),
			'title'    => array( 'type' => 'string' ),
			'status'   => array(
				'type' => 'string',
				'enum' => post_statuses(),
			),
			'type'     => array( 'type' => 'string' ),
			'author'   => array(
				'type'                 => 'object',
				'properties'           => array(
					'id'   => array( 'type' => 'integer' ),
					'name' => array( 'type' => 'string' ),
				),
				'required'             => array( 'id', 'name' ),
				'additionalProperties' => false,
			),
			'date'     => array(
				'type'   => 'string',
				'format' => 'date-time',
			),
			'modified' => array(
				'type'   => 'string',
				'format' => 'date-time',
			),
			'edit_url' => array(
				'type'   => 'string',
				'format' => 'uri',
			),
			'can'      => array(
				'description'          => __( 'What the current user may do with this post.', 'graft' ),
				'type'                 => 'object',
				'properties'           => array(
					'edit'    => array( 'type' => 'boolean' ),
					'publish' => array( 'type' => 'boolean' ),
				),
				'required'             => array( 'edit', 'publish' ),
				'additionalProperties' => false,
			),
		),
		'required'             => array( 'id', 'title', 'status', 'type', 'author', 'date', 'modified', 'can' ),
		'additionalProperties' => false,
	);

	wp_register_ability(
		'graft/posts-list',
		array(
			'label'               => __( 'List posts', 'graft' ),
			'description'         => __( 'Lists posts the current user can edit, filtered by status, newest first.', 'graft' ),
			'category'            => ABILITY_CATEGORY,
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'post_type' => array(
						'type'    => 'string',
						'default' => 'post',
					),
					'status'    => array(
						'type'     => 'array',
						'items'    => array(
							'type' => 'string',
							'enum' => post_statuses(),
						),
						'minItems' => 1,
					),
					'search'    => array( 'type' => 'string' ),
					'per_page'  => array(
						'type'    => 'integer',
						'minimum' => 1,
						'maximum' => 100,
						'default' => 20,
					),
					'page'      => array(
						'type'    => 'integer',
						'minimum' => 1,
						'default' => 1,
					),
					'orderby'   => array(
						'type'    => 'string',
						'enum'    => array( 'date', 'modified', 'title' ),
						'default' => 'date',
					),
					'order'     => array(
						'type'    => 'string',
						'enum'    => array( 'asc', 'desc' ),
						'default' => 'desc',
					),
				),
				'additionalProperties' => false,
				'default'              => array(),
			),
			'output_schema'       => array(
				'type'                 => 'object',
				'properties'           => array(
					'items' => array(
						'type'  => 'array',
						'items' => $post_item,
					),
					'total' => array( 'type' => 'integer' ),
					'pages' => array( 'type' => 'integer' ),
				),
				'required'             => array( 'items', 'total', 'pages' ),
				'additionalProperties' => false,
			),
			'execute_callback'    => __NAMESPACE__ . '\execute_posts_list',
			'permission_callback' => __NAMESPACE__ . '\can_list_posts',
			'meta'                => array(
				'annotations'  => array(
					'readonly'    => true,
					'destructive' => false,
					'idempotent'  => true,
				),
				'show_in_rest' => true,
			),
		)
	);

	wp_register_ability(
		'graft/post-update-fields',
		array(
			'label'               => __( 'Change post title or excerpt', 'graft' ),
			'description'         => __( "Changes the title, the excerpt, or both, of one post. The post's content, status and other fields stay as they are.", 'graft' ),
			'category'            => ABILITY_CATEGORY,
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'id'      => array(
						'type'    => 'integer',
						'minimum' => 1,
					),
					'title'   => array(
						'type'      => 'string',
						'minLength' => 1,
						'maxLength' => 200,
					),
					'excerpt' => array(
						'type'      => 'string',
						'maxLength' => 1000,
					),
				),
				'required'             => array( 'id' ),
				'minProperties'        => 2,
				'additionalProperties' => false,
			),
			'output_schema'       => $post_item,
			'execute_callback'    => __NAMESPACE__ . '\execute_post_update_fields',
			'permission_callback' => __NAMESPACE__ . '\can_update_post_fields',
			'meta'                => array(
				'annotations'  => array(
					'readonly'    => false,
					'destructive' => false,
					'idempotent'  => true,
				),
				'show_in_rest' => true,
			),
		)
	);

	wp_register_ability(
		'graft/post-update-status',
		array(
			'label'               => __( 'Change post status', 'graft' ),
			'description'         => __( 'Changes the status of one post, for example to publish a pending post.', 'graft' ),
			'category'            => ABILITY_CATEGORY,
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'id'     => array(
						'type'    => 'integer',
						'minimum' => 1,
					),
					'status' => array(
						'type' => 'string',
						'enum' => array( 'publish', 'draft', 'pending', 'private' ),
					),
				),
				'required'             => array( 'id', 'status' ),
				'additionalProperties' => false,
			),
			'output_schema'       => $post_item,
			'execute_callback'    => __NAMESPACE__ . '\execute_post_update_status',
			'permission_callback' => __NAMESPACE__ . '\can_update_post_status',
			'meta'                => array(
				'annotations'  => array(
					'readonly'    => false,
					'destructive' => false,
					'idempotent'  => true,
				),
				'show_in_rest' => true,
			),
		)
	);
}

/**
 * Whether the current user may edit the post's fields.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_update_post_fields( $input = null ) {
	$input = is_array( $input ) ? $input : array();
	$post  = get_post( (int) ( $input['id'] ?? 0 ) );
	if ( ! $post ) {
		return new WP_Error( 'graft_post_not_found', __( 'Post not found.', 'graft' ) );
	}
	return current_user_can( 'edit_post', $post->ID );
}

/**
 * Changes a post's title and/or excerpt, as plain text.
 *
 * @param array<string, mixed> $input Ability input.
 * @return array<string, mixed>|WP_Error
 */
function execute_post_update_fields( $input ) {
	$post    = get_post( (int) $input['id'] );
	$changes = array( 'ID' => (int) $input['id'] );
	// A field sent back as it is stored stays untouched, so saving a new
	// title does not strip markup from an excerpt nobody edited.
	if ( isset( $input['title'] ) && ( ! $post || (string) $input['title'] !== $post->post_title ) ) {
		$changes['post_title'] = sanitize_text_field( (string) $input['title'] );
	}
	if ( isset( $input['excerpt'] ) && ( ! $post || (string) $input['excerpt'] !== $post->post_excerpt ) ) {
		$changes['post_excerpt'] = sanitize_textarea_field( (string) $input['excerpt'] );
	}
	$result = wp_update_post( wp_slash( $changes ), true );
	if ( is_wp_error( $result ) ) {
		return $result;
	}
	clean_post_cache( $result );
	return prepare_post( get_post( $result ) );
}

/**
 * Whether the current user may list posts of the requested type.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_list_posts( $input = null ) {
	$input     = is_array( $input ) ? $input : array();
	$post_type = get_post_type_object( $input['post_type'] ?? 'post' );
	if ( ! $post_type || ! $post_type->show_ui ) {
		return new WP_Error( 'graft_invalid_post_type', __( 'Unknown post type.', 'graft' ) );
	}
	return current_user_can( $post_type->cap->edit_posts );
}

/**
 * Lists posts.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return array<string, mixed>
 */
function execute_posts_list( $input = null ): array {
	$input = wp_parse_args(
		is_array( $input ) ? $input : array(),
		array(
			'post_type' => 'post',
			'status'    => array( 'publish', 'future', 'draft', 'pending', 'private' ),
			'per_page'  => 20,
			'page'      => 1,
			'orderby'   => 'date',
			'order'     => 'desc',
		)
	);

	$args = array(
		'post_type'           => $input['post_type'],
		'post_status'         => $input['status'],
		'posts_per_page'      => $input['per_page'],
		'paged'               => $input['page'],
		'orderby'             => $input['orderby'],
		'order'               => strtoupper( $input['order'] ),
		'perm'                => 'editable',
		'ignore_sticky_posts' => true,
		'no_found_rows'       => false,
	);
	if ( ! empty( $input['search'] ) ) {
		$args['s'] = $input['search'];
	}

	$query = new WP_Query( $args );

	return array(
		'items' => array_map( __NAMESPACE__ . '\prepare_post', $query->posts ),
		'total' => (int) $query->found_posts,
		'pages' => (int) $query->max_num_pages,
	);
}

/**
 * Whether the current user may move a post to the requested status.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_update_post_status( $input = null ) {
	$input = is_array( $input ) ? $input : array();
	$post  = get_post( (int) ( $input['id'] ?? 0 ) );
	if ( ! $post ) {
		return new WP_Error( 'graft_post_not_found', __( 'Post not found.', 'graft' ) );
	}
	if ( ! current_user_can( 'edit_post', $post->ID ) ) {
		return false;
	}
	$status = $input['status'] ?? '';
	if ( in_array( $status, array( 'publish', 'private' ), true ) ) {
		return current_user_can( 'publish_post', $post->ID );
	}
	return true;
}

/**
 * Changes a post's status.
 *
 * @param array<string, mixed> $input Ability input.
 * @return array<string, mixed>|WP_Error
 */
function execute_post_update_status( $input ) {
	$result = wp_update_post(
		array(
			'ID'          => (int) $input['id'],
			'post_status' => $input['status'],
		),
		true
	);
	if ( is_wp_error( $result ) ) {
		return $result;
	}
	clean_post_cache( $result );
	return prepare_post( get_post( $result ) );
}

/**
 * Shapes a post for ability output.
 *
 * @param \WP_Post $post Post.
 * @return array<string, mixed>
 */
function prepare_post( \WP_Post $post ): array {
	$author = get_userdata( (int) $post->post_author );
	$item   = array(
		'id'       => $post->ID,
		'title'    => get_the_title( $post ),
		'status'   => $post->post_status,
		'type'     => $post->post_type,
		'author'   => array(
			'id'   => (int) $post->post_author,
			'name' => $author ? $author->display_name : '',
		),
		'date'     => gmt_date( $post->post_date_gmt, $post->post_date ),
		'modified' => gmt_date( $post->post_modified_gmt, $post->post_modified ),
		'can'      => array(
			'edit'    => current_user_can( 'edit_post', $post->ID ),
			'publish' => current_user_can( 'publish_post', $post->ID ),
		),
	);
	$edit_url = get_edit_post_link( $post->ID, 'raw' );
	if ( $edit_url ) {
		$item['edit_url'] = $edit_url;
	}
	return $item;
}

/**
 * Formats a post date as RFC 3339 in UTC. Unpublished posts have no GMT
 * date yet, so it is derived from the local one.
 *
 * @param string $gmt   GMT date in MySQL format, possibly zero.
 * @param string $local Local date in MySQL format.
 * @return string
 */
function gmt_date( string $gmt, string $local ): string {
	if ( '0000-00-00 00:00:00' === $gmt ) {
		$gmt = get_gmt_from_date( $local );
	}
	return mysql2date( 'Y-m-d\\TH:i:s\\Z', $gmt, false );
}
