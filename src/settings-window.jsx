import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Settings details share the app's modal surface and leave their directory in place. */
export function SettingsWindow({ title, icon: Icon, help, actions, onClose, children }) {
  const titleId = useId();
  const windowRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = windowRef.current;
    const hasChildDialog = () => document.querySelector('.modal-backdrop:not(.settings-window-backdrop)');
    dialog?.focus({ preventScroll: true });
    const onKeyDown = (event) => {
      // Account editors, confirmations and pairing dialogs take precedence.
      if (hasChildDialog() || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
          .filter((element) => !element.disabled && element.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        const outside = !dialog.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || outside)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || outside)) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div className="modal-backdrop settings-window-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="modal settings-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={windowRef}>
      <header className="settings-window-header">
        <div className="settings-window-heading"><Icon size={17} /><h2 id={titleId}>{title}</h2>{help}</div>
        <div className="settings-window-actions">{actions}<button type="button" className="icon-button" title="关闭（Esc）" aria-label={`关闭${title}`} onClick={onClose}><X size={17} /></button></div>
      </header>
      <div className="settings-window-content">{children}</div>
    </section>
  </div>, document.body);
}
