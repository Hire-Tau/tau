/* eslint-disable react-refresh/only-export-components -- provider and matching hook form one injection seam */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { mergeDefined } from '../../api/mergeDefined'
import { deleteSetting, setSetting } from '../../api/settings'

const actualSettingsApi = { deleteSetting, setSetting }
export type SettingsApi = typeof actualSettingsApi
const SettingsApiContext = createContext(actualSettingsApi)

export function SettingsApiProvider({ api, children }: { api: Partial<SettingsApi>; children: ReactNode }) {
  const value = useMemo(() => mergeDefined(actualSettingsApi, api), [api])
  return <SettingsApiContext.Provider value={value}>{children}</SettingsApiContext.Provider>
}

export function useSettingsApi(): SettingsApi {
  return useContext(SettingsApiContext)
}
