// Mouse, wheel/trackpad and touch input on the desktop surface.
import { cmd } from '../protocol';
import type { App } from './app';
import { createTouch } from './touch';
import type { TouchMode } from './touch';

/** DOM button -> X button (left, middle, right, back, forward). */
const BUTTONS = [1, 2, 3, 8, 9];

/** Where the touch pointer is, in client (CSS) pixels, and who wants to draw it. */
export interface PadCursor {
	/** The pad mode is on: the desktop follows a relative pointer. */
	enabled(): boolean;
	setEnabled(on: boolean): void;
	/** Called with the surface-relative pointer position whenever it moves. */
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

export function setupPointer(app: App, onInteract: () => void): PadCursor {
	const { surface, send } = app;

	function toDesk(p: { clientX: number; clientY: number }): [number, number] {
		const r = surface.getBoundingClientRect();
		const x = Math.round(((p.clientX - r.left) * app.desk.w) / r.width);
		const y = Math.round(((p.clientY - r.top) * app.desk.h) / r.height);
		return [
			Math.max(0, Math.min(app.desk.w - 1, x)),
			Math.max(0, Math.min(app.desk.h - 1, y)),
		];
	}
	let lastMove = '';
	function move(p: { clientX: number; clientY: number }, force = false) {
		if (!app.desk.w) return;
		const s = cmd.move(...toDesk(p));
		if (s !== lastMove || force) {
			lastMove = s;
			send(s);
		}
	}

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
	/** Desktop pixels per on-screen pixel. */
	const deskPerPx = () => app.desk.w / surface.getBoundingClientRect().width;
	const mode = (): TouchMode => (pad ? 'pad' : 'direct');

	// Pad mode keeps its own pointer: the browser has no pointer position on a
	// touchscreen, so there is nothing to read back. It starts in the middle and stays
	// clamped to the surface, which is also where the on-screen cursor is drawn.
	let pad = initialPad();
	let padX = 0,
		padY = 0,
		padReady = false;
	const moveFns: ((x: number, y: number) => void)[] = [];
	const modeFns: ((pad: boolean) => void)[] = [];
	function relMove(dx: number, dy: number) {
		const r = surface.getBoundingClientRect();
		if (!padReady) {
			padX = r.width / 2;
			padY = r.height / 2;
			padReady = true;
		}
		padX = Math.max(0, Math.min(r.width - 1, padX + dx));
		padY = Math.max(0, Math.min(r.height - 1, padY + dy));
		move({ clientX: r.left + padX, clientY: r.top + padY }, true);
		for (const fn of moveFns) fn(padX, padY);
	}
	function click(button: number) {
		send(cmd.button(button, true));
		send(cmd.button(button, false));
	}

	const touch = createTouch(
		app,
		{
			moveTo: (x, y) => move({ clientX: x, clientY: y }, true),
			relMove,
			click,
			queueScroll,
			deskPerPx,
		},
		mode
	);

	surface.addEventListener('pointermove', (e) => {
		if (e.pointerType === 'touch') touch.move(e);
		else move(e);
	});
	surface.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		onInteract();
		if (e.pointerType === 'touch') {
			touch.down(e);
			return;
		}
		app.kbd.focus({ preventScroll: true });
		move(e);
		try {
			surface.setPointerCapture(e.pointerId);
		} catch {}
		send(cmd.button(BUTTONS[e.button] || 1, true));
	});
	surface.addEventListener('pointerup', (e) => {
		e.preventDefault();
		if (e.pointerType === 'touch') {
			touch.up(e);
			return;
		}
		move(e);
		send(cmd.button(BUTTONS[e.button] || 1, false));
	});
	surface.addEventListener('pointercancel', (e) => {
		if (e.pointerType === 'touch') touch.cancel(e);
		else send(cmd.releaseAll);
	});
	surface.addEventListener('contextmenu', (e) => e.preventDefault());
	surface.addEventListener(
		'wheel',
		(e) => {
			e.preventDefault();
			move(e);
			const k =
				(e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1) * deskPerPx();
			queueScroll(e.deltaX * k, e.deltaY * k);
		},
		{ passive: false }
	);

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
