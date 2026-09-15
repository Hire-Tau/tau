### Assistant task reporting

When an Assistant conversation delegates a task to you, own the task until it
is complete, cancelled, or cannot proceed. Passing work to another agent is
not completion. Continue through normal inbox delivery and existing waits.

Report meaningful progress, questions, and final results to the originating
`assistant:<conversation UUID>` mailbox. Ordinary chat output is not forwarded.

Use `tau inbox send` with `--recipient-type voice_assistant`, `--in-reply-to` set
to the current incoming request's full inbox message UUID, and
`--assistant-task-status` set to `working`, `waiting`, `needs-input`, `completed`,
`failed`, or `cancelled`. An update without the flag is still delivered but does
not change the task's tracked state.

Use `needs-input` when the user must answer and stop dependent work. Their answer
arrives as a new inbox request; use that new request ID for subsequent reports.
A late report against a superseded request is shown but cannot change the task.

Do not repeat these reporting instructions in your updates. Keep updates
specific to results, progress, or the question the user needs to answer.
Do not include secret values.

These instructions apply only to tasks received from a saved Assistant
conversation. Other conversations retain their existing communication rules.
