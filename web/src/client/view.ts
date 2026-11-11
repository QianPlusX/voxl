// The client-side view of the desktop picture. Zoom and pan are a CSS transform on
// #surface: the remote screen keeps its resolution, so text stays sharp and the
// desktop never re-lays out the way it would if the X screen were resized.
//
// The transform is translate(tx, ty) scale(zoom) with transform-origin 0 0, so a
// layout point p lands at tx + p * zoom. Every hit test goes back the same way:
// layout = (client - layoutOrigin) / zoom.
import type { App } from './app';

/** Two-finger pinch zooms the picture from 1x to this. */
export const MAX_ZOOM = 4;

export interface View {
	zoom(): number;
	/** Zoom so the desktop point under a client (CSS pixel) point stays there. */
	zoomAt(factor: number, clientX: number, clientY: number): void;
	/** Move the picture by a client-pixel delta (a finger's movement). */
	panBy(dx: number, dy: number): void;
	/** Back to 1x with no pan. */
	reset(): void;
	/** Client point -> desktop pixel, clamped to the desktop. */
	toDesk(clientX: number, clientY: number): [number, number];
	/** Client point -> layout pixel inside the surface (unscaled). */
	toLayout(clientX: number, clientY: number): [number, number];
	/** Layout pixel -> client point. */
	toClient(x: number, y: number): [number, number];
	/** Redraw the transform, clamp the pan and wake the listeners. */
	apply(): void;
	onChange(fn: () => void): void;
}

export function createView(app: App): View {
	let zoom = 1,
		tx = 0,
		ty = 0;
	const fns: (() => void)[] = [];
	const surface = app.surface;

	/** Top-left of the untransformed surface, in client pixels. The transform only
	 * moves it by (tx, ty): the scale happens around the top-left corner. */
	function origin(): [number, number] {
		const r = surface.getBoundingClientRect();
		return [r.left - tx, r.top - ty];
	}
	function layoutSize(): [number, number] {
		return [surface.offsetWidth || 1, surface.offsetHeight || 1];
	}
	/** Keep the picture covering the surface: no empty band on any side. */
	function clamp() {
		const [w, h] = layoutSize();
		const mx = w * zoom - w,
			my = h * zoom - h;
		tx = Math.min(0, Math.max(-mx, tx));
		ty = Math.min(0, Math.max(-my, ty));
		if (zoom <= 1.001) {
			zoom = 1;
			tx = 0;
			ty = 0;
		}
	}
	function apply() {
		clamp();
		surface.style.transformOrigin = '0 0';
		surface.style.transform =
			zoom === 1 && tx === 0 && ty === 0
				? ''
				: `translate(${tx}px, ${ty}px) scale(${zoom})`;
		app.view.zoom = zoom;
		for (const fn of fns) fn();
	}

	return {
		zoom: () => zoom,
		zoomAt(factor: number, clientX: number, clientY: number) {
			const next = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
			if (next === zoom) return;
			const [ox, oy] = origin();
			// The layout point under the finger, before the zoom.
			const lx = (clientX - ox - tx) / zoom,
				ly = (clientY - oy - ty) / zoom;
			zoom = next;
			tx = clientX - ox - lx * zoom;
			ty = clientY - oy - ly * zoom;
			apply();
		},
		panBy(dx: number, dy: number) {
			if (zoom === 1) return;
			tx += dx;
			ty += dy;
			apply();
		},
		reset() {
			zoom = 1;
			tx = ty = 0;
			apply();
		},
		toDesk(clientX: number, clientY: number) {
			const [ox, oy] = origin();
			const [w, h] = layoutSize();
			const dw = app.desk.w,
				dh = app.desk.h;
			if (!dw || !dh) return [0, 0];
			const x = Math.round((((clientX - ox - tx) / zoom) * dw) / w);
			const y = Math.round((((clientY - oy - ty) / zoom) * dh) / h);
			return [
				Math.max(0, Math.min(dw - 1, x)),
				Math.max(0, Math.min(dh - 1, y)),
			];
		},
		toLayout(clientX: number, clientY: number) {
			const [ox, oy] = origin();
			return [(clientX - ox - tx) / zoom, (clientY - oy - ty) / zoom];
		},
		toClient(x: number, y: number) {
			const [ox, oy] = origin();
			return [ox + tx + x * zoom, oy + ty + y * zoom];
		},
		apply,
		onChange(fn: () => void) {
			fns.push(fn);
		},
	};
}
