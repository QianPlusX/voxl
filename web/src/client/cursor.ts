// The remote cursor, drawn locally by the browser so pointer movement has no stream
// latency. Cursor messages: type byte, pad, width, height, hot x, hot y (u16 each),
// serial (u32), then RGBA.
//
// Pad mode draws the same image a second time as an element (#vcur) at the pad
// pointer: on a touchscreen the browser has no pointer of its own, so a CSS cursor
// would stay wherever the last mouse left it.
import type { App } from './app';

// On-screen cursor size bounds in CSS pixels, applied to the image's longer side.
// A phone shows the picture at about a third of desktop size, so the desktop's own
// 24px pointer would cover three desktop pixels of UI; the floor is phone-sized.
const MIN_CURSOR_PX = 9;
const MAX_CURSOR_PX = 128;

/** Windows' standard arrow (32x32, hot spot at 6,2): the pointer pad mode draws.
 * A cursor theme's left_ptr varies per X server and reads badly once a 1280px
 * desktop is squeezed onto a phone, so the aiming pointer is a fixed shape. */
const WINDOWS_CURSOR =
	'data:image/svg+xml,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
			'<path d="M6 2v21l5.5-5 3.5 9 4-1.6-3.5-8.9 7.5-.5z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>' +
			'</svg>'
	);

export interface Cursor {
	set(buf: ArrayBuffer): void;
	apply(): void;
	/** Draw the pointer at this surface position (CSS pixels, from the top left). */
	setPos(x: number, y: number): void;
	setVisible(on: boolean): void;
	/** Redraw at the current zoom, e.g. after the picture was scaled. */
	refresh(): void;
}

export function createCursor(app: App): Cursor {
	let msg: ArrayBuffer | null = null;
	const scaled = document.createElement('canvas');
	const vcur = document.getElementById('vcur') as HTMLImageElement | null;
	let visible = false;
	let pos = { x: 0, y: 0 };
	// Until the first pointer movement the cursor sits in the middle of the surface,
	// whatever its size: at load time the window may not be laid out yet.
	let centered = true;
	// The pad pointer's own size and hotspot, in CSS pixels: it draws the Windows
	// arrow, not the server's cursor image, so the two must not overwrite each other.
	let vhot = { x: 0, y: 0 };
	let vsize = { w: 0, h: 0 };

	function place() {
		if (centered) {
			// Surface layout pixels, not the on-screen box: the picture may be zoomed.
			pos = {
				x: (app.surface.offsetWidth || 1) / 2,
				y: (app.surface.offsetHeight || 1) / 2,
			};
		}
		if (!vcur || !visible) return;
		// The pointer lives inside #surface, so it grows with the picture: the arrow keeps
		// the same size relative to the desktop, which is what makes a 4x zoom usable
		// instead of leaving a phone-sized speck over a magnified screen. Its hotspot
		// scales with it, so the tip still sits on the desktop pixel it points at.
		vcur.style.width = vsize.w + 'px';
		vcur.style.height = vsize.h + 'px';
		vcur.style.transformOrigin = '0 0';
		vcur.style.transform = `translate(${pos.x - vhot.x}px, ${pos.y - vhot.y}px)`;
	}

	function apply() {
		if (!msg) return;
		const v = new DataView(msg);
		const w = v.getUint16(2),
			h = v.getUint16(4),
			hx = v.getUint16(6),
			hy = v.getUint16(8);
		if (!w || !h) {
			app.surface.style.cursor = 'none';
			if (vcur && visible) vcur.style.display = 'none';
			return;
		}
		const src = document.createElement('canvas');
		src.width = w;
		src.height = h;
		src
			.getContext('2d')!
			.putImageData(
				new ImageData(new Uint8ClampedArray(msg, 14, w * h * 4), w, h),
				0,
				0
			);
		// Cursor images are in desktop pixels; show them at the on-screen scale, but
		// never smaller than a normal pointer.
		const dpr = window.devicePixelRatio || 1;
		const longest = Math.max(w, h);
		const s = Math.min(
			Math.max(app.view.scale, MIN_CURSOR_PX / longest),
			MAX_CURSOR_PX / longest
		);
		const cw = Math.max(1, Math.round(w * s)),
			ch = Math.max(1, Math.round(h * s));
		const dpw = Math.max(1, Math.round(cw * dpr)),
			dph = Math.max(1, Math.round(ch * dpr));
		scaled.width = dpw;
		scaled.height = dph;
		const cx = scaled.getContext('2d')!;
		cx.imageSmoothingQuality = 'high';
		cx.clearRect(0, 0, dpw, dph);
		cx.drawImage(src, 0, 0, dpw, dph);
		const url = scaled.toDataURL('image/png');
		const hsx = Math.round(hx * s),
			hsy = Math.round(hy * s);
		app.surface.style.cursor =
			dpr > 1
				? `-webkit-image-set(url(${url}) ${dpr}x) ${hsx} ${hsy}, url(${url}) ${hsx} ${hsy}, default`
				: `url(${url}) ${hsx} ${hsy}, default`;
		if (dpr > 1 && !app.surface.style.cursor)
			app.surface.style.cursor = `url(${url}) ${hsx} ${hsy}, default`;
		// Pad mode draws the Windows arrow, not the server image: the picture's own
		// pointer can be a bare glyph, and it changes shape mid-gesture.
		if (vcur) {
			if (!visible) vcur.src = url;
			vcur.style.display = visible ? 'block' : 'none';
			place();
		}
	}

	return {
		set(buf: ArrayBuffer) {
			msg = buf;
			apply();
		},
		apply,
		setPos(x: number, y: number) {
			pos = { x, y };
			centered = false;
			place();
		},
		refresh: place,
		setVisible(on: boolean) {
			visible = on;
			if (!vcur) return;
			if (!on) {
				vcur.style.display = 'none';
				return;
			}
			// Phone-sized: 10-16 CSS px, following how big the picture is on this screen.
			// Aiming needs precision, not a pointer as big as the desktop one.
			const px = Math.max(9, Math.min(13, Math.round(22 * (app.view.scale || 1))));
			vcur.src = WINDOWS_CURSOR;
			vsize = { w: px, h: px };
			vhot = { x: (6 * px) / 32, y: (2 * px) / 32 };
			vcur.style.display = 'block';
			place();
		},
	};
}
