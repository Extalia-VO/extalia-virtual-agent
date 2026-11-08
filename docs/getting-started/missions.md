# Missions

Missions let you split a project review or analysis into a small dependency graph
of tasks, run those tasks with the models you allow, and inspect their answers
in one place. They are for research and review: the standard mission task can
read, list, and search files in the project folder. It cannot edit files, run
commands, use memory, or delegate again. Treat every answer as an unverified
model suggestion and check it yourself.

## Start a mission

Open **Missions** and choose a session in a workspace that has a project folder.
Missions run only in managed Extalia Native sessions. You can choose an
existing session or create one in Chat for that workspace. A session doing a
turn must finish or be stopped before its mission can start. Observed sessions
run in their own agent app, and Hermes Agent sessions use Hermes's own
delegation; neither can launch a native mission here.

Enter the question or review goal. Choose which saved connections are allowed
for tasks, and which of their configured models may be used. The workspace's
main connection is always available; additional connections must first be
allowed for missions in that workspace. Credentials stay with their saved
connections. A missing credential prevents that connection from working.

Choose **Plan with lead** to ask the session's lead for a proposed task graph,
or **Write the plan myself** to start with one task and build the graph by hand.
Planning does not start work. Review the task titles and instructions, select a
connection and model for each task, set dependencies, concurrency, time limits,
step limits, and optional budgets. Fix any validation issues, then choose
**Launch mission**. You can use the dependency view to see which tasks wait for
others; tasks without dependencies can run first.

## Follow results and stop

The monitor shows each task's state, worker, selected connection and model,
answer, and failure reason when available. Progress is a count of completed
tasks, not a quality score. Answers are always marked **Unverified model
answer**: Missions do not attach build, test, or file evidence to prove them.

Budgets are optional. A time limit stops running tasks and prevents tasks that
have not started from running. Token limits use only usage reported by the
provider; they are checked before a model call, so a call already in progress
is not cut off. If usage cannot be checked, new work stops. The monitor shows
when usage is missing or only a lower bound.

Use **Stop** to ask running tasks to stop. Completed answers remain available.
Stopping does not retry work. If a task's execution becomes unknown or the host
restarts before its result is retained, the mission may require reconciliation.
Refresh recovery inspects saved native state; it does not replay or resume the
mission. An unknown task is not automatically retried.

Mission records may be transient when session history is off; transient records
are held in memory and disappear when the host stops. Otherwise, saved mission
results appear in that session's Missions list. If a run is interrupted, some
answers or usage may not have been retained.

## File-writing tasks

The **Changes** panel applies only to explicitly write-capable tasks, which run
in separate Git worktrees. Read [Mission changes](mission-changes.md) before
using that experimental workflow. A worktree diff is reviewable, but the
current integration test gate is not run and its proposal cannot be applied.

Hermes Agent and observed-session work remains in those agents' own workflows.
