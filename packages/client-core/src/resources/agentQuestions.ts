import type { AgentQuestion } from '@ficus/shared'
import type { Transport } from '../transport'

export function agentQuestionsResource(t: Transport) {
  return {
    getAgentQuestions: (agentId: string, status?: 'open' | 'answered'): Promise<AgentQuestion[]> => {
      const params = status ? `?status=${status}` : ''
      return t.request(`/agent-questions/by-agent/${agentId}${params}`)
    },
    answerAgentQuestion: (id: string, answer: string): Promise<AgentQuestion> =>
      t.request(`/agent-questions/${id}/answer`, {
        method: 'POST',
        body: { answer },
      }),
    dismissAgentQuestion: (id: string, reason?: string): Promise<AgentQuestion> =>
      t.request(`/agent-questions/${id}`, {
        method: 'DELETE',
        ...(reason ? { body: { reason } } : {}),
      }),
    retryAgentQuestionAnswerDelivery: (id: string): Promise<AgentQuestion> =>
      t.request(`/agent-questions/${id}/retry-delivery`, { method: 'POST' }),
  }
}
