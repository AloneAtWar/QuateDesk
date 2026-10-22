import { RefreshCw } from 'lucide-react';

export function BoardPullRefreshIndicator({ pull, hint = '继续上滑刷新' }) {
  return <div className={`board-pull-refresh${pull.distance ? ' pulling' : ''}${pull.ready ? ' ready' : ''}`} style={{ height: pull.height, '--pull-icon-size': `${pull.iconSize}px` }} aria-hidden={!pull.distance}>
    <span className="board-pull-refresh-icon" role="status" aria-label={pull.ready ? '松开刷新全部账号' : hint}>
      <svg className="board-pull-refresh-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="15" className="board-pull-refresh-track" />
        <circle cx="18" cy="18" r="15" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - pull.progress} />
      </svg>
      <RefreshCw className="board-pull-refresh-arrow" size={24} strokeWidth={1.8} style={{ transform: `rotate(${pull.progress * 270 - 90}deg)` }} aria-hidden="true" />
    </span>
  </div>;
}
