/**
 * Minimal toast store (zustand). Used for soft, non-blocking notices — e.g. a
 * stale deck that was "already handled" elsewhere, or a deck resolved
 * successfully. Deliberately tiny: one transient message queue, auto-dismissed.
 */

import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success';
}

interface ToastStore {
  toasts: Toast[];
  push: (message: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for non-component callers. */
export function toast(message: string, tone: Toast['tone'] = 'info'): void {
  useToastStore.getState().push(message, tone);
}
