/**
 * Blocking extension UI dialog (spec §5.H). Renders the modal extension request
 * from the session store (select/confirm/input/editor/notify) and sends the
 * controller's answer back via store.dialogResponse. An observer
 * (role !== 'controller') sees a read-only "the controller is being prompted"
 * state and cannot answer (H.2). The non-modal methods
 * (setStatus/setWidget/setTitle/set_editor_text) are NOT handled here — the
 * server routes those into chrome / the input field — so this component renders
 * nothing for them.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils.js';
import type { RpcExtensionUIRequest, DialogResponseValue, WebRole } from '@/shared/protocol.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';

type ModalRequest = Extract<
  RpcExtensionUIRequest,
  { method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' }
>;

const MODAL_METHODS = new Set(['select', 'confirm', 'input', 'editor', 'notify']);

function isModal(req: RpcExtensionUIRequest): req is ModalRequest {
  return MODAL_METHODS.has(req.method);
}

/** React-compatible subset of the session store — plain values, not signal accessors. */
interface ExtensionDialogStore {
  dialog: RpcExtensionUIRequest | null;
  role: WebRole;
  dialogResponse: (requestId: string, response: DialogResponseValue) => void;
}

export function ExtensionDialog(props: { store: ExtensionDialogStore }): ReactNode {
  const req = props.store.dialog;
  const modal = req && isModal(req) ? req : null;
  const canAnswer = props.store.role === 'controller';

  return (
    <Dialog open={modal !== null}>
      <DialogContent showCloseButton={false} className={modal && !canAnswer ? 'opacity-90' : undefined}>
        {modal && (
          canAnswer ? (
            <DialogBody key={modal.id} req={modal} store={props.store} />
          ) : (
            <ObserverNotice key={modal.id} req={modal} />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

function ObserverNotice(props: { req: ModalRequest }): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">The controller is being prompted</p>
      <p className="text-sm text-muted-foreground">{describeRequest(props.req)}</p>
    </div>
  );
}

/** Border + text accent for a notify dialog by its type. */
function notifyClasses(type: string | undefined): string {
  switch (type) {
    case 'error':
      return 'border-destructive/40 text-destructive';
    case 'warning':
      return 'border-warning/40 text-warning';
    case 'success':
      return 'border-success/40 text-success';
    default:
      return 'border-border text-foreground';
  }
}

function describeRequest(req: ModalRequest): string {
  switch (req.method) {
    case 'select':
      return `${req.title} — ${req.options.length} options`;
    case 'confirm':
      return `${req.title}: ${req.message}`;
    case 'input':
      return req.title;
    case 'editor':
      return req.title;
    case 'notify':
      return req.message;
  }
}

function DialogBody(props: { req: ModalRequest; store: ExtensionDialogStore }): ReactNode {
  const cancel = (): void => props.store.dialogResponse(props.req.id, { cancelled: true });

  if (props.req.method === 'select') {
    return (
      <SelectDialog
        req={props.req as Extract<ModalRequest, { method: 'select' }>}
        store={props.store}
        cancel={cancel}
      />
    );
  }
  return <NonSelect req={props.req} store={props.store} cancel={cancel} />;
}

function SelectDialog(props: {
  req: Extract<ModalRequest, { method: 'select' }>;
  store: ExtensionDialogStore;
  cancel: () => void;
}): ReactNode {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{props.req.title}</DialogTitle>
      </DialogHeader>
      <ul className="flex flex-col gap-2">
        {props.req.options.map((opt) => (
          <li key={opt}>
            <Button
              variant="secondary"
              className="w-full justify-start"
              onClick={() => props.store.dialogResponse(props.req.id, { value: opt })}
            >
              {opt}
            </Button>
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={props.cancel}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function NonSelect(props: {
  req: ModalRequest;
  store: ExtensionDialogStore;
  cancel: () => void;
}): ReactNode {
  // useState initialised once per mount — DialogBody keys on req.id so this
  // resets whenever a new dialog replaces an in-flight one.
  const [text, setText] = useState(
    props.req.method === 'editor'
      ? ((props.req as Extract<ModalRequest, { method: 'editor' }>).prefill ?? '')
      : '',
  );

  if (props.req.method === 'confirm') {
    const r = props.req as Extract<ModalRequest, { method: 'confirm' }>;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{r.title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{r.message}</p>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => props.store.dialogResponse(r.id, { confirmed: false })}
          >
            No
          </Button>
          <Button onClick={() => props.store.dialogResponse(r.id, { confirmed: true })}>
            Yes
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (props.req.method === 'input' || props.req.method === 'editor') {
    const r = props.req as Extract<ModalRequest, { method: 'input' | 'editor' }>;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{r.title}</DialogTitle>
        </DialogHeader>
        {r.method === 'editor' ? (
          <Textarea
            className="resize-none font-mono text-sm"
            rows={8}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autoFocus
          />
        ) : (
          <Input
            placeholder={(r as Extract<ModalRequest, { method: 'input' }>).placeholder ?? ''}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autoFocus
          />
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={props.cancel}>
            Cancel
          </Button>
          <Button onClick={() => props.store.dialogResponse(r.id, { value: text })}>
            Submit
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (props.req.method === 'notify') {
    const r = props.req as Extract<ModalRequest, { method: 'notify' }>;
    return (
      <>
        <p className={cn('rounded border px-3 py-2 text-sm', notifyClasses(r.notifyType))}>
          {r.message}
        </p>
        <DialogFooter>
          <Button onClick={() => props.store.dialogResponse(r.id, { confirmed: true })}>
            OK
          </Button>
        </DialogFooter>
      </>
    );
  }

  return null;
}
