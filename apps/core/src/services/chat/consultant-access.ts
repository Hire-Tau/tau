import { HTTPException } from 'hono/http-exception'
import { Squad } from '../../entities/Squad'
import { hasPermission, type Identity } from '../rbac'

/**
 * Creating a consultant delegates its normal squad authority. Use the same
 * gate for direct chat creation and Assistant delegation, including follow-ups
 * that infer their squad from an existing delegate. Read access alone is not
 * permission to create a consultant.
 */
export async function requireConsultantCreationAccess(identity: Identity | undefined, squadId: string): Promise<Squad> {
  const squad = await Squad.find(squadId)
  if (!identity || !squad || squad.status !== 'active' || !(await hasPermission(identity, 'chat:send', squad.id))) {
    throw new HTTPException(404, { message: 'Squad not found' })
  }
  return squad
}
