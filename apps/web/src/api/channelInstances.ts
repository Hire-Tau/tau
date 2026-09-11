import { apiFetch } from './client'

export interface ChannelInstance {
  id: string
  name: string
  provider: 'discord' | 'slack' | 'telegram'
}

export async function listChannelInstances(): Promise<ChannelInstance[]> {
  return apiFetch<ChannelInstance[]>('/channel-instances')
}
