/** Renders the transient toast queue (lib/toast.ts) bottom-center. Soft,
 *  non-blocking — for "already handled" and resolve-success notices. */

import { useToastStore } from '../lib/toast.js';
import { cn } from '@/lib/utils.js';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={cn(
            'pointer-events-auto rounded-lg border px-4 py-2 text-sm shadow-md transition-opacity',
            t.tone === 'success'
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-border bg-card text-foreground',
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
