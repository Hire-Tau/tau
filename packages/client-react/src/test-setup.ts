import { Window } from 'happy-dom'
import { act } from 'react'
import { notifyManager } from '@tanstack/query-core'

const window = new Window({ url: 'http://localhost/' })
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
  document: window.document,
  navigator: window.navigator,
})

// Route all React Query state notifications through React's act() so that
// query results that land via setTimeout(fn, 0) are properly wrapped, preventing
// "An update to Probe inside a test was not wrapped in act(...)" warnings.
notifyManager.setNotifyFunction(act)
