import { useEffect, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
export { accountRefreshFeedback } from './refresh-feedback';

export function useTransientToast() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast];
}

export function TransientToast({ toast }) {
  if (!toast) return null;
  return <div key={toast.id} className={`toast ${toast.ok ? 'ok' : 'fail'}`} role="status" aria-live="polite" aria-atomic="true">
    {toast.ok ? <Check size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
    <span>{toast.message}</span>
  </div>;
}
