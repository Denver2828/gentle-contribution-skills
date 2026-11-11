# Selection and Execution (normative)

Read this file before every invocation. These rules define which selected
observations may proceed and what the resulting record must preserve.

## Selection rationale

Record why the observation crossed the evaluation threshold. Use any applicable
combination of:

- recurrence or membership in a repeated failure class;
- silent cost, such as duplicated work, invalid decisions, or misleading evidence;
- an observable state or event a consumer can detect;
- evidence that can be refreshed against current state;
- verification cost proportional to the harm being prevented;
- absence of existing authority-and-consumer coverage.

Not every criterion must apply. A rare severe case may use an explicitly
justified manual-exception route. Selection admits evaluation only; it never
promotes authority.

## Memory hygiene

Record source provenance, scope, capture time, lifecycle/validity state, and any
unresolved contradiction. Never choose a version only because it is newer. When
older memory conflicts with the current visible conversation, the visible
conversation prevails and the conflict remains explicit.

When persistent capture applies, record the applicable privacy, retention, and
deletion policy or name its absence as an unresolved gap. Missing provenance,
scope, validity, or safe handling blocks promotion.

## Control outcome

When a consumer evaluates or blocks an operation, classify the event exactly:

- `policy_rejection`: the control completed its evaluation and denied the operation;
- `control_unavailable`: no valid policy decision exists because the control
  errored, timed out, refused, was unreadable, or produced incomplete evidence.

Never report unavailability as a policy rejection. For `control_unavailable`,
record whether the consumer stops (`fail_closed`) or continues (`fail_open`) and
the exact continuation.

## Execution contract

Before any proof run or consumer action, record:

- applicable attempt, time, and cost budgets, using `not_applicable` with a
  reason for dimensions that do not apply;
- the consumer's explicit terminal states;
- the durable evidence retained when execution stops;
- the named continuation for failure, timeout, or uncertainty.

A retry requires new evidence and remaining budget. Repetition alone does not
strengthen proof. If terminal evidence or a safe continuation is unavailable,
block for insufficient evidence.

## Downstream routes

Route evidence boundaries to `gentle-ai-scout`; a selected skill target to
`skill-improver`; issue/root clusters to `systemic-issue-triage`; journeys to
`gentle-ai-bench`; and contribution publication or delivery to
`gentle-ai-aporte`/RDD. This skill performs none of that routed work.

## Scope and fit decision

Before recommending a ratchet, emit one decision block. It belongs to the
existing ratchet record, not to a new ledger or authority:

```yaml
scope_fit_decision:
  scope_decision:
    owner: ours | third_party | none
    authority: <path or external repository>
    allowed_edit_root: <owned root or none>
    route: direct | proposal | archive
  fit_decision:
    failure_class: <root class>
    mandatory_consumer: <path/command or none>
    intervention_point: <where the control observes the failure or none>
    counterfactual_proof: <fail-before/pass-after, replay, driven journey, sweep, or unavailable>
  coherence: pass | blocked
  continuation: <one mandatory next action>
```

Coherence is mechanical: `third_party` requires `allowed_edit_root: none` and
`route: proposal`; `ours` with `route: direct` requires a named mandatory
consumer and intervention point; `none` requires `route: archive`. Any other
combination is `blocked` and no authority change is proposed. The observation
triage handoff remains unevaluated and must not prefill this block.
