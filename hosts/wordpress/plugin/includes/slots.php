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
		$title    = (string) ( $menu['title'] ?? $entry['record']['title'] );
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
 * Slot posts.list.row-actions: a row action on the Posts screen, given the
 * row's post.
 *
 * @param array<string, string> $actions Row actions.
 * @param WP_Post               $post    Row post.
 * @return array<string, string>
 */
function mount_row_actions( array $actions, WP_Post $post ): array {
	$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
	if ( ! $screen || 'edit-post' !== $screen->id ) {
		return $actions;
	}
	foreach ( array_keys( specs_in_slot( 'posts.list.row-actions' ) ) as $spec_id ) {
		$actions[ 'graft-' . $spec_id ] = mount_point(
			$spec_id,
			array(
				'post' => array(
					'id'     => $post->ID,
					'title'  => get_the_title( $post ),
					'status' => $post->post_status,
					'type'   => $post->post_type,
					'can'    => array(
						'edit'    => current_user_can( 'edit_post', $post->ID ),
						'publish' => current_user_can( 'publish_post', $post->ID ),
					),
				),
			),
			'span'
		);
	}
	return $actions;
}
