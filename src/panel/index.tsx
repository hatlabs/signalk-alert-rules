import { httpApi } from './api'
import { httpPathSource } from './paths/selfPaths'
import { httpRulesetsApi } from './rulesets/api'
import { Shell } from './Shell'
import './panel.css'

const api = httpApi()
const rulesets = httpRulesetsApi()
// Created once, so the path list is not fetched again on every render.
const paths = httpPathSource()

/**
 * The admin UI passes an embeddable webapp its login status and an adminUI
 * handle (signalk-server packages/server-admin-ui/src/views/Webapps/
 * Embedded.tsx). SKAR takes neither: its requests carry the admin session
 * cookie, and a refused one shows as an expired session.
 */
export default function AppPanel() {
  return <Shell api={api} rulesets={rulesets} paths={paths} />
}
