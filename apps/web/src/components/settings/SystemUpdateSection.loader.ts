type UpdateLoaderState = {
  isChecking: boolean
  isRebuilding: boolean
  isUpdating: boolean
}

export function getUpdateLoaderMessage({ isChecking, isRebuilding, isUpdating }: UpdateLoaderState): string | null {
  if (isChecking) return 'Checking for updates…'
  if (isRebuilding) return 'Rebuilding selected components…'
  if (isUpdating) return 'Updating system…'
  return null
}
