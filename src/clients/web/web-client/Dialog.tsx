// Dialog.tsx — renders a blocking `extension_ui_request` as a modal overlay and
// reports the user's answer as an `extension_ui_response`. These are the agent's
// questions to the human (select/confirm/input/editor) — first-class in the shell.
// The engine BLOCKS until a response, so every path (including Escape/cancel)
// sends one: `{value}` / `{confirmed}` / `{cancelled:true}`.

import { useEffect, useState, type JSX } from 'react';
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from './protocol.js';

export function Dialog({
  request,
  onAnswer,
  onCancel,
}: {
  request: RpcExtensionUIRequest;
  onAnswer: (resp: RpcExtensionUIResponse) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
        <Body request={request} onAnswer={onAnswer} onCancel={onCancel} />
      </div>
    </div>
  );
}

function Body({
  request,
  onAnswer,
  onCancel,
}: {
  request: RpcExtensionUIRequest;
  onAnswer: (resp: RpcExtensionUIResponse) => void;
  onCancel: () => void;
}): JSX.Element {
  const id = request.id;
  switch (request.method) {
    case 'select':
      return (
        <Frame title={request.title} onCancel={onCancel}>
          <div className="flex flex-col gap-1">
            {request.options.map((opt) => (
              <button
                key={opt}
                onClick={() => onAnswer({ type: 'extension_ui_response', id, value: opt })}
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-left text-sm text-neutral-100 hover:border-sky-600 hover:bg-neutral-700"
              >
                {opt}
              </button>
            ))}
          </div>
        </Frame>
      );
    case 'confirm':
      return (
        <Frame title={request.title} onCancel={onCancel}>
          <p className="mb-3 text-sm text-neutral-300">{request.message}</p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => onAnswer({ type: 'extension_ui_response', id, confirmed: false })}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              No
            </button>
            <button
              onClick={() => onAnswer({ type: 'extension_ui_response', id, confirmed: true })}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
            >
              Yes
            </button>
          </div>
        </Frame>
      );
    case 'input':
      return (
        <TextEntry
          title={request.title}
          placeholder={request.placeholder}
          multiline={false}
          onSubmit={(value) => onAnswer({ type: 'extension_ui_response', id, value })}
          onCancel={onCancel}
        />
      );
    case 'editor':
      return (
        <TextEntry
          title={request.title}
          prefill={request.prefill}
          multiline
          onSubmit={(value) => onAnswer({ type: 'extension_ui_response', id, value })}
          onCancel={onCancel}
        />
      );
    case 'notify':
      return (
        <Frame title={request.notifyType ? request.notifyType.toUpperCase() : 'Notice'} onCancel={onCancel}>
          <p className="mb-3 text-sm text-neutral-300">{request.message}</p>
          <div className="flex justify-end">
            <button
              onClick={onCancel}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
            >
              OK
            </button>
          </div>
        </Frame>
      );
    default:
      // setStatus/setWidget/setTitle/set_editor_text should arrive as display_*
      // frames, never as a blocking dialog. If one does, unblock the engine.
      return (
        <Frame title={`Unsupported dialog: ${request.method}`} onCancel={onCancel}>
          <div className="flex justify-end">
            <button onClick={onCancel} className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white">
              Dismiss
            </button>
          </div>
        </Frame>
      );
  }
}

function Frame({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        <button onClick={onCancel} className="text-neutral-500 hover:text-neutral-300" aria-label="cancel">
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

function TextEntry({
  title,
  placeholder,
  prefill,
  multiline,
  onSubmit,
  onCancel,
}: {
  title: string;
  placeholder?: string;
  prefill?: string;
  multiline: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(prefill ?? '');
  useEffect(() => setValue(prefill ?? ''), [prefill]);
  return (
    <Frame title={title} onCancel={onCancel}>
      {multiline ? (
        <textarea
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          rows={8}
          className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 outline-none focus:border-sky-600"
        />
      ) : (
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value);
          }}
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-sky-600"
        />
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(value)}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
        >
          Submit
        </button>
      </div>
    </Frame>
  );
}
