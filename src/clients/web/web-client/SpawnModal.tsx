// SpawnModal.tsx — the [+ spawn] form (design §6). Collects a kind/name/prompt and
// runs `crtr node new` through the bridge command path; the new node's headless
// broker boots and the SSE 'nodes' invalidation refreshes the canvas navigator.

import { useState, type JSX } from 'react';
import { spawnNode } from './command-client.js';

const KINDS = ['general', 'developer', 'review', 'spec', 'design', 'plan', 'explore'];

export function SpawnModal({ onClose, onSpawned }: { onClose: () => void; onSpawned?: () => void }): JSX.Element {
  const [kind, setKind] = useState('general');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (prompt.trim() === '') {
      setError('A first prompt is required.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await spawnNode({ kind, name, prompt });
    setBusy(false);
    if (!res.ok) {
      setError(res.stderr || 'spawn failed');
      return;
    }
    onSpawned?.();
    onClose();
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Spawn a node</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="close">
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-sky-500"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Name <span className="font-normal text-slate-400">(optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind}
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-sky-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            First prompt
            <textarea
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="What should this node do?"
              className="resize-y rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-sky-500"
            />
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? 'Spawning…' : 'Spawn'}
          </button>
        </div>
      </div>
    </div>
  );
}
