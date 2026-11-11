// Toolbar (top right on hover; bottom right and always visible on touch devices):
// on-screen keyboard, touch mode, files, microphone and fullscreen buttons.
import type { App } from './app';
import { el } from './app';
import type { PadCursor } from './pointer';

export function setupToolbar(
	app: App,
	onFullscreenChange: () => void,
	pad?: PadCursor
) {
	const { tools, kbd } = app;
	const kbBtn = el<HTMLButtonElement>('kb-btn');
	const fsBtn = el<HTMLButtonElement>('fs-btn');
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	function show(ms: number) {
		tools.classList.add('show');
		clearTimeout(hideTimer);
		if (ms) hideTimer = setTimeout(() => tools.classList.remove('show'), ms);
	}
	// Touch devices keep the toolbar visible; mice reveal it near the top edge.
	const touch = matchMedia('(pointer: coarse)').matches;
	if (touch) {
		tools.classList.add('touch');
		show(0);
		// The soft keyboard shrinks the visual viewport instead of the window, so the
		// toolbar would sit behind it; keep it above the keyboard.
		const vv = window.visualViewport;
		if (vv) {
			const fix = () => {
				const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
				tools.style.bottom = 12 + overlap + 'px';
				// The key bar and its toggle sit above the same keyboard.
				document.documentElement.style.setProperty('--kb', overlap + 'px');
			};
			vv.addEventListener('resize', fix);
			vv.addEventListener('scroll', fix);
			fix();
		}
	} else
		document.addEventListener('pointermove', (e) => {
			if (
				e.pointerType === 'mouse' &&
				e.clientY < 48 &&
				e.clientX > window.innerWidth - 160
			)
				show(2500);
		});
	// Clicks on the toolbar must not reach the desktop surface underneath.
	for (const b of tools.querySelectorAll('button'))
		b.addEventListener('pointerdown', (e) => e.stopPropagation());

	// Touchpad / direct touch. Pad mode moves a cursor relatively and draws it, so
	// desktop-sized controls stay reachable on a phone screen.
	const padBtn = document.getElementById('pad-btn') as HTMLButtonElement | null;
	if (pad && padBtn) {
		const sync = (on: boolean) => {
			padBtn.classList.toggle('on', on);
			padBtn.setAttribute('aria-pressed', String(on));
			padBtn.title = on
				? 'Touchpad: drag to move the pointer (tap for direct touch)'
				: 'Direct touch (tap for touchpad)';
		};
		pad.onMode(sync);
		sync(pad.enabled());
		padBtn.addEventListener('click', () => pad.setEnabled(!pad.enabled()));
	}

	kbBtn.addEventListener('click', () => {
		if (document.activeElement === kbd && kbd.dataset.soft) {
			kbd.blur();
			delete kbd.dataset.soft;
			kbd.setAttribute('inputmode', 'none');
		} else {
			// inputmode stays "none" until this button is pressed, so tapping or
			// clicking the picture never pops the soft keyboard on its own.
			kbd.dataset.soft = '1';
			kbd.setAttribute('inputmode', 'text');
			kbd.focus({ preventScroll: true });
		}
	});

	if (!document.fullscreenEnabled) fsBtn.style.display = 'none';
	fsBtn.addEventListener('click', () => {
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
		else
			document.documentElement
				.requestFullscreen({ navigationUI: 'hide' })
				.catch(() => {});
	});
	// In fullscreen, capture browser shortcuts (Cmd/Ctrl+W, T, L, ...) for the desktop.
	// Keyboard Lock is Chromium-only and only allowed for the top-level page (an
	// embedding page has to lock on our behalf); hold Esc to leave fullscreen.
	document.addEventListener('fullscreenchange', () => {
		const kl = navigator.keyboard;
		if (document.fullscreenElement) kl?.lock().catch(() => {});
		else kl?.unlock();
		fsBtn.classList.toggle('on', !!document.fullscreenElement);
		onFullscreenChange();
	});
}
