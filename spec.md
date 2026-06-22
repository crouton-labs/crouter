# Hearth — System Specification

> **Working codename: "Hearth"** (placeholder — rename freely). The name reflects the core metaphor: every user gets a persistent *home* that belongs to their agents.

**Status:** Design spec for spec-driven development.
**Intended reader:** Claude Code (as the build spec) and the founding engineer.
**Harness:** [Pi](https://github.com/earendil-works/pi) (open-source, Node, BYOK). The existing subagent / node-graph system (Ralph-Wiggum loops that spawn nodes) is hosted *as-is*; Hearth provides the substrate, not the agent loop.

---

## 1. Overview & Vision

Hearth gives every user a **persistent, private cloud machine that belongs to their agents** — "your own device, but as if it never turned off." A user signs up and gets a durable *home*: a real filesystem, a real Linux environment, a stable address, and one or more long-lived agents that live there. The agents can work on codebases, build and ship software, run scheduled and event-driven work unattended, message the user and be summoned by the user, and host servers the user can reach — all while costing approximately nothing when idle.

### North-star principle: the honest contract

The agent is **not** fooled into thinking it lives on a literal always-on machine. Instead it operates under a **coherent, honest contract**: its compute is ephemeral and may freeze between bursts of work, but its *home* (storage, identity, address, scheduled triggers, held connections) is durable and always there. A capable model handles this fine when told the contract plainly. The failure mode to avoid is a *leaky simulation* — an environment pretending to be always-on that then loses state or behaves nonlinearly. Hearth is honest, not magic.

### The one unifying idea

> **The control plane (the "home") is always on and holds every trigger plus the stable address. Compute is off until a trigger fires, then it resumes (warm, from a memory snapshot) and attaches.**

Cron, webhooks, inbound web requests, user messages, and interactive coding sessions are all just **trigger sources** into one wake mechanism. Build the wake path once; point every trigger at it.

---

## 2. Goals / Non-Goals

### Goals
- A durable, private, isolated environment per tenant that behaves like a real Linux machine.
- Activity-proportional cost: an idle tenant costs ~storage only; you pay compute only when agents work.
- Warm resume (mid-process), so the agent's experience is continuous across freezes.
- One wake mechanism serving time-, event-, request-, message-, and human-triggered work.
- Host the existing Pi node-graph faithfully (concurrent, long-lived, self-spawning agents sharing one workspace).
- "Claude Code–like" interactive coding across laptop + phone, same machine, same home.
- Minimal long-term switching cost (see §5).

### Non-Goals (v1)
- Permanent public hosting of finished apps **inside** the home (agents *deploy out* instead — see §8.10).
- Platform-provided/metered LLM access (BYOK only — see §8.9).
- A built-in agent loop or subagent framework (Pi + the user's node-graph already provide this).
- Cross-tenant collaboration / shared homes (single owner per home in v1).
- A polished end-user GUI beyond what the interactive relay requires.

---

## 3. Core Concepts & Vocabulary

| Term | Meaning |
|---|---|
| **Home** | The durable, always-addressable tier for a tenant: persistent filesystem (volume), metadata (identity, registries, session index), stable inbound URL(s), and the holder of durable timers + persistent connections. Costs ~storage when idle. |
| **Machine / Compute** | The ephemeral Firecracker microVM where Pi and the agents actually run. Boots/resumes on a trigger, attaches the Home volume, freezes (snapshot) when idle. |
| **Wake** | The act of bringing a tenant's Machine to a running state (warm resume from snapshot, or cold boot from volume) in response to a trigger. |
| **Trigger** | Anything that requires compute: a scheduled time, an inbound request/webhook, a message, an interactive session, or a held long-running task. |
| **Control plane** | The always-on services that own identity, the trigger registries, the durable timers, routing/ingress, the relay, and the snapshot-lifecycle policy. **Owned by us**, provider-agnostic. |
| **Node-graph** | The user's existing Pi subagent system: concurrent long-lived "Ralph-Wiggum" loops that spawn child nodes, sharing one workspace. Hosted as-is. |
| **Session** | A Pi conversation, identified by a stable ID, durable via Pi's JSONL session log + the Home's session index. Can be human-interactive or headless. |
| **MachineProvider** | The thin interface behind which all provider-specific compute calls live (§5). v1 implementation = Fly Machines; later = self-hosted Firecracker. |

---

## 4. Architecture Overview

Three tiers per tenant:

1. **Home (durable, always on, ~storage cost)**
   - Persistent volume — the agent's filesystem (repos, build caches, artifacts, Pi `~/.pi` config & JSONL session logs).
   - Metadata store — identity/account, schedule registry, trigger/subscription registry, session index, secret references, snapshot handles.
   - Stable inbound URL(s) — per-tenant base URL; optional per-app subdomains/paths.

2. **Compute / Machine (ephemeral)**
   - Firecracker microVM. On wake: restore memory snapshot (warm) → processes (Pi, crtr's node-graph, `crtrd`, any servers) continue mid-flight; or cold-boot from the volume if no snapshot. Mounts the Home volume. Freezes (snapshot + stop) after idle + hysteresis.
   - Runs the existing crtr runtime as the **inner** agent system: one headless broker per node, `reviveNode()` as the sanctioned per-node launcher, `crtrd` as the in-machine supervisor, and attach/web clients as views onto broker sockets.

3. **Control plane / Router (always on, tiny, shared across tenants)**
   - Holds durable timers/triggers, stable inbound addresses, tenant auth, machine wake/snapshot policy, and the outer relay/router. On any cross-freeze trigger: resume the right tenant's Machine, then hand the event to crtr's existing in-machine runtime.
   - Does **not** become a shared crtr daemon. `crtrd` stays per-tenant inside the microVM because it reads tenant-local canvas state and supervises/kills tenant-local broker pids.

```
        ┌───────────────────────── Control plane (always on, shared) ─────────────────────────┐
        │  Scheduler/Triggers        Ingress/Router (stable URLs)      Broker Relay (WS/SSE)   │
        └───────────────▲───────────────────────▲───────────────────────────▲────────────────┘
   time trigger ────────┘        inbound HTTP / webhook / msg ┘     laptop/phone client ───────┘
                                              │ wake (resume snapshot / cold boot) + deliver
                                              ▼
                         ┌──────────────── Tenant Machine (ephemeral microVM) ───────────────┐
                         │   crtr: brokers + crtrd + node-graph │ user web servers │ builds │
                         └───────────────────────────────┬──────────────────────────────────-┘
                                                          │ mounts
                         ┌────────────────────────── Home (durable) ────────────────────────-┐
                         │  Volume (filesystem)  │  Metadata store  │  Stable URL  │  Secrets │
                         └───────────────────────────────────────────────────────────────────┘
```

---

## 5. Substrate Decision & Provider Abstraction (anti-lock-in)

**Decision: Firecracker microVMs are the architectural commitment. Snapshot ownership should live in our object storage. Fly Machines are acceptable only if they do not block that long-term shape; otherwise prefer the portable/self-hosted Firecracker path earlier.**

Rationale:
- Firecracker gives per-tenant **kernel-level isolation** (required — Pi runs arbitrary code with the tenant's credentials and ships no permission system) and **memory snapshot/restore** (the mechanism behind warm resume and the honest-contract experience).
- **Switching cost lives in the control plane, not the compute.** Coupling the scheduler/ingress/storage to a proprietary primitive (e.g. Durable Objects) is what creates lock-in. Therefore: **own the control plane; rent the compute behind an interface.**
- Fly Machines *are* Firecracker, so Fly → self-hosted Firecracker can be an **adapter swap, not a rewrite** only if snapshot/volume ownership stays portable. Do not couple the product contract to opaque provider-owned snapshots if that makes the Firecracker graduation harder.

### `MachineProvider` interface (the only provider-specific surface)

```ts
interface MachineProvider {
  createMachine(opts: { tenantId: string; image: string; cpu: number; memMB: number; volumeId: string }): Promise<MachineId>;
  resumeMachine(id: MachineId): Promise<void>;        // warm resume from snapshot
  suspendMachine(id: MachineId): Promise<SnapshotId>;  // snapshot + stop
  coldStart(id: MachineId): Promise<void>;             // boot from volume, no snapshot
  snapshot(id: MachineId): Promise<SnapshotId>;
  destroy(id: MachineId): Promise<void>;

  createVolume(tenantId: string, sizeGB: number): Promise<VolumeId>;
  attachVolume(id: MachineId, volumeId: VolumeId): Promise<void>;

  internalAddress(id: MachineId): Promise<HostPort>;   // for ingress/relay routing
  exec(id: MachineId, cmd: string[]): Promise<ExecHandle>; // for setup, diagnostics, and broker/control-plane bridge commands
}
```

- Preferred long-term provider: `FirecrackerProvider` with snapshots exported to our object storage.
- Prototype option: `FlyMachineProvider`, only if it is massively easier and can be kept behind the same snapshot/storage contract. Optional alternates: `E2BProvider`, `MorphProvider`.
- **Everything else in this spec is provider-agnostic and owned by us.**

---

## 6. Functional Requirements

Each is stated as an observable behavior. IDs are for traceability.

- **FR-1 Private per-tenant environment.** Each account gets an isolated home + machine; no agent can reach another tenant's files, credentials, compute, or network namespace.
- **FR-2 Continuity of state + execution-on-demand.** State (files, memory, history) persists across sessions and idle gaps. Genuinely-running processes are supported and may be **held indefinitely** when there is work (overnight node-graph runs, a live in-machine browser, or active remote-browser driving), and **frozen + transparently resumed** when idle.
- **FR-3 Concurrent self-spawning node-graph.** The machine hosts many concurrent, long-lived looping nodes that spawn child nodes, sharing one workspace. The graph is reconstructable after a crash from durable state.
- **FR-4 Time- and event-based triggers.** Agents can register cron-style schedules **and** event triggers (webhooks, inbound messages). All fire unattended. The agent can register *new* triggers at runtime from user-provided credentials (e.g. "wake me on this Slack channel, here's my key").
- **FR-5 Two-way messaging.** The agent can message the user and be summoned by the user (SMS/text, Slack, etc.). Inbound message = wake event; outbound message = action.
- **FR-6 Build & ship real software.** Agents can clone repos, install deps, build (e.g. `next build`), and push to a repo or deploy to an external host. The home is a *builder + previewer*, not a permanent public host.
- **FR-7 Act on the user's behalf.** Agents use per-tenant credentials to act on external services.
- **FR-8 Honest runtime contract.** The environment behaves like a real Linux machine (real fs, processes, ports, network) and the agent is given an explicit, stable description of its runtime model (§11). No leaky simulation.
- **FR-9 Crash-survivable & resumable.** A crash/restart resumes work rather than losing it. Conversations are durable; the user resumes where they left off; **headless tasks resume autonomously** without a human.
- **FR-10 Interactive cross-device sessions.** A user can open a repo and work on it "like Claude Code" from laptop and phone by connecting to a stable endpoint; the session is authoritative in the machine, devices are attached views, and the user can switch devices mid-task.

---

## 7. Non-Functional Requirements

- **NFR-1 Isolation.** One microVM per tenant; tenants never co-mingle in a single VM. (See §10.)
- **NFR-2 Activity-proportional cost.** Idle tenant ≈ storage cost only (volume + small metadata + optional retained snapshot). Compute billed only while a Machine runs. Held long jobs are billable active time by design.
- **NFR-3 Latency targets (tunable — see §13).**
  - Warm resume (snapshot present): p50 < 500 ms, p95 < 2 s.
  - Cold boot (from volume, no snapshot): < 10 s.
  - Interactive first-response-after-idle: < 1 s (achieved via hysteresis + retained warm snapshots).
- **NFR-4 Durability.** No acknowledged work is lost on a single-node crash. Session state (Pi JSONL + session index) and node-graph state are recoverable to **last durable step** (not exact live memory).
- **NFR-5 Persistence horizon (tunable).** Home persists indefinitely while the account is active; after N days idle (default 30) the warm snapshot is dropped and the volume may be moved to cold storage, restored on next access; account deletion hard-deletes the home, snapshots, and secrets.
- **NFR-6 Portability.** No control-plane component depends on a provider-proprietary primitive; compute is reached only through `MachineProvider` (§5).

---

## 8. Component Specifications

### 8.1 Control plane / Home registry
- Owns: account/identity, per-tenant `Home` record (volume id, machine id, current snapshot handle, stable URL), schedule/trigger mirrors, session index, secret references, and tenant auth for relay/ingress.
- Storage: a standard durable DB (e.g. Postgres). **No reliance on provider-proprietary storage.**
- Mirrors only the crtr state needed outside a frozen VM: next scheduled wake(s), external trigger registrations, tenant/session routing, and machine placement. The authoritative node graph remains crtr's canvas state inside the Home volume.
- Exposes internal APIs the scheduler, ingress, and relay call to resolve a tenant and trigger a wake.

### 8.2 Machine (Firecracker microVM)
- Base image: Ubuntu + Node + Pi + crtr + common toolchains (git, build tools, Node package managers, headless Chromium for in-machine browser tasks).
- On wake: `resumeMachine` (warm) or `coldStart` (from volume); attach Home volume at a fixed mount (e.g. `/home/agent`); ensure crtr's broker sockets/daemon are reachable.
- Hosts the existing crtr node-graph and any agent-started servers as ordinary local processes. crtr's broker remains the only host for a node's Pi engine; viewers and the Hearth relay attach to it.
- Freeze path: on idle + hysteresis, `suspend` (snapshot + stop); update Home's snapshot handle. `crtrd` being alive does not count as activity by itself; idle means no live agent turn, held task, active server request, or active relay session.
- Resource profile per tenant: start modest (e.g. 1–2 vCPU / 2–4 GB), burstable for builds (tunable; provider-dependent).

### 8.3 Wake mechanism (unified)
Single outer entrypoint `wake(tenantId, trigger) -> MachineHandle`:
1. Resolve Home; find current Machine + snapshot.
2. If Machine running → return handle. Else `resumeMachine` (warm) or `coldStart`.
3. Attach volume if needed; confirm crtr is reachable (`crtrd` and/or target broker socket).
4. Deliver the trigger into crtr's existing inner runtime: append inbox, route HTTP to an agent server, connect the broker relay, or let due `wakeups` fire.
5. Register activity for the hysteresis timer.
All cross-freeze triggers (cron, ingress, message, session) funnel through this. Inside a warm machine, crtr's own wake path remains authoritative: `crtrd` supervises brokers, inbox wake revives idle nodes, scheduled wakes fire, and `reviveNode()` is the only per-node launcher.

### 8.4 Scheduler / Cron
- **Cross-freeze source of truth is the Home registry mirror, not in-machine crond** (a frozen machine's crond won't fire). The in-machine crtr `wakeups` table remains the authoritative runtime schedule while the machine is warm.
- crtr already provides the agent-facing schedule surface: `node wake at`, `node wake until`, and `node wake spawn`, backed by `wakeups` rows (`bare`, `noted`, `deadline`, `spawn`) with owner, target node, fire time, recurrence, and payload.
- Hearth adds the outer durable timer: when a crtr wake is armed or advanced, mirror the tenant's earliest next fire into the control-plane DB. The control plane arms **one durable timer** for that tenant; on fire it calls `wake(tenant, {type: 'cron'})` so the VM is warm and crtr's existing daemon pass can enact due `wakeups`.
- Reliability contract: Hearth's outer scheduler is **at-least-once with idempotency**. A due wake is recorded as an attempt, delivered, then marked complete; incomplete attempts are retried after scheduler/control-plane restart. The injected/fired payload carries an `idempotency_key`, the intended fire time, and a catch-up marker so handlers can no-op duplicates. crtr's in-machine `wakeups` engine may keep its settle-before-enact behavior locally; the product-grade guarantee lives in the outer mirror.
- **Fidelity bonus:** the agent *may* also use real in-machine crond for things that only matter while awake (best-effort, no cross-freeze guarantee). The blessed crtr wake surface is what survives freezes.

### 8.5 Ingress / Router (web servers + webhooks)
- Each Home owns one stable user/home URL (`https://{tenant}.hearth.app`). Exists regardless of compute state. Multiple agent-hosted apps/nodes share that domain through path/port routing, analogous to one crouter daemon supervising many nodes on one device.
- Always-on proxy at the URL. On request:
  - Machine warm + server listening → proxy to the machine's port (e.g. `:3000`).
  - Machine frozen → `wake()` via warm resume; the listening server process is **already up post-resume** (it was snapshotted listening) → proxy. Hysteresis holds it warm for the session.
  - Never-run-before → one-time cold path: cold boot, run the agent's start command, proxy.
- The agent runs servers like a real box (`next dev`, `node server.js`, bind a port). No special API.
- **Webhooks are the same path:** inbound hit on the tenant URL → wake → deliver to the agent's listener.
- **Multi-app addressing default:** path-based routing under the tenant's one Home domain. Per-app subdomains can be added later only if product/UX demands them; they are not the default architecture.
- **Boundary:** in-home serving is for **previews, internal tools, and webhook/event receivers**. Permanent public apps must be **deployed out** (§8.10) — constant public traffic would defeat idle savings and let third parties wake a user's home.

### 8.6 Interactive session relay (Claude Code–like, cross-device)
- crtr already ships the inner relay. Each node's headless broker listens on a tenant-local `view.sock`; `crtr attach` and `crtr web /node/<id>` are attached views onto that broker, not engine hosts. The broker owns the Pi engine/session and fans output to all connected clients.
- The broker protocol already supports multi-client viewing, controller vs observer roles, request/release-control arbitration, and reconnect catch-up snapshots. Hearth should **wrap** this broker relay, not rebuild Pi RPC.
- The user connects from laptop/phone to a stable tenant endpoint; the Hearth relay authenticates the user, resolves `{tenant, session/node}`, calls `wake()` if the machine is frozen, then relays WebSocket frames to the target broker socket once the VM is reachable.
- **Cross-device continuity:**
  - Close laptop mid-task → if the agent is actively working, that's *work* → compute stays pinned and continues headless (FR-9); if idle waiting for the next turn → freeze after hysteresis.
  - Reconnect from phone → stable endpoint resolves to the same crtr node/session → `wake()` resumes (warm, or cold from disk if snapshot aged out) → the broker emits its current snapshot and the conversation continues.
- **Session addressing:** stable per-user home URL plus a control-plane session index mapping external session IDs to crtr node IDs / Pi JSONL paths. crtr is node-addressed today; Hearth adds the tenant/session routing layer.
- Missing from crtr and owned by Hearth: tenant auth, stable public URLs, cross-tenant routing, machine wake integration before broker connect, and any product-level session picker. Shipped by crtr and reused: broker engine ownership, fan-out, attach/web protocol, read-write vs observer control, and reattach continuity.

### 8.7 Messaging (two-way + agent self-provisioned triggers)
- Outbound: agent sends messages via the user's connected channel(s) using stored credentials (an "act-on-behalf" action, §8.9).
- Inbound: a message to the tenant (SMS webhook, Slack event) is an **ingress trigger** → wake → inject into the target session.
- **Agent self-provisioning:** given a user credential + instruction, the agent can register a new inbound trigger at runtime (e.g. subscribe a Slack channel, or stand up a poller). The *registration* is persisted in the Home trigger registry (durable, survives freeze); the *handling* runs in the machine on wake. Same pattern as cron: durable registration, in-machine execution.

### 8.8 Persistence & snapshot lifecycle
Three layers:
- **Volume (durable):** the filesystem. Always present. Backs cold boot. Cheap idle storage. Must include both crtr's canvas home (`~/.crouter/canvas` / `$CRTR_HOME`) and Pi's agent dir/session logs (`~/.pi/agent` / `$PI_CODING_AGENT_DIR`), plus repos, caches, artifacts, and user config.
- **Memory snapshot (warm, ephemeral-ish):** enables mid-process resume. Retained for M hours of idle (default 24), then discarded → fall back to cold boot from volume. Snapshot artifacts should be exportable to and owned in our object storage; provider-owned opaque snapshots are acceptable only for a throwaway prototype. (Tunable, §13.)
- **Metadata (durable):** identity, control-plane trigger mirrors, session index, snapshot handles.
- **Hysteresis:** after last activity, keep compute warm for H minutes (default 5–15) before snapshot+freeze. Recently-active homes stay warm to hit interactive latency targets.
- crtr graph durability: the crashed graph reconstructs from `canvas.db` + each `nodes/<id>/meta.json` + the referenced Pi JSONL session files. Other per-node artifacts (`context/`, `reports/`, `inbox.jsonl`, telemetry, transcripts) provide UX/history and wake continuity and should remain on the volume, but the graph's durable spine is the DB + metas + Pi sessions.
- `crtrd` in-memory grace clocks, stall timers, and dedupe latches are intentionally transient. Losing them on VM restart costs at most another grace interval or duplicate notice, not graph loss.

### 8.9 Credentials & egress (BYOK)
- **LLM access is BYOK:** each tenant supplies their own model API key(s); Pi is already BYOK. No platform-metered model billing in v1.
- Per-tenant secret store (LLM keys, GitHub/Slack/deploy tokens), referenced from the Home metadata; injected into the machine at wake.
- **Egress proxy (recommended):** outbound third-party calls route through a per-tenant proxy that injects credentials, so raw tokens need not sit in the agent's plaintext env. **Honest caveat:** the agent *uses* the tenant's own keys (that's the point), so it can necessarily trigger their use; the proxy reduces blast radius and protects **platform** and **cross-tenant** secrets — it does not make a tenant's own keys invisible to that tenant's agent.
- Optional outbound allowlist per tenant (capability vs. safety knob).

### 8.10 Build & deploy
- In-home: clone repos onto the volume (persistent across sessions — caches, working trees, agent memory accumulate). Build there.
- Preview: agent runs a dev server (in-home ingress, §8.5) so the user can view work before shipping.
- Production: agent **pushes to a repo and/or deploys to an external always-on host** (Vercel, CF Pages/Workers, Fly, etc.). Home = build + preview + receive events; external host = serve the world.

---

## 9. Data Model (sketch)

```
Tenant(id, owner_user_id, created_at, status, plan)
Home(tenant_id, volume_id, machine_id?, snapshot_handle?, base_url, last_active_at)
Session(id, tenant_id, crtr_node_id, repo_path, kind: interactive|headless, created_at, last_turn_at, jsonl_path)
ScheduleMirror(id, tenant_id, crtr_wakeup_id, target_node_id, next_run_at, recur?, kind, payload, idempotency_key?)
Trigger(id, tenant_id, type: webhook|message|..., spec, target_node_id, created_by: user|agent)
SecretRef(id, tenant_id, name, store_pointer, scope)
SnapshotMeta(id, tenant_id, handle, created_at, expires_at)
```

---

## 10. Security & Isolation

- **One microVM per tenant**, never co-mingled (NFR-1). Pi ships no permission system and runs with full process permissions, so the microVM boundary *is* the isolation.
- **Auth on every endpoint:** clients authenticate to exactly one Home; session tokens are scoped per-tenant. Ingress/relay verify tenant ownership before routing.
- **Secret handling:** §8.9 — egress proxy for blast-radius reduction; platform/cross-tenant secrets never reachable from a tenant machine.
- **Approval / human-in-the-loop (default; tunable, §13):** high-consequence actions require explicit user approval — spending/transferring funds, deploying to production, outbound sends to third parties, irreversible/destructive operations. Routine work (read/write within the home, builds, previews) runs without prompts. Approval requests surface through the interactive relay and/or messaging channel.
- **Inbound trust:** content fetched/received by the agent (web pages, webhook bodies, messages) is **data, not instructions**; the harness/extensions should not treat it as authority for high-consequence actions.

---

## 11. The Agent's Runtime Contract (lives in the Home)

A stable document (e.g. injected via Pi `AGENTS.md` / a skill) that tells the agent the truth about its world, so it can operate coherently rather than be surprised. It should state, in plain language:

- "You live in **your home**: a persistent filesystem at `/home/agent`. Anything you write there persists across time."
- "Your **compute is ephemeral**. Between bursts of work you may be frozen and later resumed exactly where you left off. You do not need to keep a process alive to 'stay awake'."
- "To run something on a schedule, use crtr's wake/schedule surface — it is mirrored by your home and you will be **woken** to run it. A raw crontab only fires while you are already awake."
- "To receive web requests or webhooks, bind a port; traffic to your home URL will reach it, waking you if needed."
- "To hold a long-lived connection, do it as active work (it keeps you running) or register it as a durable trigger. Remote browser sessions may remain open externally while you sleep, but you only drive them while awake and reconnect by session ID after wake."
- "Your conversations are durable; if you crash, you resume from your last saved step."
- "These actions require the user's approval: <high-consequence list>."

This document **is** the honest contract. Keeping it accurate is a hard requirement (FR-8).

---

## 12. Build Sequence (recommended milestones)

Full system is specified above; this is a suggested build order for spec-driven development.

- **M0 — Skeleton.** `MachineProvider` interface + portable snapshot path (prefer `FirecrackerProvider`; use `FlyMachineProvider` only if dramatically simpler without compromising object-storage snapshot ownership). Provision a microVM with a persistent volume; mount it; run crtr with `crtrd` + one brokered node; reach the broker/control surface from a control-plane process. Prove warm `suspend`/`resume` preserves the daemon, broker, and in-flight session.
- **M1 — Home + wake.** Control-plane DB (Tenant/Home/Session). Account → provisioned home. Unified `wake()`. Snapshot lifecycle + hysteresis (basic).
- **M2 — Interactive relay wrapper.** Stable per-tenant endpoint; tenant auth; session index mapping external session IDs to crtr node IDs; machine wake-before-connect; WebSocket relay to crtr's existing broker `view.sock`; cross-device attach/resume (laptop + phone). (Delivers the "Claude Code–like" path first — highest user-visible value, exercises wake + persistence.)
- **M3 — Ingress / web servers + webhooks.** Stable URLs; wake-on-request proxy; agent-run dev servers; webhook receiver.
- **M4 — Scheduler / cron mirror.** Mirror crtr `wakeups` into the control plane; durable outer timer wakes the VM for the earliest due row; implement at-least-once delivery with idempotency keys and retry of incomplete attempts; preserve crtr's existing in-machine enactment path.
- **M5 — Messaging + self-provisioned triggers.** Two-way channels; inbound-as-trigger; agent registering triggers from user creds.
- **M6 — Node-graph at scale + durability hardening.** Faithful hosting of concurrent self-spawning nodes; ensure the Home volume preserves `canvas.db`, node metas, and Pi sessions; verify crash → daemon restart → crtr revive paths under VM suspend/cold boot.
- **M7 — Build/deploy flows + approvals.** External deploy paths; egress proxy; high-consequence approval gating.
- **Later — provider graduation only if needed.** If M0 uses Fly for speed, graduate to `FirecrackerProvider` without changing the control plane; if M0 starts on portable Firecracker, this milestone disappears.

---

## 13. Open Decisions & Tunable Parameters

Defaults are set so they don't block the build; revisit explicitly.

| Item | Default | Notes |
|---|---|---|
| Compute substrate (v1) | Portable Firecracker preferred; Fly only if massively easier | Behind `MachineProvider`; do not let Fly-owned snapshots become the product contract. |
| LLM access | BYOK per tenant | No metered models in v1. |
| Hysteresis (warm hold) | 5–15 min after last activity | Trades idle cost vs. reconnect snappiness. |
| Snapshot retention | 24 h idle, then drop → cold boot | Snapshot artifacts owned in our object storage where supported; trades storage vs. cold-start frequency. |
| Warm-resume latency target | p50 < 500 ms / p95 < 2 s | Drives keep-warm policy. |
| Cold-boot latency target | < 10 s | Acceptable for cron; not for interactive. |
| Persistence horizon | indefinite active; archive after 30 d idle | Cold-storage the volume; restore on access. |
| Approval scope | spend / prod deploy / outbound sends / destructive | Confirm the exact list. |
| Per-tenant resources | 1–2 vCPU / 2–4 GB, burst for builds | Provider-dependent; size against `next build`. |
| Egress allowlist | off (open) by default | Flip to allowlist for safety-sensitive tenants. |

### Resolved by crtr's existing architecture and product decisions
- **Node-graph durability granularity:** persist crtr's `canvas.db`, every `nodes/<id>/meta.json`, and the Pi session JSONL files referenced by meta. The rest of the node directory remains valuable continuity/history state and should stay on the Home volume, but it is not the minimal graph reconstruction spine.
- **Interactive relay core:** reuse crtr's broker socket, attach/web protocol, multi-client fan-out, and controller/observer arbitration. Hearth adds tenant auth, stable public routing, session indexing, and wake-before-connect.
- **Inner daemon split:** `crtrd` stays inside each tenant VM as the per-canvas supervisor. The control plane owns only cross-freeze trigger arming and machine wake.
- **Snapshot ownership direction:** prefer our object storage and the long-term portable Firecracker shape over opaque provider-owned snapshots; use Fly only if it is dramatically simpler without compromising that boundary.
- **Multi-app addressing:** one Home domain per user; multiple apps/nodes route under it by path/port rather than defaulting to per-app subdomains.
- **Billing:** deferred; not a build-blocking decision now.
- **Scheduler delivery semantics:** Hearth's outer scheduler is at-least-once with idempotency keys; duplicates are acceptable and silent dropped scheduled work is not.
- **Remote browser session lifecycle:** remote browser sessions are durable external resources. Active browser driving pins compute. Idle remote sessions may outlive the VM and are reattached by provider/session ID on wake. Hearth does not pretend an asleep agent is still driving a remote browser unless a separate explicit external worker owns that task.

### Genuinely open
None. The remaining items are tunable parameters or milestone validation work, not product-architecture decisions.

---

## 14. Mapping back to requirements

| Requirement | Satisfied by |
|---|---|
| FR-1 isolation | §5 Firecracker, §10 |
| FR-2 continuity + execution-on-demand | §8.2, §8.8 snapshots/hysteresis |
| FR-3 node-graph | §8.2 hosting, §8.8 durability, M6 |
| FR-4 time/event triggers | §8.4 scheduler, §8.5 ingress, §8.7 |
| FR-5 messaging | §8.7 |
| FR-6 build & ship | §8.10 |
| FR-7 act-on-behalf | §8.9 |
| FR-8 honest contract | §1, §11 |
| FR-9 crash-survivable | §8.8, NFR-4, M6 |
| FR-10 interactive cross-device | §8.6, M2 |
| NFR-2 activity-proportional cost | §4 tiers, §8.8 |
| NFR-6 portability | §5 `MachineProvider` |
