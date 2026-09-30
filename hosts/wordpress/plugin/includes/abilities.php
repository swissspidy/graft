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
			'meta'     => meta_schema(),
			'terms'    => terms_schema(),
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
		'required'             => array( 'id', 'title', 'status', 'type', 'author', 'date', 'modified', 'meta', 'terms', 'can' ),
		'additionalProperties' => false,
	);

	wp_register_ability(
		'graft/posts-list',
		array(
			'label'               => __( 'List posts', 'graft' ),
			'description'         => __( 'Lists posts of one type the current user can edit, filtered by status and optionally by a term, newest first unless ordered otherwise.', 'graft' ),
			'category'            => ABILITY_CATEGORY,
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'post_type' => array(
						'type'    => 'string',
						'enum'    => exposed_post_types(),
						'default' => 'post',
					),
					'term'      => array(
						'description'          => __( 'Only posts with this term.', 'graft' ),
						'type'                 => 'object',
						'properties'           => array(
							'taxonomy' => array(
								'type' => 'string',
								'enum' => array_keys( content_model()['taxonomies'] ),
							),
							'slug'     => array(
								'type'      => 'string',
								'minLength' => 1,
							),
						),
						'required'             => array( 'taxonomy', 'slug' ),
						'additionalProperties' => false,
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
						'description' => __( 'meta.<key> orders by a custom field; posts without a value come first in ascending order.', 'graft' ),
						'type'        => 'string',
						'enum'        => array_merge( array( 'date', 'modified', 'title' ), meta_orderby() ),
						'default'     => 'date',
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

	register_content_abilities( $post_item );
}

/**
 * Registers the abilities for custom fields and terms, when the site
 * exposes any (see content-model.php).
 *
 * @param array<string, mixed> $post_item Output schema of a post.
 */
function register_content_abilities( array $post_item ): void {
	$model    = content_model();
	$writable = array(
		'readonly'    => false,
		'destructive' => false,
		'idempotent'  => true,
	);
	$meta     = meta_schema();
	if ( array() !== $meta['properties'] ) {
		$fields = $meta;
		unset( $fields['description'] );
		$fields['minProperties'] = 1;
		wp_register_ability(
			'graft/post-update-meta',
			array(
				'label'               => __( 'Change custom fields', 'graft' ),
				'description'         => __( "Changes custom fields of one post. Only the fields the site exposes for the post's type; null removes a value.", 'graft' ),
				'category'            => ABILITY_CATEGORY,
				'input_schema'        => array(
					'type'                 => 'object',
					'properties'           => array(
						'id'   => array(
							'type'    => 'integer',
							'minimum' => 1,
						),
						'meta' => $fields,
					),
					'required'             => array( 'id', 'meta' ),
					'additionalProperties' => false,
				),
				'output_schema'       => $post_item,
				'execute_callback'    => __NAMESPACE__ . '\execute_post_update_meta',
				'permission_callback' => __NAMESPACE__ . '\can_update_post_meta',
				'meta'                => array(
					'annotations'  => $writable,
					'show_in_rest' => true,
				),
			)
		);
	}
	if ( array() === $model['taxonomies'] ) {
		return;
	}
	$taxonomy = array(
		'type' => 'string',
		'enum' => array_keys( $model['taxonomies'] ),
	);
	wp_register_ability(
		'graft/post-set-terms',
		array(
			'label'               => __( 'Set terms', 'graft' ),
			'description'         => __( "Changes a post's terms in one taxonomy, by slug: replaces them (an empty list removes them all), adds to them, or removes some. Only existing terms.", 'graft' ),
			'category'            => ABILITY_CATEGORY,
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'id'       => array(
						'type'    => 'integer',
						'minimum' => 1,
					),
					'taxonomy' => $taxonomy,
					'terms'    => array(
						'type'        => 'array',
						'items'       => array(
							'type'      => 'string',
							'minLength' => 1,
						),
						'maxItems'    => 50,
						'uniqueItems' => true,
					),
					'mode'     => array(
						'type'    => 'string',
						'enum'    => array( 'replace', 'add', 'remove' ),
						'default' => 'replace',
					),
				),
				'required'             => array( 'id', 'taxonomy', 'terms' ),
				'additionalProperties' => false,
			),
			'output_schema'       => $post_item,
			'execute_callback'    => __NAMESPACE__ . '\execute_post_set_terms',
			'permission_callback' => __NAMESPACE__ . '\can_set_post_terms',
			'meta'                => array(
				'annotations'  => $writable,
				'show_in_rest' => true,
			),
		)
	);
	wp_register_ability(
		'graft/terms-list',
		array(
			'label'               => __( 'List terms', 'graft' ),
			'description'         => __( 'Lists the terms of one taxonomy, by name.', 'graft' ),
			'category'            => ABILITY_CATEGORY,
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'taxonomy' => $taxonomy,
					'search'   => array( 'type' => 'string' ),
					'per_page' => array(
						'type'    => 'integer',
						'minimum' => 1,
						'maximum' => 100,
						'default' => 100,
					),
				),
				'required'             => array( 'taxonomy' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'                 => 'object',
				'properties'           => array(
					'items' => array(
						'type'  => 'array',
						'items' => term_schema( true ),
					),
				),
				'required'             => array( 'items' ),
				'additionalProperties' => false,
			),
			'execute_callback'    => __NAMESPACE__ . '\execute_terms_list',
			'permission_callback' => __NAMESPACE__ . '\can_list_terms',
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
}

/**
 * Whether the current user may change these custom fields of the post:
 * each must be exposed for its type, and WordPress must allow editing it.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_update_post_meta( $input = null ) {
	$post = input_post( $input );
	if ( is_wp_error( $post ) ) {
		return $post;
	}
	if ( ! current_user_can( 'edit_post', $post->ID ) ) {
		return false;
	}
	$fields = exposed_fields( $post->post_type );
	foreach ( array_keys( (array) ( $input['meta'] ?? array() ) ) as $key ) {
		if ( ! isset( $fields[ $key ] ) ) {
			/* translators: 1: meta key, 2: post type. */
			return new WP_Error( 'graft_field_not_exposed', sprintf( __( 'Posts of type %2$s have no field %1$s.', 'graft' ), $key, $post->post_type ) );
		}
		if ( ! current_user_can( 'edit_post_meta', $post->ID, $key ) ) {
			return false;
		}
	}
	return true;
}

/**
 * Changes custom fields. WordPress sanitizes each value with the callback
 * its field was registered with.
 *
 * @param array<string, mixed> $input Ability input.
 * @return array<string, mixed>|WP_Error
 */
function execute_post_update_meta( $input ) {
	$id = (int) $input['id'];
	foreach ( (array) $input['meta'] as $key => $value ) {
		if ( null === $value ) {
			delete_post_meta( $id, $key );
		} elseif ( false === update_post_meta( $id, $key, wp_slash( $value ) ) && get_post_meta( $id, $key, true ) != $value ) { // phpcs:ignore Universal.Operators.StrictComparisons.LooseNotEqual -- stored values are strings.
			/* translators: %s: meta key. */
			return new WP_Error( 'graft_field_not_saved', sprintf( __( 'Could not save %s.', 'graft' ), $key ) );
		}
	}
	clean_post_cache( $id );
	return prepare_post( get_post( $id ) );
}

/**
 * Whether the current user may set the post's terms in the taxonomy.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_set_post_terms( $input = null ) {
	$post = input_post( $input );
	if ( is_wp_error( $post ) ) {
		return $post;
	}
	$name = (string) ( $input['taxonomy'] ?? '' );
	if ( ! in_array( $name, exposed_taxonomies( $post->post_type ), true ) ) {
		/* translators: 1: taxonomy, 2: post type. */
		return new WP_Error( 'graft_taxonomy_not_exposed', sprintf( __( 'Posts of type %2$s have no taxonomy %1$s.', 'graft' ), $name, $post->post_type ) );
	}
	return current_user_can( 'edit_post', $post->ID ) && current_user_can( get_taxonomy( $name )->cap->assign_terms );
}

/**
 * Replaces, adds to or removes from the post's terms in one taxonomy. Only
 * existing terms: creating terms is a different permission.
 *
 * @param array<string, mixed> $input Ability input.
 * @return array<string, mixed>|WP_Error
 */
function execute_post_set_terms( $input ) {
	$ids = array();
	foreach ( (array) $input['terms'] as $slug ) {
		$term = get_term_by( 'slug', $slug, $input['taxonomy'] );
		if ( ! $term ) {
			/* translators: %s: term slug. */
			return new WP_Error( 'graft_term_not_found', sprintf( __( 'There is no term %s.', 'graft' ), $slug ) );
		}
		$ids[] = (int) $term->term_id;
	}
	$mode   = $input['mode'] ?? 'replace';
	$result = 'remove' === $mode
		? wp_remove_object_terms( (int) $input['id'], $ids, $input['taxonomy'] )
		: wp_set_object_terms( (int) $input['id'], $ids, $input['taxonomy'], 'add' === $mode );
	if ( is_wp_error( $result ) ) {
		return $result;
	}
	clean_post_cache( (int) $input['id'] );
	return prepare_post( get_post( (int) $input['id'] ) );
}

/**
 * Whether the current user may list the terms of the taxonomy: those who
 * may assign them.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_list_terms( $input = null ) {
	$name = (string) ( ( is_array( $input ) ? $input : array() )['taxonomy'] ?? '' );
	if ( ! isset( content_model()['taxonomies'][ $name ] ) ) {
		return new WP_Error( 'graft_taxonomy_not_exposed', __( 'Unknown taxonomy.', 'graft' ) );
	}
	return current_user_can( get_taxonomy( $name )->cap->assign_terms );
}

/**
 * Lists terms.
 *
 * @param array<string, mixed> $input Ability input.
 * @return array<string, mixed>
 */
function execute_terms_list( $input ): array {
	$args = array(
		'taxonomy'   => $input['taxonomy'],
		'hide_empty' => false,
		'number'     => (int) ( $input['per_page'] ?? 100 ),
		'orderby'    => 'name',
	);
	if ( ! empty( $input['search'] ) ) {
		$args['search'] = $input['search'];
	}
	$terms = get_terms( $args );
	$items = array();
	foreach ( is_array( $terms ) ? $terms : array() as $term ) {
		$items[] = prepare_term_ref( $term ) + array( 'count' => (int) $term->count );
	}
	return array( 'items' => $items );
}

/**
 * The post an ability input names, or an error when there is none or its
 * type is not exposed to Graft.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return \WP_Post|WP_Error
 */
function input_post( $input ) {
	$input = is_array( $input ) ? $input : array();
	$post  = get_post( (int) ( $input['id'] ?? 0 ) );
	if ( ! $post || ! is_exposed_post_type( $post->post_type ) ) {
		return new WP_Error( 'graft_post_not_found', __( 'Post not found.', 'graft' ) );
	}
	return $post;
}

/**
 * Whether the current user may edit the post's fields.
 *
 * @param array<string, mixed>|null $input Ability input.
 * @return bool|WP_Error
 */
function can_update_post_fields( $input = null ) {
	$post = input_post( $input );
	return is_wp_error( $post ) ? $post : current_user_can( 'edit_post', $post->ID );
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
	if ( ! $post_type || ! is_exposed_post_type( $post_type->name ) ) {
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
	if ( isset( $input['term'] ) ) {
		$args['tax_query'] = array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query
			array(
				'taxonomy' => $input['term']['taxonomy'],
				'field'    => 'slug',
				'terms'    => $input['term']['slug'],
			),
		);
	}
	if ( 0 === strpos( $input['orderby'], 'meta.' ) ) {
		$key    = substr( $input['orderby'], 5 );
		$fields = exposed_fields( $input['post_type'] );
		$type   = in_array( $fields[ $key ]['type'] ?? 'string', array( 'integer', 'number' ), true ) ? 'NUMERIC' : 'CHAR';
		// A named EXISTS clause orders by the field without dropping posts that have no value.
		$args['meta_query'] = array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
			'relation'    => 'OR',
			'graft_order' => array(
				'key'     => $key,
				'compare' => 'EXISTS',
				'type'    => $type,
			),
			array(
				'key'     => $key,
				'compare' => 'NOT EXISTS',
			),
		);
		$args['orderby']    = array( 'graft_order' => strtoupper( $input['order'] ) );
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
	$post = input_post( $input );
	if ( is_wp_error( $post ) ) {
		return $post;
	}
	$input = (array) $input;
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
		'meta'     => (object) post_meta_values( $post ),
		'terms'    => (object) post_term_values( $post ),
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
