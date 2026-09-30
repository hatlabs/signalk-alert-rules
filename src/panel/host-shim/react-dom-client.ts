import { hostModule } from './host'

const client = hostModule('__SK_REACT_DOM_CLIENT__')

export default client
export const { createRoot, hydrateRoot } = client
