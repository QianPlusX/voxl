// Touch: tap = click, drag = left-drag, long press = right click, two fingers =
// scroll (content follows the fingers).
//
// A phone shows the desktop scaled down to the screen, so an absolute tap lands on
// several desktop pixels at best: the address bar, a checkbox or a 20px button is hit
// or miss. Pad mode (the default on touch devices) moves the pointer relatively like a
// laptop trackpad — one finger slides the pointer, a tap clicks where it is, a long
// press right-clicks and two fingers scroll — so small controls stay reachable.
import { cmd } from '../protocol';
import type { App } from './app';

const SLOP = 10;
const LONG_PRESS = 550;
/** A tap this soon (GTK's and Qt's double-click time) and this close (CSS px) after
 * the last one clicks the same spot, so double-taps double-click even though the
 * finger lands a little off. */
const MULTI_TAP_MS = 400;
const MULTI_TAP_PX = 24;
/** Two-finger pinch zooms the picture from 1x to this. */
const MAX_ZOOM = 4;

/** 'pad' moves a cursor relatively, 'direct' taps the desktop under the finger. */
export type TouchMode = 'pad' | 'direct';

interface Hooks {
	/** Move the remote pointer to a client (CSS pixel) position. */
	moveTo(x: number, y: number): void;
	/** Move the remote pointer by this many client (CSS) pixels, clamped to the surface. */
	relMove(dx: number, dy: number): void;
	/** Press and release a button where the pointer already is. */
	click(button: number): void;
	queueScroll(dx: number, dy: number): void;
	deskPerPx(): number;
}

export function createTouch(app: App, hooks: Hooks, mode: () => TouchMode) {
	const { send } = app;
	const pts = new Map<number, { x: number; y: number }>();
	const isPad = () => mode() === 'pad';
	let state: 'pending' | 'drag' | 'move' | 'pinch' | 'done' | null = null;
	let start = { x: 0, y: 0 };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastTap = { x: 0, y: 0, t: -Infinity };
	// The picture is zoomed and panned on the client: the remote screen keeps its
	// resolution, so text stays sharp and the desktop never re-lays out.
	let zoom = 1,
		panX = 0,
		panY = 0;
	let pinch: { d: number; zoom: number; cx: number; cy: number; panX: number; panY: number } | null =
		null;
	const clampView = () => {
		const lw = app.surface.offsetWidth || 1,
			lh = app.surface.offsetHeight || 1;
		const mx = (lw * zoom - lw) / 2,
			my = (lh * zoom - lh) / 2;
		panX = Math.max(-mx, Math.min(mx, panX));
		panY = Math.max(-my, Math.min(my, panY));
	};
	const applyView = () => {
		const s = app.surface;
		s.style.transformOrigin = '50% 50%';
		s.style.transform =
			zoom === 1 && panX === 0 && panY === 0
				? ''
				: `translate(${panX}px, ${panY}px) scale(${zoom})`;
	};
	const mid = (): [number, number] => {
		let x = 0,
			y = 0;
		for (const p of pts.values()) {
			x += p.x;
			y += p.y;
		}
		return [x / pts.size, y / pts.size];
	};
	const click = (button: number) => {
		send(cmd.button(button, true));
		send(cmd.button(button, false));
	};

	function down(e: PointerEvent) {
		try {
			app.surface.setPointerCapture(e.pointerId);
		} catch {}
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pts.size === 1) {
			state = 'pending';
			start = { x: e.clientX, y: e.clientY };
			timer = setTimeout(() => {
				if (state !== 'pending') return;
				if (!isPad()) hooks.moveTo(start.x, start.y);
				hooks.click(3);
				state = 'done';
				navigator.vibrate?.(10);
			}, LONG_PRESS);
		} else if (pts.size === 2) {
			clearTimeout(timer);
			if (state === 'drag') send(cmd.button(1, false));
			const [a, b] = [...pts.values()];
			const [cx, cy] = mid();
			pinch = {
				d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
				zoom,
				cx,
				cy,
				panX,
				panY,
			};
			state = 'pinch';
		}
	}
	function move(e: PointerEvent) {
		const p = pts.get(e.pointerId);
		if (!p) return;
		// Delta before this event is applied: pad mode moves the pointer by it.
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		p.x = e.clientX;
		p.y = e.clientY;
		if (state === 'pending' && Math.hypot(p.x - start.x, p.y - start.y) > SLOP) {
			clearTimeout(timer);
			if (isPad()) {
				// A slide is pointer movement, not a drag: pressing the button here would
				// start selecting text in the desktop on every attempt to aim.
				state = 'move';
				hooks.relMove(dx, dy);
				return;
			}
			state = 'drag';
			hooks.moveTo(start.x, start.y);
			send(cmd.button(1, true));
		}
		if (state === 'move') hooks.relMove(dx, dy);
		else if (state === 'drag') hooks.moveTo(p.x, p.y);
		else if (state === 'pinch' && pinch && pts.size >= 2) {
			const [a, b] = [...pts.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
			zoom = Math.max(1, Math.min(MAX_ZOOM, (pinch.zoom * d) / pinch.d));
			const [cx, cy] = mid();
			panX = pinch.panX + (cx - pinch.cx);
			panY = pinch.panY + (cy - pinch.cy);
			clampView();
			applyView();
			return;
		}
	}
	function up(e: PointerEvent) {
		if (!pts.delete(e.pointerId)) return;
		if (state === 'pending') {
			clearTimeout(timer);
			if (isPad()) {
				// The pointer is already where the finger left it; two taps in a row still
				// reach the desktop as a double click.
				hooks.click(1);
			} else {
				const now = performance.now();
				const at =
					now - lastTap.t < MULTI_TAP_MS &&
					Math.hypot(start.x - lastTap.x, start.y - lastTap.y) < MULTI_TAP_PX
						? lastTap
						: start;
				lastTap = { x: at.x, y: at.y, t: now };
				hooks.moveTo(at.x, at.y);
				click(1);
			}
			state = 'done';
		} else if (state === 'drag') {
			send(cmd.button(1, false));
			state = 'done';
		} else if (state === 'pinch' && pts.size < 2) {
			pinch = null;
			if (zoom <= 1.01) {
				zoom = 1;
				panX = panY = 0;
				applyView();
			}
			state = 'done';
		}
		if (pts.size === 0) state = null;
	}
	function cancel(e: PointerEvent) {
		clearTimeout(timer);
		pinch = null;
		if (state === 'drag') send(cmd.button(1, false));
		pts.delete(e.pointerId);
		if (pts.size === 0) state = null;
	}
	return { down, move, up, cancel };
}
