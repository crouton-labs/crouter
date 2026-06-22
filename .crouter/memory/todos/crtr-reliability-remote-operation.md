---
kind: knowledge
when-and-why-to-read: When picking up crtr reliability, remote operation, cloud
  hosting, or power/sleep behavior work, this reference should be read because
  it records the open reliability TODOs Silas asked to capture.
short-form: "TODO: keep long crtr generations awake/reliable, add phone/online
  node control, design cloud crtr repo model, and improve network/connection
  error logging"
system-prompt-visibility: preview
file-read-visibility: none
---

Open TODO: make crtr reliable for long-running agent work across local laptop use, phone control, and cloud execution.

## Prevent local sleep during active generation
When crtr is generating and the computer is plugged in, the device should not turn off or sleep. The implementation should be scoped to active crtr work, not a permanent global sleep override, and should release the assertion when generation ends.

## Phone / online control for regular nodes
Add a way to operate ordinary crtr nodes from a phone, likely through the web UI or a small online app. It should support the same core loop a desktop operator needs: see active nodes, read reports/messages, send replies, and drive a selected node.

## Cloud crtr for always-on reliability
Design and build a cloud-running crtr mode so agents do not die or stall when the laptop sleeps. The design needs an explicit repo/workspace model: how repos are checked out, how credentials and local state are handled, how local test runs still work, and how a developer can reproduce or test the same workflow locally before trusting the hosted path.

## Better error logging for network / connection failures
Improve logging and surfaced diagnostics for network and connection errors. Failures should say which link broke, what operation was in progress, whether the agent can retry safely, and where the detailed log lives. This is part of reliability, not polish: silent or vague connection errors make the system feel like it is crapping out.
