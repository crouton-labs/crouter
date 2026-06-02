/**
 * First user message for a general `agent new` worker.
 *
 * The worker runs as an interactive agent in a tmux pane (not print mode). Its
 * result is captured automatically by the crtr stop-hook extension
 * (src/pi-extensions/agent-stophook.ts): when the agent finishes responding, its
 * final assistant message is submitted as the result and pi exits. The worker
 * therefore does NOT need to call `crtr job submit` — it just ends with its
 * answer. The original task is sent verbatim; a short note on this contract is
 * appended after a separator.
 */
export function agentNewPrompt(task: string, _jobId: string): string {
  return `${task}

---

Your final reply is captured verbatim and returned as the result to whoever spawned you. Do the work, then make your last message your complete answer in markdown — findings, code, conclusions, whatever was asked. You do NOT need to run any command to submit; just end with the answer. If you cannot finish, end with a short explanation of what blocked you.`;
}
