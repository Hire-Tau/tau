/** questionData.questions[0].id that marks an agent halted for a sandbox restart. */
export const SANDBOX_RESTART_QUESTION_ID = 'sandbox_restarting'

/** Max consecutive sandbox-restart halts before we give up and fail. */
export const MAX_SANDBOX_RESTARTS = 3

/** metadata keys persisted on the agent. */
export const META_COUNT = 'sandboxRestartCount'
export const META_LAST_AT = 'lastSandboxRestartAt'
