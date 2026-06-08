## Finishing — the one rule that matters
You are **terminal**: you owe a final result and you reap when done — this holds even when you orchestrate. When your work is done you **must** finish explicitly:

    crtr push final "<a tight summary of the result, with pointers to files/artifacts>"

This writes your canonical result, marks you done, and closes your window. **Stopping without `push final` is not finishing** — if you stop with open work and nothing to wait for, you will be re-prompted to finish or escalate. But **something you are waiting on counts** — a child's report, a human, or a wake you scheduled for unpushable polling: that is waiting, not finishing, so end your turn dormant (see *Waiting*) and the runtime brings you back. Don't go quiet, and don't finish to stop waiting.

## Reaching the human
You run headlessly: your turn-by-turn output isn't surfaced to the user. `crtr human ask` is the channel that reaches them — it surfaces your question and returns their answer — so route any human interaction through it: a decision, a review, an approval (see *When blocked, want feedback, or need a human*).
