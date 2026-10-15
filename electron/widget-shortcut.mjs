export const DEFAULT_WIDGET_SHORTCUT = 'Alt+Q';

export function normalizeWidgetShortcut(value) {
  if (value == null) return DEFAULT_WIDGET_SHORTCUT;
  if (value === '') return '';
  const match = /^(ctrl|alt)\+([a-z0-9]|f(?:[1-9]|1\d|2[0-4]))$/i.exec(String(value).trim());
  return match ? `${match[1].toLowerCase() === 'ctrl' ? 'Ctrl' : 'Alt'}+${match[2].toUpperCase()}` : null;
}

export function shortcutFromEvent(event) {
  if (event.metaKey || event.shiftKey || Boolean(event.ctrlKey) === Boolean(event.altKey)) return null;
  const code = String(event.code || '');
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : code;
  return normalizeWidgetShortcut(`${event.ctrlKey ? 'Ctrl' : 'Alt'}+${key}`);
}

// Registration is transactional: a conflicting replacement keeps the old binding.
export function createWidgetShortcutManager(globalShortcut, callback) {
  let configured = '';
  let registered = '';
  let recording = false;
  let error = '';
  const status = () => ({ shortcut: configured, registered: Boolean(registered), recording, error });
  const register = (key) => {
    try { return !key || globalShortcut.register(key, callback); } catch { return false; }
  };
  const unregister = () => {
    if (registered) globalShortcut.unregister(registered);
    registered = '';
  };
  const set = (value) => {
    const next = normalizeWidgetShortcut(value);
    if (next == null) return { ...status(), ok: false, error: '只支持 Ctrl 或 Alt 加一个字母、数字或 F 键' };
    if (next === configured && registered && !recording) return { ...status(), ok: true };
    const previous = configured;
    if (next && next !== registered && !register(next)) {
      recording = false;
      if (!registered && previous && register(previous)) registered = previous;
      error = '快捷键被占用或系统不支持，请更换组合';
      return { ...status(), ok: false };
    }
    if (registered && registered !== next) unregister();
    configured = next;
    registered = next;
    recording = false;
    error = '';
    return { ...status(), ok: true };
  };
  const setRecording = (value) => {
    recording = Boolean(value);
    if (recording) unregister();
    else if (!registered && configured) {
      if (register(configured)) { registered = configured; error = ''; }
      else error = '快捷键被占用或系统不支持，请更换组合';
    }
    return status();
  };
  return { status, set, setRecording, dispose: unregister };
}
