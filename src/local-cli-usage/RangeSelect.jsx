// 统计周期下拉框:固定宽度按钮 + portal 下拉层,选项少不带搜索。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export default function RangeSelect({ value, options, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  // 定位:下拉层挂在 document.body,按触发按钮矩形对齐(祖先容器会裁剪绝对定位)
  useLayoutEffect(() => {
    if (!open) return undefined;
    const position = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuStyle({
        position: 'fixed',
        right: Math.max(8, window.innerWidth - rect.right),
        top: Math.min(rect.bottom + 4, window.innerHeight - 200),
        width: Math.max(rect.width, 88),
      });
    };
    position();
    const closeOnOutside = (event) => {
      if (buttonRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', closeOnOutside);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('mousedown', closeOnOutside);
      window.removeEventListener('resize', position);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const selected = options.find((option) => option.days === value) || options[0];

  const menu = open && menuStyle ? createPortal(
    <div className="local-cli-range-menu" style={menuStyle} ref={menuRef} role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button
        type="button" key={option.days} role="option" aria-selected={option.days === value}
        className={`local-cli-range-option${option.days === value ? ' selected' : ''}`}
        onClick={() => { onChange(option.days); setOpen(false); buttonRef.current?.focus(); }}
      >
        <span>{option.label}</span>
        {option.days === value && <Check size={11} className="local-cli-range-check" />}
      </button>)}
    </div>, document.body) : null;

  return <>
    <button
      type="button" ref={buttonRef} className="local-cli-range-select"
      aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
      onClick={() => setOpen((state) => !state)}
      onKeyDown={(event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setOpen(true); }
      }}
    >
      <span className="local-cli-range-value">{selected?.label}</span>
      <ChevronDown size={11} className={open ? 'flip' : ''} />
    </button>
    {menu}
  </>;
}
