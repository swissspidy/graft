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
