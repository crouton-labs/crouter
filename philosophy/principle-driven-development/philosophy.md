# Principle-driven development — build from beliefs, and keep distilling them

Crouter is built from beliefs about how agents should work, not from a backlog of features. This doc is the meta-principle behind everything else in this directory: every directive descends from a higher-level belief, that belief is captured and kept, and the set of beliefs is continually distilled from real conversations so the *why* behind the *what* stays explicit and current.

## The core principle

> **Development is principle-driven. Every directive descends from a belief about how the system should work, and that belief is captured and kept — so the *why* outlives the moment it was spoken. An agent building crouter should know not just what it is asked to build, but the idea the request serves.**

A feature is the surface; the principle beneath it is what actually guides the work. The why is not commentary on the directive — it is the thing the directive is in service of, and it is what lets the work be done right.

## The why is first-class

An agent that understands the belief behind a request builds the right thing even where the request is underspecified, and recognizes when a literal reading would betray the intent. A directive without its principle is a brittle instruction; a directive *with* its principle is a goal an agent can reason about. So the why is recorded alongside the what — here, in this directory — not left to evaporate when the conversation ends.

> **Invariant A — Every directive traces to a principle.** The belief a request serves is captured, not just the request. An agent should be able to ask "why are we building this?" and find the answer written down, rather than re-litigate it from scratch.

## Principles are distilled from real work, continuously

Beliefs rarely arrive pre-articulated. They emerge across many conversations and directives, and the high-level principle has to be *extracted* from the accumulated specifics. That distillation is ongoing: a principle gets sharpened or newly written when a belief surfaces in the moment, and the body of past conversations is itself a source — re-read for the higher-level beliefs the individual directives encode. The set of guiding principles is a living distillation of what has actually been said and asked, never a frozen or speculative doc set.

The intent is for the system itself to carry this load over time — surfacing principles as they emerge in conversation, and revisiting old conversations to extract the beliefs they encode — so that capturing the why is not extra work the human must remember to do. That direction is a belief about the system, recorded here as a principle; it is not a build plan.

> **Invariant B — Principles are living and distilled.** The set of guiding beliefs is continually extracted and refined from actual conversations and directives — sharpening or adding a principle whenever one surfaces — never left frozen and never invented speculatively.

## Principles guide, and they evolve

A principle is the bar the code is measured against, and also a belief that is itself refined as understanding deepens. Capturing the why is not bureaucracy: it is what lets a fresh agent — one with no memory of the conversation that produced the belief — act in alignment with intent it was never personally told. When understanding sharpens, the principle is rewritten; it is a current statement of belief, not a log of how the belief was reached.

> **Invariant C — Principles are the measure, and they evolve.** They are the durable reference code is held to, and they are themselves revised as the beliefs behind them sharpen — captured so that an agent who never heard the original conversation still builds in alignment with it.

## What "good" feels like

- A fresh agent reads the philosophy, understands *why* crouter is shaped the way it is, and builds in alignment without being walked through the reasoning.
- A belief that surfaces in conversation is distilled into a sharpened or new principle, instead of evaporating when the chat ends.
- An agent handed an underspecified directive infers the right thing, because it knows the principle the request serves and reasons from intent rather than letter.
- Old conversations are mined for the higher-level beliefs they encode, and those beliefs become explicit principles the whole system can act on.

## Anti-goals (the "broken" feel)

- **Feature-driven amnesia.** Building what was asked without capturing why, so the belief behind it is lost the moment the conversation ends and the next agent re-litigates it.
- **Literalism over intent.** Executing the surface of a directive in a way that betrays the belief it served, because the why was never understood.
- **Frozen principles.** A static doc set that no longer reflects the beliefs actually guiding the work — principles that stopped being distilled from reality.
- **Bureaucratic capture.** Recording principles as ceremony rather than as the genuine, sharp why that lets an unbriefed agent act in alignment.
