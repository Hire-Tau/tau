import { useCallback, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFullscreen } from '../hooks/useFullscreen'
import { ChatFullscreenContext } from './ChatFullscreenContext'
import { Modal } from './Modal'

type Props = Pick<ComponentProps<typeof Modal>, 'title' | 'titleContent' | 'headerExtra'> & {
  isFullscreen: boolean
  onExitFullscreen: () => void
  inlineHeader: ReactNode
  className: string
  children: ReactNode
}

/** Both expansion paths keep the conversation mounted while moving its DOM host. */
export function ExpandableChatPanel({
  isFullscreen,
  onExitFullscreen,
  inlineHeader,
  className,
  children,
  ...heading
}: Props) {
  const mobile = useFullscreen()
  const expanded = isFullscreen || mobile.isFullscreen
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.className = 'flex flex-col grow min-h-0 min-w-0'
    return element
  })
  const attachHost = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot && host) slot.appendChild(host)
    },
    [host]
  )
  const close = () => {
    mobile.exitFullscreen()
    if (isFullscreen) onExitFullscreen()
  }

  return (
    <ChatFullscreenContext.Provider value={mobile.enterFullscreen}>
      <div className={expanded ? 'flex-1 min-w-0 min-h-0' : className}>
        {!expanded && (
          <>
            {inlineHeader}
            <div ref={attachHost} className="flex flex-col grow min-h-0 min-w-0">
              {!host && children}
            </div>
          </>
        )}
      </div>
      <Modal isOpen={expanded} onClose={close} {...heading} mobileFullscreen maxWidth="chat" noChildPadding>
        {expanded && <div ref={attachHost} className="flex flex-col grow min-h-0 min-w-0" />}
      </Modal>
      {host && createPortal(children, host)}
    </ChatFullscreenContext.Provider>
  )
}
