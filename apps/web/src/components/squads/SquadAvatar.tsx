import clsx from 'clsx'
import { useCachedImageSrc } from '../../hooks/useCachedImageSrc'

interface Props {
  name: string
  avatarUrl?: string | null
  size?: number
  className?: string
}

/** Squad avatar: the uploaded image (always circular, cropped to fill) with the name initial as fallback. */
export function SquadAvatar({ name, avatarUrl, size = 40, className }: Props) {
  // Cache the avatar bytes by image id so it loads instantly everywhere (list, header) on every
  // future render — the signed URL's exp/sig rotate, which would otherwise re-download daily.
  const src = useCachedImageSrc(avatarUrl)
  const dims = { width: size, height: size }
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={clsx('rounded-full object-cover bg-surface-secondary shrink-0', className)}
        style={dims}
      />
    )
  }
  return (
    <div
      className={clsx(
        'rounded-full bg-accent text-white font-semibold flex items-center justify-center shrink-0',
        className
      )}
      style={{ ...dims, fontSize: Math.round(size * 0.42) }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}
