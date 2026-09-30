import { hostModule } from './host'

const runtime = hostModule('__SK_REACT_JSX_RUNTIME__')

export const { Fragment, jsx, jsxs } = runtime
