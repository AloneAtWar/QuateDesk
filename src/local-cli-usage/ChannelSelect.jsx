// 渠道单选下拉框:固定宽度按钮 + portal 下拉层。第一项固定"全部渠道",
// 其余来自 sources 元数据;>8 个渠道显示搜索框,列表内部滚动。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { localAgentColor } from './local-cli-usage-format';

const SEARCH_THRESHOLD = 8;
const ALL_OPTION = { id: 'all', label: '全部渠道' };

const optionLabel = (option) => option.label || option.id;

export default function ChannelSelect({ value, options, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  const allOptions = useMemo(() => [ALL_OPTION, ...(options || [])], [options]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return allOptions;
    return allOptions.filter((option) => optionLabel(option).toLowerCase().includes(keyword));
  }, [allOptions, query]);

  // 定位:下拉层挂在 document.body,按触发按钮矩形对齐(祖先容器会裁剪绝对定位)
  useLayoutEffect(() => {
    if (!open) return undefined;
    const position = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuStyle({
        position: 'fixed',
        right: Math.max(8, window.innerWidth - rect.right),
        top: Math.min(rect.bottom + 4, window.innerHeight - 220),
        width: Math.max(rect.width, 148),
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
    if (open) {
      setQuery('');
      const selectedIndex = allOptions.findIndex((option) => option.id === value);
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, allOptions, value]);

  const choose = (option) => {
    if (option.disabled) return;
    onChange(option.id);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleKeys = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        let next = index;
        for (let count = 0; count < filtered.length; count += 1) {
          const candidate = Math.max(0, Math.min(filtered.length - 1, next + direction));
          if (candidate === next) break;
          next = candidate;
          if (!filtered[next]?.disabled) return next;
        }
        return index;
      });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option && !option.disabled) choose(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault(); setActiveIndex(Math.max(0, filtered.findIndex((option) => !option.disabled)));
    } else if (event.key === 'End') {
      event.preventDefault(); setActiveIndex(Math.max(0, filtered.findLastIndex((option) => !option.disabled)));
    }
  };

  const selected = allOptions.find((option) => option.id === value) || ALL_OPTION;

  const menu = open && menuStyle ? createPortal(
    <div className="local-cli-channel-menu" style={menuStyle} ref={menuRef} role="listbox" aria-label="本机用量渠道" onKeyDown={handleKeys}>
      {allOptions.length > SEARCH_THRESHOLD && <div className="local-cli-channel-search"><Search size={11} /><input
        ref={searchRef} value={query} placeholder="搜索渠道" onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } }} /></div>}
      <div className="local-cli-channel-options">
        {filtered.map((option, index) => <button
          type="button" key={option.id} role="option" aria-selected={option.id === value}
          aria-disabled={option.disabled || undefined} disabled={option.disabled}
          title={option.disabled ? `${optionLabel(option)} · 暂无数据` : optionLabel(option)}
          className={`local-cli-channel-option${index === activeIndex ? ' active' : ''}${option.id === value ? ' selected' : ''}${option.disabled ? ' disabled' : ''}`}
          onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
          onClick={() => choose(option)}
        >
          <span className="local-cli-channel-name"><i style={{ background: option.id === 'all' ? 'var(--green-deep)' : localAgentColor(option.colorToken) }} />{optionLabel(option)}</span>
          {option.disabled && <small>暂无数据</small>}
          {option.id === value && <Check size={11} className="local-cli-channel-check" />}
        </button>)}
        {!filtered.length && <div className="local-cli-channel-empty">没有匹配的渠道</div>}
      </div>
    </div>, document.body) : null;

  return <>
    <button
      type="button" ref={buttonRef} className="local-cli-channel-select" disabled={disabled}
      aria-haspopup="listbox" aria-expanded={open}
      onClick={() => setOpen((state) => !state)}
      onKeyDown={(event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setOpen(true); }
      }}
    >
      <span className="local-cli-channel-value">{optionLabel(selected)}</span>
      <ChevronDown size={11} className={open ? 'flip' : ''} />
    </button>
    {menu}
  </>;
}
