// host.ts first: the panel's host shims read the React globals as they load.
import './host'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from '../src/panel/Shell'
import '../src/panel/panel.css'
import { fakeApi, fakeHistory, fakePaths } from './fakeServer'
import { scenarioOf } from './scenario'

const scenario = scenarioOf(window.location.search)
const api = fakeApi(scenario)
const paths = fakePaths(scenario)
const history = fakeHistory(scenario)

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root')
createRoot(root).render(
  <StrictMode>
    <Shell api={api} paths={paths} history={history} />
  </StrictMode>
)
