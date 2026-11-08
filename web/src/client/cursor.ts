// The remote cursor, drawn locally by the browser so pointer movement has no stream
// latency. Cursor messages: type byte, pad, width, height, hot x, hot y (u16 each),
// serial (u32), then RGBA.
//
// Pad mode draws the same image a second time as an element (#vcur) at the pad
// pointer: on a touchscreen the browser has no pointer of its own, so a CSS cursor
// would stay wherever the last mouse left it.
import type { App } from './app';

// On-screen cursor size bounds in CSS pixels, applied to the image's longer side.
// 24 is the standard pointer size (Xcursor's default), so a desktop scaled down
// into a small window (an embedded sidebar) keeps a normal-sized pointer.
const MIN_CURSOR_PX = 24;
const MAX_CURSOR_PX = 128;

/** Pointer shown until the server sends a cursor image of its own. */
const FALLBACK =
	'data:image/svg+xml,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
			'<path d="M5 2.5l14.5 9.2-6.8 1.5L9.4 21z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/>' +
			'</svg>'
	);

export interface Cursor {
	set(buf: ArrayBuffer): void;
	apply(): void;
	/** Draw the pointer at this surface position (CSS pixels, from the top left). */
	setPos(x: number, y: number): void;
	setVisible(on: boolean): void;
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
	// Hotspot and size of the last applied image, in CSS pixels.
	let hot = { x: 0, y: 0 };
	let size = { w: 0, h: 0 };
	let drawn = false;

	function place() {
		if (centered) {
			const r = app.surface.getBoundingClientRect();
			pos = { x: r.width / 2, y: r.height / 2 };
		}
		if (!vcur || !visible) return;
		vcur.style.width = size.w + 'px';
		vcur.style.height = size.h + 'px';
		vcur.style.transform = `translate(${Math.round(pos.x - hot.x)}px, ${Math.round(pos.y - hot.y)}px)`;
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
		// The same image again, at the pad pointer.
		hot = { x: hsx, y: hsy };
		size = { w: cw, h: ch };
		drawn = true;
		if (vcur) {
			vcur.src = url;
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
		setVisible(on: boolean) {
			visible = on;
			if (!vcur) return;
			if (!on) {
				vcur.style.display = 'none';
				return;
			}
			if (!drawn) {
				vcur.src = FALLBACK;
				size = { w: 24, h: 24 };
				hot = { x: 3, y: 3 };
			}
			vcur.style.display = 'block';
			place();
		},
	};
}
