// Mouse, wheel/trackpad and touch input on the desktop surface.
import { cmd } from '../protocol';
import type { App } from './app';
import { createTouch } from './touch';
import type { TouchMode } from './touch';
import type { View } from './view';

/** DOM button -> X button (left, middle, right, back, forward). */
const BUTTONS = [1, 2, 3, 8, 9];

/** Where the touch pointer is, in client (CSS) pixels, and who wants to draw it. */
export interface PadCursor {
	/** The pad mode is on: the desktop follows a relative pointer. */
	enabled(): boolean;
	setEnabled(on: boolean): void;
	/** Called with the pointer position (surface layout pixels) whenever it moves. */
	onMove(fn: (x: number, y: number) => void): void;
	/** Called when the mode changes, so the on-screen cursor can be shown or hidden. */
	onMode(fn: (pad: boolean) => void): void;
}

const PAD_KEY = 'voxl.touchpad';

/** Pad mode is the touch default: an absolute tap can't reach desktop-sized controls
 * on a phone-sized screen. An explicit choice from the toolbar wins. */
function initialPad(): boolean {
	try {
		const saved = localStorage.getItem(PAD_KEY);
		if (saved !== null) return saved === '1';
	} catch {}
	return matchMedia('(pointer: coarse)').matches;
}

export function setupPointer(app: App, view: View, onInteract: () => void): PadCursor {
	const { surface, send } = app;

	const move = (clientX: number, clientY: number, force = false) => {
		if (!app.desk.w) return;
		const s = cmd.move(...view.toDesk(clientX, clientY));
		if (s !== lastMove || force) {
			lastMove = s;
			send(s);
		}
	};
	let lastMove = '';

	// Scroll is sent in desktop pixels, batched per frame; the server turns it into
	// smooth (pixel-precise) scrolling, or wheel clicks on X servers that can't.
	let sx = 0,
		sy = 0,
		queued = false;
	function queueScroll(dx: number, dy: number) {
		sx += dx;
		sy += dy;
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			if (Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5) return;
			send(cmd.scroll(sx, sy));
			sx = 0;
			sy = 0;
		});
	}
	/** Desktop pixels per on-screen pixel, including the view's zoom. */
	const deskPerPx = () =>
		app.desk.w / ((surface.offsetWidth || 1) * view.zoom());
	const mode = (): TouchMode => (pad ? 'pad' : 'direct');

	// Pad mode keeps its own pointer: the browser has no pointer position on a
	// touchscreen, so there is nothing to read back. Its position is kept in surface
	// layout pixels, the same space the picture is laid out in, so zooming the view
	// keeps it on the same desktop pixel instead of sliding away from it.
	let pad = initialPad();
	let padX = 0,
		padY = 0,
		padReady = false;
	const moveFns: ((x: number, y: number) => void)[] = [];
	const modeFns: ((pad: boolean) => void)[] = [];
	/** The pad pointer's desktop pixel position, rebuilt from its layout position. */
	function padToDesk(): [number, number] {
		const lw = surface.offsetWidth || 1,
			lh = surface.offsetHeight || 1;
		return [
			Math.round((padX * app.desk.w) / lw),
			Math.round((padY * app.desk.h) / lh),
		];
	}
	function sendPadMove() {
		if (!app.desk.w) return;
		const [dx, dy] = padToDesk();
		const s = cmd.move(dx, dy);
		if (s !== lastMove) {
			lastMove = s;
			send(s);
		}
	}
	function relMove(dx: number, dy: number) {
		const lw = surface.offsetWidth || 1,
			lh = surface.offsetHeight || 1;
		if (!padReady) {
			padX = lw / 2;
			padY = lh / 2;
			padReady = true;
		}
		// A finger moving dx on screen covers dx / zoom layout pixels: zoomed in, the
		// pointer moves slower, which is what makes a 20px button reachable.
		const z = view.zoom();
		padX = Math.max(0, Math.min(lw - 1, padX + dx / z));
		padY = Math.max(0, Math.min(lh - 1, padY + dy / z));
		sendPadMove();
		for (const fn of moveFns) fn(padX, padY);
		edgePan();
	}
	/** Zoomed in, walking the pointer to the edge of the screen pans the picture, so a
	 * control just off screen can be reached without lifting the finger. The band is
	 * measured on screen: zoomed in, the picture's own edges are far outside it. */
	function edgePan() {
		if (view.zoom() <= 1.01) return;
		const [cx, cy] = view.toClient(padX, padY);
		const band = 0.12,
			fx = edgeFactor(cx / (window.innerWidth || 1), band),
			fy = edgeFactor(cy / (window.innerHeight || 1), band);
		if (fx || fy) view.panBy(-fx * 14, -fy * 14);
	}
	const edgeFactor = (t: number, band: number) =>
		t < band ? -(1 - t / band) : t > 1 - band ? 1 - (1 - t) / band : 0;
	function click(button: number) {
		send(cmd.button(button, true));
		send(cmd.button(button, false));
	}

	const touch = createTouch(
		app,
		view,
		{
			moveTo: (x, y) => move(x, y, true),
			relMove,
			click,
			queueScroll,
			deskPerPx,
		},
		mode
	);

	// Touch is handled on the window (below): on a phone the picture is letterboxed,
	// and a slide that starts in the black bars has to move the pointer too.
	surface.addEventListener('pointermove', (e) => {
		if (e.pointerType !== 'touch') move(e.clientX, e.clientY);
	});
	surface.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'touch') return;
		e.preventDefault();
		onInteract();
		move(e.clientX, e.clientY);
		try {
			surface.setPointerCapture(e.pointerId);
		} catch {}
		send(cmd.button(BUTTONS[e.button] || 1, true));
	});
	surface.addEventListener('pointerup', (e) => {
		if (e.pointerType === 'touch') return;
		e.preventDefault();
		move(e.clientX, e.clientY);
		send(cmd.button(BUTTONS[e.button] || 1, false));
	});
	surface.addEventListener('pointercancel', (e) => {
		if (e.pointerType !== 'touch') send(cmd.releaseAll);
	});
	surface.addEventListener('contextmenu', (e) => e.preventDefault());

	// A touch anywhere on the page drives the pointer, including the bars around the
	// picture: a thumb parked off the picture still has to aim. Widgets (toolbar,
	// key bar, text fields, dialogs) keep their own touches.
	const OWN_TOUCH =
		'#tools, #kbd, #keybar, #status, .panel, input, textarea, button, select, a';
	const ownsTouch = (t: EventTarget | null) => {
		const el = t as Element | null;
		return !!(el && el.closest && el.closest(OWN_TOUCH));
	};
	window.addEventListener(
		'pointerdown',
		(e) => {
			if (e.pointerType !== 'touch' || ownsTouch(e.target)) return;
			e.preventDefault();
			onInteract();
			touch.down(e);
		},
		{ passive: false }
	);
	window.addEventListener('pointermove', (e) => {
		if (e.pointerType === 'touch') touch.move(e);
	});
	window.addEventListener('pointerup', (e) => {
		if (e.pointerType === 'touch') touch.up(e);
	});
	window.addEventListener('pointercancel', (e) => {
		if (e.pointerType === 'touch') touch.cancel(e);
	});
	surface.addEventListener(
		'wheel',
		(e) => {
			e.preventDefault();
			move(e.clientX, e.clientY);
			const k =
				(e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1) * deskPerPx();
			queueScroll(e.deltaX * k, e.deltaY * k);
		},
		{ passive: false }
	);

	// Zooming and panning move the picture, not the pad pointer's desktop pixel: redraw
	// it where it now sits on screen.
	view.onChange(() => {
		if (!padReady || !pad) return;
		for (const fn of moveFns) fn(padX, padY);
	});

	return {
		enabled: () => pad,
		setEnabled(on: boolean) {
			if (pad === on) return;
			pad = on;
			try {
				localStorage.setItem(PAD_KEY, on ? '1' : '0');
			} catch {}
			for (const fn of modeFns) fn(on);
		},
		onMove(fn) {
			moveFns.push(fn);
		},
		onMode(fn) {
			modeFns.push(fn);
		},
	};
}
