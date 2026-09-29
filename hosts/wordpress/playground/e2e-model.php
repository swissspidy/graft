<?php
/**
 * Scripted model for the end-to-end tests (loaded as a must-use plugin on
 * the e2e site only): answers /graft/v1/generate from
 * /graft-fixtures/model.json, keyed by compiler phase.
 */

defined( 'ABSPATH' ) || exit;

add_filter(
	'graft_pre_generate',
	static function ( $response, array $args ) {
		$answers = json_decode( (string) file_get_contents( '/graft-fixtures/model.json' ), true );
		if ( ! isset( $answers[ $args['purpose'] ] ) ) {
			return new WP_Error( 'graft_no_scripted_answer', 'No scripted answer.', array( 'status' => 500 ) );
		}
		return array(
			'output' => $answers[ $args['purpose'] ],
			'model'  => 'scripted-e2e',
		);
	},
	10,
	2
);
