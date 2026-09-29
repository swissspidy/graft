import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The customization the browser test writes in the admin: the drafts widget
 * under another id. The e2e server's model stub answers with the example's
 * build (checks, then tree).
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));

export const authoredSpec = readFileSync(`${root}examples/emdash/specs/drafts-glance.md`, 'utf8')
	.replace('id: drafts-glance', 'id: recent-drafts')
	.replace('title: Drafts', 'title: Recent drafts')
	.replace('# Drafts at a glance', '# Recent drafts');

export const authoredBuildFile = `${root}examples/emdash/builds/drafts-glance.json`;
