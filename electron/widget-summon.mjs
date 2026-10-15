// The temporary position never changes the panel's persistent visibility or position.
export function createWidgetSummoner({ readyWindow, getWindow, getCursor, place, getFixedPosition,
  rememberPosition, isPermanentVisible, setPermanentVisible, applyPin, notifyArea }) {
  let temporary = null;
  let pending = false;
  let menuOpen = false;
  let revision = 0;
  const restore = () => {
    if (!temporary) return false;
    const previous = temporary;
    temporary = null;
    revision++;
    const window = getWindow();
    if (!window || window.isDestroyed()) return false;
    place(getFixedPosition() || previous.position, false);
    if (isPermanentVisible()) { window.showInactive(); applyPin(); }
    else window.hide();
    notifyArea();
    return true;
  };
  return {
    get active() { return Boolean(temporary); },
    async toggle() {
      if (temporary) return restore();
      if (pending) return false;
      pending = true;
      const request = ++revision;
      try {
        const window = await readyWindow();
        if (request !== revision || !window || window.isDestroyed()) return false;
        const bounds = window.getBounds();
        temporary = { position: { x: bounds.x, y: bounds.y }, cursor: getCursor() };
        place(temporary.cursor, true);
        window.show();
        applyPin();
        window.moveTop();
        window.focus();
        notifyArea();
        return true;
      } finally { pending = false; }
    },
    restore,
    cancel() { temporary = null; revision++; },
    reflow() { if (temporary) { place(temporary.cursor, true); notifyArea(); } },
    blur() { if (!menuOpen) restore(); },
    menu(open) { menuOpen = open; if (!open && !getWindow()?.isFocused()) restore(); },
    dragged() {
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      temporary = null;
      revision++;
      rememberPosition(window.getBounds());
      if (!isPermanentVisible()) setPermanentVisible(true);
      applyPin();
    },
  };
}
