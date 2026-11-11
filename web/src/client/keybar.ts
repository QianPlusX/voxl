// The desktop key bar: the keys a phone keyboard cannot send (Esc, Tab, arrows,
// Home/End, PageUp/PageDown) plus sticky Ctrl and Alt, so Ctrl+C, Alt+Tab and
// Ctrl+Shift+... are reachable from a touchscreen.
/** X keysyms. Left-hand modifiers: a plain modifier, not a chord. */
const ESC = 0xff1b,
	TAB = 0xff09,
	HOME = 0xff50,
	END = 0xff57,
	PGUP = 0xff55,
	PGDN = 0xff56,
	LEFT = 0xff51,
	UP = 0xff52,
	RIGHT = 0xff53,
	DOWN = 0xff54;

interface Key {
	label: string;
	ks?: number;
	mod?: 'ctrl' | 'alt';
}

const ROWS: Key[][] = [
	[
		{ label: 'Esc', ks: ESC },
		{ label: 'Tab', ks: TAB },
		{ label: 'Ctrl', mod: 'ctrl' },
		{ label: 'Alt', mod: 'alt' },
		{ label: 'Home', ks: HOME },
		{ label: '↑', ks: UP },
		{ label: 'End', ks: END },
	],
	[
		{ label: '←', ks: LEFT },
		{ label: '↓', ks: DOWN },
		{ label: '→', ks: RIGHT },
		{ label: 'PgUp', ks: PGUP },
		{ label: 'PgDn', ks: PGDN },
	],
];

/** Modifier keysyms, held down around the key they modify. */
const MOD: Record<'ctrl' | 'alt', number> = { ctrl: 0xffe3, alt: 0xffe9 };

export function setupKeybar(kb: {
	tap(ks: number): void;
	key(ks: number, down: boolean): void;
}) {
	const bar = document.createElement('div');
	bar.id = 'keybar';
	bar.setAttribute('role', 'toolbar');
	bar.setAttribute('aria-label', 'Desktop keys');

	const sticky: Record<string, boolean> = {};
	const buttons: { key: Key; el: HTMLButtonElement }[] = [];

	const sync = () => {
		for (const b of buttons) {
			const on = !!b.key.mod && !!sticky[b.key.mod];
			if (b.key.mod) b.el.classList.toggle('on', on);
		}
	};
	/** Send a key, with any lit modifier held down around it. */
	const sendKey = (ks: number) => {
		const held = Object.keys(sticky).filter((m) => sticky[m]);
		for (const m of held) kb.key(MOD[m as 'ctrl' | 'alt'], true);
		kb.tap(ks);
		for (const m of held) kb.key(MOD[m as 'ctrl' | 'alt'], false);
		// Lit modifiers are one-shot, like a phone keyboard's shift; a second tap locks
		// them for a chord such as Ctrl+Shift+T.
		for (const m of held) sticky[m] = false;
		sync();
	};

	for (const row of ROWS) {
		const el = document.createElement('div');
		el.className = 'row';
		for (const key of row) {
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = key.label;
			b.addEventListener('pointerdown', (e) => e.stopPropagation());
			b.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (key.mod) {
					sticky[key.mod] = !sticky[key.mod];
					sync();
					return;
				}
				if (key.ks !== undefined) sendKey(key.ks);
			});
			el.appendChild(b);
			buttons.push({ key, el: b });
		}
		bar.appendChild(el);
	}
	document.body.appendChild(bar);

	// Hidden until asked for: on a phone it covers a fifth of the picture, and most
	// of the time the soft keyboard is enough.
	let hidden = true;
	const toggle = document.createElement('button');
	toggle.id = 'keybar-toggle';
	toggle.type = 'button';
	toggle.textContent = '⌨';
	toggle.title = 'Desktop keys';
	toggle.setAttribute('aria-label', 'Toggle the desktop key bar');
	toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
	toggle.addEventListener('click', (e) => {
		e.preventDefault();
		hidden = !hidden;
		bar.classList.toggle('show', !hidden);
		toggle.classList.toggle('on', !hidden);
	});
	document.body.appendChild(toggle);

	return { bar, toggle };
}
