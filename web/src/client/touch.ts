// Touch, the way a laptop touchpad and a picture viewer both work.
//
// Pad mode (the default on a phone) moves the pointer relatively like a trackpad:
// one finger slides the pointer, a tap clicks where it is, a long press right-clicks,
// two fingers scroll/pan, pinch zooms. Direct mode drives the picture itself: one
// finger pans it, a tap clicks the desktop point under it, holding and then dragging
// drags the desktop, a long press without moving right-clicks.
//
// In both modes a two-finger tap is a right click, and a pinch zooms around the point
// between the fingers: the desktop pixel under the fingers stays under the fingers.
import { cmd } from '../protocol';
import type { App } from './app';
import type { View } from './view';

const SLOP = 10;
const LONG_PRESS = 550;
/** A tap this soon (GTK's and Qt's double-click time) and this close (CSS px) after
 * the last one clicks the same spot, so double-taps double-click even though the
 * finger lands a little off. */
const MULTI_TAP_MS = 400;
const MULTI_TAP_PX = 24;
/** A two-finger tap held longer than this is a gesture, not a right click. */
const TWO_TAP_MS = 400;
/** Moving either finger this far (CSS px) turns a two-finger tap into a gesture. */
const PINCH_SLOP = 8;

/** 'pad' moves a cursor relatively, 'direct' drives the picture. */
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

export function createTouch(app: App, view: View, hooks: Hooks, mode: () => TouchMode) {
	const { send } = app;
	const pts = new Map<number, { x: number; y: number }>();
	const isPad = () => mode() === 'pad';
	let state: 'pending' | 'armed' | 'pan' | 'drag' | 'move' | 'pinch' | 'done' | null = null;
	let start = { x: 0, y: 0 };
	let last = { x: 0, y: 0 };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastTap = { x: 0, y: 0, t: -Infinity };
	// Two fingers: distance and midpoint of the previous frame, so each frame's
	// zoom/pan is relative to the last one.
	let pinch: { d: number; cx: number; cy: number; moved: boolean; t: number } | null = null;
	/** Two fingers report one pointermove each; applying the gesture per event makes
	 * the midpoint jump between them and the picture drifts. Fold a frame's moves into
	 * one update. */
	let pinchFrame = 0;

	const mid = (): [number, number] => {
		let x = 0,
			y = 0;
		for (const p of pts.values()) {
			x += p.x;
			y += p.y;
		}
		return [x / pts.size, y / pts.size];
	};
	const dist = (): number => {
		const [a, b] = [...pts.values()];
		return Math.hypot(a.x - b.x, a.y - b.y) || 1;
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
			last = { ...start };
			timer = setTimeout(() => {
				if (state !== 'pending') return;
				if (isPad()) {
					// Trackpad: a long press is a right click right away.
					hooks.click(3);
					state = 'done';
				} else {
					// Direct: hold, then either release (right click) or drag (drag the
					// desktop). Deciding on release keeps one gesture from meaning both.
					state = 'armed';
				}
				navigator.vibrate?.(10);
			}, LONG_PRESS);
		} else if (pts.size === 2) {
			clearTimeout(timer);
			// A second finger cancels a drag that had just started and turns whatever
			// was pressed back off, so the gesture starts clean.
			if (state === 'drag') send(cmd.button(1, false));
			if (state === 'armed') state = 'pending';
			const [cx, cy] = mid();
			pinch = { d: dist(), cx, cy, moved: false, t: performance.now() };
			state = 'pinch';
		}
	}

	function move(e: PointerEvent) {
		const p = pts.get(e.pointerId);
		if (!p) return;
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
			// Direct: a slide pans the picture; anything else on a phone screen is a
			// mis-aimed tap.
			state = 'pan';
			last = { x: e.clientX, y: e.clientY };
			return;
		}
		if (state === 'armed') {
			// Held long enough: the desktop starts a drag where the finger went down.
			state = 'drag';
			hooks.moveTo(start.x, start.y);
			send(cmd.button(1, true));
		}
		if (state === 'pan') {
			view.panBy(e.clientX - last.x, e.clientY - last.y);
			last = { x: e.clientX, y: e.clientY };
		} else if (state === 'move') hooks.relMove(dx, dy);
		else if (state === 'drag') hooks.moveTo(p.x, p.y);
		else if (state === 'pinch' && pinch && pts.size >= 2) {
			if (!pinchFrame) pinchFrame = requestAnimationFrame(applyPinch);
		}
	}

	/** Pan and zoom by the distance the fingers have covered since the last frame. */
	function applyPinch() {
		pinchFrame = 0;
		if (state !== 'pinch' || !pinch || pts.size < 2) return;
		const d = dist();
		const [cx, cy] = mid();
		if (Math.hypot(cx - pinch.cx, cy - pinch.cy) > PINCH_SLOP || Math.abs(d - pinch.d) > PINCH_SLOP)
			pinch.moved = true;
		// Two fingers moving together pan; spreading them zooms around their midpoint,
		// so the desktop pixel between the fingers stays put.
		view.panBy(cx - pinch.cx, cy - pinch.cy);
		if (Math.abs(d - pinch.d) > 0.5) view.zoomAt(d / pinch.d, cx, cy);
		pinch = { ...pinch, d, cx, cy };
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
		} else if (state === 'armed') {
			// Held still and released: a right click.
			if (!isPad()) hooks.moveTo(start.x, start.y);
			hooks.click(3);
			state = 'done';
		} else if (state === 'drag') {
			send(cmd.button(1, false));
			state = 'done';
		} else if (state === 'pinch' && pinch) {
			if (pts.size < 2) {
				if (pinchFrame) {
					cancelAnimationFrame(pinchFrame);
					pinchFrame = 0;
				}
				// A two-finger tap (both fingers down and up without moving) is a right
				// click, the trackpad's own gesture.
				if (!pinch.moved && performance.now() - pinch.t < TWO_TAP_MS) {
					if (isPad()) hooks.click(3);
					else {
						hooks.moveTo(pinch.cx, pinch.cy);
						hooks.click(3);
					}
				}
				pinch = null;
				state = 'done';
			}
		}
		if (pts.size === 0) {
			state = null;
			pinch = null;
		}
	}

	function cancel(e: PointerEvent) {
		clearTimeout(timer);
		if (pinchFrame) {
			cancelAnimationFrame(pinchFrame);
			pinchFrame = 0;
		}
		pinch = null;
		if (state === 'drag') send(cmd.button(1, false));
		pts.delete(e.pointerId);
		if (pts.size === 0) state = null;
	}
	return { down, move, up, cancel };
}
