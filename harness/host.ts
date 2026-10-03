// Puts React on the globals the admin UI sets before it loads a panel
// (signalk-server packages/server-admin-ui/src/bootstrap.tsx), which the
// panel's host shims read as their modules load. main.tsx imports this first.
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'

window.__SK_REACT__ = React
window.__SK_REACT_DOM__ = ReactDom
window.__SK_REACT_DOM_CLIENT__ = ReactDomClient
window.__SK_REACT_JSX_RUNTIME__ = JsxRuntime
