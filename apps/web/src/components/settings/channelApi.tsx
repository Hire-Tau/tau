/* eslint-disable react-refresh/only-export-components -- provider and matching hook form one injection seam */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { mergeDefined } from '../../api/mergeDefined'
import {
  createChannelInstance,
  updateChannelInstance,
  deleteChannelInstance,
  revertChannelInstance,
  revertChannelInstanceFields,
  disableChannelInstance,
  enableChannelInstance,
  exportChannelInstanceYaml,
} from '../../api/config'

const actualChannelApi = {
  createChannelInstance,
  updateChannelInstance,
  deleteChannelInstance,
  revertChannelInstance,
  revertChannelInstanceFields,
  disableChannelInstance,
  enableChannelInstance,
  exportChannelInstanceYaml,
}

export type ChannelApi = typeof actualChannelApi

const ChannelApiContext = createContext<ChannelApi>(actualChannelApi)

export function ChannelApiProvider({ api, children }: { api: Partial<ChannelApi>; children: ReactNode }) {
  const value = useMemo(() => mergeDefined(actualChannelApi, api), [api])
  return <ChannelApiContext.Provider value={value}>{children}</ChannelApiContext.Provider>
}

export function useChannelApi(): ChannelApi {
  return useContext(ChannelApiContext)
}
