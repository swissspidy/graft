/**
 * Maps the A2UI basic catalog icon names onto `@wordpress/icons`.
 * A few names have no close equivalent; those fall back to a neighbour
 * (for example the volume icons use the generic audio icon).
 */
import * as icons from '@wordpress/icons';

type IconElement = ( typeof icons )[ 'check' ];

const ICON_MAP: Record< string, IconElement > = {
	accountCircle: icons.commentAuthorAvatar,
	add: icons.plus,
	arrowBack: icons.arrowLeft,
	arrowForward: icons.arrowRight,
	attachFile: icons.file,
	calendarToday: icons.calendar,
	call: icons.mobile,
	camera: icons.capturePhoto,
	check: icons.check,
	close: icons.close,
	delete: icons.trash,
	download: icons.download,
	edit: icons.pencil,
	event: icons.calendar,
	error: icons.error,
	fastForward: icons.next,
	favorite: icons.starFilled,
	favoriteOff: icons.starEmpty,
	folder: icons.archive,
	help: icons.help,
	home: icons.home,
	info: icons.info,
	locationOn: icons.mapMarker,
	lock: icons.lock,
	lockOpen: icons.unlock,
	mail: icons.envelope,
	menu: icons.menu,
	moreVert: icons.moreVertical,
	moreHoriz: icons.moreHorizontal,
	notificationsOff: icons.bell,
	notifications: icons.bellUnread,
	pause: icons.pause,
	payment: icons.payment,
	person: icons.people,
	phone: icons.mobile,
	photo: icons.image,
	play: icons.play,
	print: icons.page,
	refresh: icons.update,
	rewind: icons.previous,
	search: icons.search,
	send: icons.send,
	settings: icons.settings,
	share: icons.share,
	shoppingCart: icons.cart,
	skipNext: icons.skipForward,
	skipPrevious: icons.skipBack,
	star: icons.starFilled,
	starHalf: icons.starHalf,
	starOff: icons.starEmpty,
	stop: icons.square,
	upload: icons.upload,
	visibility: icons.seen,
	visibilityOff: icons.unseen,
	volumeDown: icons.audio,
	volumeMute: icons.audio,
	volumeOff: icons.audio,
	volumeUp: icons.audio,
	warning: icons.caution,
};

export function getWordPressIcon( name: string ): IconElement | undefined {
	return ICON_MAP[ name ];
}

export const SUPPORTED_ICON_NAMES = Object.keys( ICON_MAP );
