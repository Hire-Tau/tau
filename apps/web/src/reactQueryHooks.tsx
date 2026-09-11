/* eslint-disable react-refresh/only-export-components -- hook providers intentionally colocate their matching hooks */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  useInfiniteQuery as useInfiniteQueryActual,
  useMutation as useMutationActual,
  useQuery as useQueryActual,
  useQueryClient as useQueryClientActual,
} from '@tanstack/react-query'

type ReactQueryHooks = {
  useQuery: typeof useQueryActual
  useInfiniteQuery: typeof useInfiniteQueryActual
  useMutation: typeof useMutationActual
  useQueryClient: typeof useQueryClientActual
}

const actualHooks: ReactQueryHooks = {
  useQuery: useQueryActual,
  useInfiniteQuery: useInfiniteQueryActual,
  useMutation: useMutationActual,
  useQueryClient: useQueryClientActual,
}

const ReactQueryHooksContext = createContext<ReactQueryHooks>(actualHooks)

export function ReactQueryHooksProvider({ hooks, children }: { hooks: Partial<ReactQueryHooks>; children: ReactNode }) {
  const value = useMemo(() => ({ ...actualHooks, ...hooks }), [hooks])
  return <ReactQueryHooksContext.Provider value={value}>{children}</ReactQueryHooksContext.Provider>
}

export const useQuery: typeof useQueryActual = ((...args: Parameters<typeof useQueryActual>) =>
  useContext(ReactQueryHooksContext).useQuery(...args)) as typeof useQueryActual
export const useInfiniteQuery: typeof useInfiniteQueryActual = ((...args: Parameters<typeof useInfiniteQueryActual>) =>
  useContext(ReactQueryHooksContext).useInfiniteQuery(...args)) as typeof useInfiniteQueryActual
export const useMutation: typeof useMutationActual = ((...args: Parameters<typeof useMutationActual>) =>
  useContext(ReactQueryHooksContext).useMutation(...args)) as typeof useMutationActual
export const useQueryClient: typeof useQueryClientActual = ((...args: Parameters<typeof useQueryClientActual>) =>
  useContext(ReactQueryHooksContext).useQueryClient(...args)) as typeof useQueryClientActual
