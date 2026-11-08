# Model selection guide

Extalia can keep one optional, user-maintained model-selection guide per profile.
Open **Team → Model selection guide** (also available in the mission composer),
write or import a Markdown/plain-text guide, set its title and revision, then save.
The editor accepts up to 24,000 characters; a longer draft remains editable and is
never silently truncated. Existing teams do not change when the guide is saved.
Use **Plan / Replan**, review the proposed roles, tasks, soul and models, then save
that team normally.

Every model-backed plan reads the current saved guide. The result records the
reference's title, revision and host-assigned update time. A guide can rank model
strengths and trade-offs, but cannot grant a connection, invent a model ID, expand
permissions or override explicit model choices. Exact available IDs and the
user's grants always take precedence. Updating a guide does not silently change
an active team's models; replanning is deliberate.

Without a guide, the lead model uses its own knowledge and must qualify uncertain
or outdated model information. Extalia does not ship a benchmark ranking or
claim to verify current prices automatically. If inference is unavailable, the
existing deterministic fallback remains explicitly labeled as a standard split;
it is neither a model judgment nor benchmark analysis. Corrupt or unreadable
saved guides produce an error rather than silently acting like no guide exists.
Native mission guidance applies during automatic planning; the reviewed tasks
remain the instructions used for execution.

The guide is stored privately as `config/model-selection-guide.json` inside the
configured Extalia data directory. Remove it through the guide editor to restore
the no-guide behavior. Each profile has its own guide. Manual team edits remain
independent of this shared reference.

## Suggested book structure

Use exact model IDs from your configured connections, rather than display names.
Replace every placeholder below with evidence you have checked. Scores from
different benchmarks, model revisions or evaluation settings are not directly
comparable. A model can be economical for short tasks and expensive for long
ones; include the conditions of each measurement.

```markdown
# Model selection reference
Revision: <version or evidence date>
Reviewed by: <maintainer>

## Selection policy
- Meet task quality and tool requirements before minimizing cost.
- Prefer a small, fast model for bounded extraction or file discovery when measured suitable.
- Use stronger reasoning for cross-system diagnosis when its measured benefit warrants it.
- Give implementation and independent review to separate workers when appropriate.
- Mark unknown capabilities, prices and benchmark results as unknown.
- Never select a model or connection outside the offered candidate pool.

## Evidence per model
Exact model ID: <configured-model-id>
Model revision: <version>
Evidence source and retrieval date: <URL or local report; date>
Workload and evaluation settings: <dataset, tool use, context length, caching>
Measured strengths: <observations>
Measured limitations: <observations>
Quality / speed / cost: <measurements and units, or unknown>
Best-fit tasks: <bounded responsibilities>
Suggested soul: <working style and domain focus, not additional permissions>
Fallback: <another allowed ID, with reason>
Confidence and open questions: <measured / estimated / unverified>

## Team patterns
Role: <responsibility>
Task: <deliverable and acceptance criteria>
Soul: <approach, evidence standard and boundaries>
Preferred models and rationale: <actual allowed IDs, conditional on task needs>
Escalation trigger: <evidence that a stronger model is required>
```

Review the evidence when providers change model versions or when your own
Extalia workloads reveal different quality, tool reliability or latency. A new
revision is visible on the next plan; the previous plan keeps its original basis
until replaced. Updating the guide or Extalia does not constitute a benchmark
run or prove measured savings.
