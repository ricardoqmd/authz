---
"@ricardoqmd/authz-core": minor
---

Adds two optional injected ports — `ContextStore` and `ContextSignal` — so an authorization context
can survive a reload and a tab can be told the context changed somewhere else. Neither is implemented
here: this package still touches no DOM, no `window` and no `localStorage`, and the browser
implementations arrive separately. The two are independent; either may be supplied without the other.

At `start()` a stored id is honoured **only when the list the decision point just returned contains
it and that context grants access** — the stored value is a hint about which of the server's contexts
to prefer, never a claim that the subject holds one. Anything else is discarded and the store cleared.
Neither port can take the session down: a failing `read` is treated as nothing persisted, and a
failing `write`, `clear` or `announce` is ignored while the selection completes.

A notice carrying a different context moves the session to the new `CONTEXT_CHANGED_ELSEWHERE` state
and, in the same step, drops the active context, clears the decision cache and bumps the generation:
the screen keeps its menu but `decide()` answers the empty list, so absent resolves to `DENY`. The
state carries both the new and the previous context id, and is left by `start()` or `selectContext()`
— there is deliberately no dismissal. `AuthorizationSession` also gains `close()`, which unsubscribes
and makes the session inert without closing the injected signal.

A context is persisted **only once the session reaches `READY` under it**: a selection that has no
access, whose menu fetch fails, or whose menu is labelled with another context writes nothing and
leaves the previous value alone, so a reload restores the last context that actually worked instead of
returning the subject to the screen they were escaping. One narrow exception, stated because it is
measured rather than intended: a selection superseded **while the write itself is in flight** does
write. The stored id is a hint re-validated at `start()`, so that can cost a re-selection and never
an access.

**A superseded selection no longer announces to the other tabs.** `selectContext()` re-checks the
generation after activation, so a call overtaken by a `close()`, by a cross-tab notice, or by a later
`start()` or `selectContext()` stays silent. Before this, a tab whose store write was still in flight
could announce a context it never reached — evicting the tab that had legitimately selected another
one and leaving every tab naming a context none of them was in. Selections that end in no-access or
unavailable **still announce**: the subject did switch, and a tab that kept answering would be
painting permits the backend will refuse.

⚠️ **`close()` changes meaning, and this is a behaviour change worth naming.** It no longer only
unsubscribes: it marks the session closed, then drops the active context, clears the decision cache,
bumps the generation and emits a final `IDLE` before dropping listeners. A consumer that called
`close()` and kept using the object will now get denials where it used to get permits. That is the
correction — a closed session must not keep answering with a previous subject's menu — but it is a
change, not a no-op.

The session is marked closed **before** that final emission, and the order is the point: with the flag
set afterwards, a listener that re-entered `start()` or `selectContext()` from the `IDLE` render was
served by a session that was closing, and served correctly — leaving it `READY` with a permission menu
and answering `PERMIT`. The emission still comes first, so a binding keeps its one render to clear the
screen; what changed is that the session stops answering during it.

⚠️ **A subscribed listener that throws is now contained instead of escaping, and that is observable
too.** The throw is caught, the remaining listeners still receive the emission, and the publishing
call — `start()`, `selectContext()`, `close()` — completes normally. A consumer whose render bug used
to surface as a rejected `start()` will now see it swallowed and reported nowhere: this package has no
diagnostic channel, deliberately, so a listener owns its own errors. It also fixes a session that
could never be closed — a throw during `close()` skipped the listener drop, the signal unsubscribe and
the closed flag, so every later `close()` threw again.

**Minor and not patch even though every addition is optional:** the state union grew, so a consumer
with an exhaustive `switch` will stop compiling. That is correct — it is a new screen — but it is not
a patch.
