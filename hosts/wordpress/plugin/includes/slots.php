<?php
/**
 * Mounts servable specs into their slots.
 *
 * @package Graft
 */

namespace Graft;

use WP_Post;

/**
 * Admin menu parents for admin.page's `menu.parent` option.
 *
 * @return array<string, string>
 */
function menu_parents(): array {
	return array(
		'dashboard'  => 'index.php',
		'posts'      => 'edit.php',
		'media'      => 'upload.php',
		'pages'      => 'edit.php?post_type=page',
		'comments'   => 'edit-comments.php',
		'appearance' => 'themes.php',
		'plugins'    => 'plugins.php',
		'users'      => 'users.php',
		'tools'      => 'tools.php',
		'settings'   => 'options-general.php',
	);
}

/**
 * Specs mounted in a slot.
 *
 * @param string $slot Slot id.
 * @return array<string, array{record: array<string, mixed>, build: array<string, mixed>}>
 */
function specs_in_slot( string $slot ): array {
	return array_filter(
		servable_specs(),
		static function ( array $entry ) use ( $slot ): bool {
			return ( $entry['build']['mount']['slot'] ?? '' ) === $slot;
		}
	);
}

/**
 * Slot admin.page: one admin page per spec.
 */
function mount_admin_pages(): void {
	$parents = menu_parents();
	foreach ( specs_in_slot( 'admin.page' ) as $spec_id => $entry ) {
		$menu     = $entry['build']['mount']['menu'] ?? array();
		// WordPress prints menu titles as HTML.
		$title    = esc_html( (string) ( $menu['title'] ?? $entry['record']['title'] ) );
		$slug     = 'graft-' . $spec_id;
		$callback = static function () use ( $spec_id ): void {
			echo '<div class="wrap graft-page">' . mount_point( $spec_id ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- mount_point() escapes.
		};
		if ( isset( $parents[ $menu['parent'] ?? '' ] ) ) {
			add_submenu_page( $parents[ $menu['parent'] ], $title, $title, 'read', $slug, $callback );
		} else {
			add_menu_page( $title, $title, 'read', $slug, $callback, 'dashicons-admin-generic' );
		}
	}
}

/**
 * Slot dashboard.widget: one Dashboard widget per spec.
 */
function mount_dashboard_widgets(): void {
	foreach ( specs_in_slot( 'dashboard.widget' ) as $spec_id => $entry ) {
		wp_add_dashboard_widget(
			'graft-' . $spec_id,
			esc_html( (string) ( $entry['build']['mount']['title'] ?? $entry['record']['title'] ) ),
			static function () use ( $spec_id ): void {
				echo mount_point( $spec_id ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- mount_point() escapes.
			}
		);
	}
}

/**
 * The post type a spec's slot is for (the slot's post_type option).
 *
 * @param array<string, mixed> $entry Servable spec.
 * @return string
 */
function mount_post_type( array $entry ): string {
	return (string) ( $entry['build']['mount']['post_type'] ?? 'post' );
}

/**
 * Slot posts.list.row-actions: a row action on the list screen of the
 * spec's post type, given the row's post. Hooked to post_row_actions and,
 * for hierarchical types such as pages, page_row_actions.
 *
 * @param array<string, string> $actions Row actions.
 * @param WP_Post               $post    Row post.
 * @return array<string, string>
 */
function mount_row_actions( array $actions, WP_Post $post ): array {
	$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
	if ( ! $screen || 'edit-' . $post->post_type !== $screen->id ) {
		return $actions;
	}
	foreach ( specs_in_slot( 'posts.list.row-actions' ) as $spec_id => $entry ) {
		if ( mount_post_type( $entry ) === $post->post_type ) {
			$actions[ 'graft-' . $spec_id ] = mount_point( $spec_id, post_slot_props( $post ), 'span' );
		}
	}
	return $actions;
}

/**
 * Slot props for a post row, for the current user. Shared by the live Posts
 * screen and the verification sandbox so builds see the same data in both.
 *
 * @param WP_Post $post Post.
 * @return array<string, mixed>
 */
function post_slot_props( WP_Post $post ): array {
	return array(
		'post' => array(
			'id'     => $post->ID,
			'title'  => get_the_title( $post ),
			'status' => $post->post_status,
			'type'   => $post->post_type,
			'meta'   => (object) post_meta_values( $post ),
			'terms'  => (object) post_term_values( $post ),
			'can'    => array(
				'edit'    => current_user_can( 'edit_post', $post->ID ),
				'publish' => current_user_can( 'publish_post', $post->ID ),
			),
		),
	);
}

/**
 * Slot props for the post being edited, for the current user. The title and
 * excerpt are as saved, unformatted: what the editor shows. Shared with the
 * verification sandbox.
 *
 * @param WP_Post $post Post.
 * @return array<string, mixed>
 */
function editor_slot_props( WP_Post $post ): array {
	return array(
		'post' => array(
			'id'      => $post->ID,
			'title'   => $post->post_title,
			'excerpt' => $post->post_excerpt,
			'status'  => $post->post_status,
			'type'    => $post->post_type,
			'meta'    => (object) post_meta_values( $post ),
			'terms'   => (object) post_term_values( $post ),
			'can'     => array(
				'edit'    => current_user_can( 'edit_post', $post->ID ),
				'publish' => current_user_can( 'publish_post', $post->ID ),
			),
		),
	);
}

/**
 * Slot post.editor.panel: on the block editor for a saved post, marks the
 * specs to render and returns what the runtime needs to put them in the
 * sidebar (see editor_runtime_config()).
 */
function mount_editor_panels(): void {
	$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
	$post   = get_post();
	if ( ! $screen || 'post' !== $screen->base || ! $screen->is_block_editor() || ! $post || ! is_exposed_post_type( $post->post_type ) ) {
		return;
	}
	// A new post is not saved yet: an action would change another post than the one reloaded.
	if ( 'auto-draft' === $post->post_status || ! current_user_can( 'edit_post', $post->ID ) ) {
		return;
	}
	$panels = array();
	foreach ( specs_in_slot( 'post.editor.panel' ) as $spec_id => $entry ) {
		if ( mount_post_type( $entry ) !== $post->post_type ) {
			continue;
		}
		rendered_specs( $spec_id );
		$panels[] = array(
			'spec'  => $spec_id,
			'title' => (string) ( $entry['build']['mount']['title'] ?? $entry['record']['title'] ),
		);
	}
	if ( $panels ) {
		editor_runtime_config(
			array(
				'panels' => $panels,
				'slot'   => (object) editor_slot_props( $post ),
			)
		);
	}
}

/**
 * The editor panels on this screen, once mount_editor_panels() has run.
 *
 * @param array<string, mixed>|null $config Sets the config when given.
 * @return array<string, mixed>|null
 */
function editor_runtime_config( ?array $config = null ): ?array {
	static $current = null;
	if ( null !== $config ) {
		$current = $config;
	}
	return $current;
}
