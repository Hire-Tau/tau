/* eslint-disable react-refresh/only-export-components -- provider and matching hook form one injection seam */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { mergeDefined } from '../../api/mergeDefined'
import { listSquads } from '../../api/squads'

const actualSquadsApi = { listSquads }
export type SquadsApi = typeof actualSquadsApi
const SquadsApiContext = createContext(actualSquadsApi)

export function SquadsApiProvider({ api, children }: { api: Partial<SquadsApi>; children: ReactNode }) {
  const value = useMemo(() => mergeDefined(actualSquadsApi, api), [api])
  return <SquadsApiContext.Provider value={value}>{children}</SquadsApiContext.Provider>
}

export function useSquadsApi(): SquadsApi {
  return useContext(SquadsApiContext)
}
