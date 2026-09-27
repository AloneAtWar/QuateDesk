/** One responsive application frame for the desktop window and remote browser. */
export function AppShell({ variant = 'desktop', controls, actions, children }) {
  const remote = variant === 'remote';
  return <div className={remote ? 'remote-app remote-shell' : 'app-shell'}>
    <header className={`titlebar${remote ? ' remote-titlebar' : ''}`}>
      <span className="titlebar-drag"><img src={remote ? '/quota-desk.svg' : './quota-desk.svg'} alt="" /><b>Quota Desk</b></span>
      <div className="titlebar-controls">{controls}</div>
      {actions && <div className="titlebar-actions">{actions}</div>}
    </header>
    {children}
  </div>;
}

export default AppShell;
