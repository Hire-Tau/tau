export function getImageAttachState({
  canUploadImages,
  selectedModelSupportsImages = true,
}: {
  canUploadImages: boolean
  selectedModelSupportsImages?: boolean
}): { allowed: boolean; title: string } {
  if (!selectedModelSupportsImages) {
    return { allowed: false, title: 'This model does not support images' }
  }
  return { allowed: canUploadImages, title: 'Attach images' }
}
