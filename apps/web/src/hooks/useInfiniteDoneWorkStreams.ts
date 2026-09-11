import { useInfiniteQuery } from '@tanstack/react-query'
import { listDoneWorkStreams, workStreamStatusesKey, WS_DONE_STATUSES } from '../api/squads'
import { queryKeys } from '../queryKeys'

const PAGE_SIZE = 50

export function useInfiniteDoneWorkStreams(opts: {
  squadId?: string
  squadIds?: readonly string[]
  statuses?: readonly string[]
  enabled?: boolean
}) {
  const statuses = opts.statuses ?? WS_DONE_STATUSES
  const statusesKey = workStreamStatusesKey(statuses)

  const query = useInfiniteQuery({
    queryKey: queryKeys.squads.doneWorkStreamsInfinite(opts.squadId, statusesKey, opts.squadIds),
    queryFn: ({ pageParam }) =>
      listDoneWorkStreams({
        squadId: opts.squadId,
        squadIds: opts.squadIds,
        statuses,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    initialPageParam: undefined as string | null | undefined,
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
    select: (data) => ({
      pages: data.pages,
      pageParams: data.pageParams,
      doneStreams: data.pages.flatMap((p) => p.items),
      totalCount: data.pages[0]?.totalCount ?? 0,
      hasMore: data.pages[data.pages.length - 1]?.hasMore ?? false,
    }),
  })

  return {
    doneStreams: query.data?.doneStreams ?? [],
    doneTotalCount: query.data?.totalCount ?? 0,
    hasMoreDone: query.data?.hasMore ?? false,
    isFetchingMoreDone: query.isFetchingNextPage,
    isLoadingDone: query.isLoading,
    fetchMoreDone: query.fetchNextPage,
  }
}
