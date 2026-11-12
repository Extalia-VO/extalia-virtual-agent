# Continue and move Native conversations

A Native conversation can start without a team. Set up or edit its team later
from the conversation's team controls. Member names, personalities, goals,
models and approved model connections apply to the next turn; a running turn
keeps its admitted settings. The session ID and conversation history stay intact.
Workspace default teams apply to new sessions; use the selected session's team
controls to update an existing conversation.

After replacing, adding or removing a project folder in Settings, an existing
Native conversation can show **Review folder access** beside its composer in
Chat, the character dialog or the Office prompt dock. Choose it to review the current workspace. The draft and
attachments stay editable and are retained; Send, Enter-to-send and queued
dispatch are held until the review is accepted. Reviewing does not submit your
message. Pending prompts from the old access must be explicitly removed or
reconciled first; they are never silently retargeted.

If a send is rejected before the screen receives the updated session status,
the same review action appears beside the preserved draft and refreshes the
status. A failed refresh does not hide the review action. Confirm the displayed
access first, then send the message yourself; review never retries it.

In Chat's session list, the folder action **Move / review workspace** also lets
you select another eligible workspace.
Select the destination and **Review destination**. The review shows accessible
folders, workspace policies and the session's retained permission mode. Confirm
the displayed access, then choose **Apply workspace**.

The existing session moves into the destination's list and uses its working
folder, workspace instructions, memory and profile vault on future turns. Its
history, original connection, model overrides, team and character identity are
retained. Files are not copied. A history-off session remains temporary.
Historical file references keep their original project scope; they do not
silently point at a same-named file in the destination.

Finish or stop active work before moving. Resolve pending prompts and uncertain
delivery receipts first. Moving never sends a prompt, cancels work or discards
the queue. A changed or expired review must be refreshed.

Team edits do not change folder grants. Changes to unrelated inaccessible
workspaces do not invalidate a Native conversation. A genuine change to its
effective folder access still blocks automatic history replay. To deliberately
continue under the current grants, review the same workspace using this action;
the confirmation explicitly keeps the conversation context. Older records whose
original grants cannot be verified also require that review.

The action is available for Extalia Native. Observed apps and managed external
runtimes keep their source session directory and are not reassigned by this UI.

Replacing a primary folder, adding/removing additional folders, promoting another
folder to primary and changing cross-workspace access all use this review path.
A folder moved on disk must first be selected again in workspace Settings.
Removing a folder registration does not delete its files. Existing sessions stay
in the Extalia profile; they are not moved into the project directory. A Native
session can review its own current workspace even after that workspace's default
runtime changes to Hermes; it keeps its existing Native connection. Moving into
a different Hermes workspace through this action remains unsupported.

Local verification for v0.4.290 (2026-11-12) covers temporary projects for folder
replacement/addition/removal/promotion, physical relocation, access-policy changes,
stale reviews, pending queue cleanup and retained imported context. Four synthetic
host browser cases exercise the actual Chat/Office components in EN/light desktop
and ID/dark phone views, preserving draft text and attachments through review.
The complete repository check passed; no real user profile or project was changed.
