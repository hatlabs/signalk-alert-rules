// The admin UI puts its React modules on these globals before it loads any
// panel (signalk-server packages/server-admin-ui/src/bootstrap.tsx). The shims
// in this directory re-export them, so the panel runs on the host's React
// instead of bundling a second copy whose hooks would have no dispatcher.
declare global {
  interface Window {
    __SK_REACT__?: typeof import('react')
    __SK_REACT_DOM__?: typeof import('react-dom')
    __SK_REACT_DOM_CLIENT__?: typeof import('react-dom/client')
    __SK_REACT_JSX_RUNTIME__?: typeof import('react/jsx-runtime')
  }
}

export {}
