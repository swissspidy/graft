<?php
/**
 * Proof of concept: Posts → Review queue (A2UI) draws the A2UI version of
 * the review-queue build. Capability calls go through the Graft gateway
 * as the approved review-queue customization (same capabilities and
 * grant), and the viewer's scopes come from Graft, as for any build.
 */

add_action(
	'admin_menu',
	static function () {
		$servable = \Graft\servable_specs();
		if ( ! isset( $servable['review-queue'] ) ) {
			return;
		}
		add_posts_page(
			'Review queue (A2UI)',
			'Review queue (A2UI)',
			'edit_posts',
			'graft-a2ui',
			static function () use ( $servable ) {
				$build = json_decode( (string) file_get_contents( __DIR__ . '/review-queue.a2ui.json' ), true );
				$config = array(
					'spec'   => 'review-queue',
					'build'  => $build,
					'scopes' => (object) \Graft\usable_scopes( $servable['review-queue']['record'] ),
				);
				echo '<div class="wrap"><div id="graft-a2ui"></div></div>';
				printf( '<script>window.graftA2UI = %s;</script>', wp_json_encode( $config ) );
				wp_enqueue_script( 'graft-a2ui', content_url( 'graft-a2ui/build/client.js' ), array( 'react', 'react-dom', 'react-jsx-runtime', 'wp-components', 'wp-api-fetch', 'wp-element', 'wp-i18n' ), (string) filemtime( __DIR__ . '/build/client.js' ), true );
				wp_enqueue_style( 'wp-components' );
			}
		);
	}
);

/*
 * Post editor → "Publish checklist (A2UI)": the compiled A2UI build of
 * publish-checklist in the block editor's sidebar, served as the approved
 * publish-checklist customization, with the slot's post as the tree runtime
 * gets it.
 */
add_action(
	'enqueue_block_editor_assets',
	static function () {
		$servable = \Graft\servable_specs();
		$post     = get_post();
		$file     = __DIR__ . '/compiled/publish-checklist.a2ui.json';
		if ( ! isset( $servable['publish-checklist'] ) || ! $post || 'auto-draft' === $post->post_status || ! current_user_can( 'edit_post', $post->ID ) || ! file_exists( $file ) ) {
			return;
		}
		$config = array(
			'spec'   => 'publish-checklist',
			'build'  => json_decode( (string) file_get_contents( $file ), true ),
			'scopes' => (object) \Graft\usable_scopes( $servable['publish-checklist']['record'] ),
			'slot'   => (object) \Graft\editor_slot_props( $post ),
			'panel'  => 'Publish checklist (A2UI)',
		);
		wp_enqueue_script( 'graft-a2ui', content_url( 'graft-a2ui/build/client.js' ), array( 'react', 'react-dom', 'react-jsx-runtime', 'wp-components', 'wp-api-fetch', 'wp-element', 'wp-i18n', 'wp-plugins', 'wp-editor' ), (string) filemtime( __DIR__ . '/build/client.js' ), true );
		wp_add_inline_script( 'graft-a2ui', sprintf( 'window.graftA2UI = %s;', wp_json_encode( $config ) ), 'before' );
	}
);
