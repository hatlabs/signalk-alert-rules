import { hostModule } from './host'

const reactDom = hostModule('__SK_REACT_DOM__')

export default reactDom
export const {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  unstable_batchedUpdates,
  version
} = reactDom
