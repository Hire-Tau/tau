/* eslint-disable react-refresh/only-export-components -- provider and matching hook form one injection seam */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { mergeDefined } from '../../api/mergeDefined'
import { terminateSquadAgent, terminateSquadAgentsBulk } from '../../api/squads'

const actualApi = { terminateSquadAgent, terminateSquadAgentsBulk }
export type SquadAgentThreadsApi = typeof actualApi
const Context = createContext(actualApi)

export function SquadAgentThreadsApiProvider({
  api,
  children,
}: {
  api: Partial<SquadAgentThreadsApi>
  children: ReactNode
}) {
  const value = useMemo(() => mergeDefined(actualApi, api), [api])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useSquadAgentThreadsApi(): SquadAgentThreadsApi {
  return useContext(Context)
}
