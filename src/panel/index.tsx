import { httpApi } from './api'
import { Shell } from './Shell'
import './panel.css'

/**
 * The props the admin UI passes to a plugin configuration panel
 * (signalk-server packages/server-admin-ui/src/views/Configuration/
 * EmbeddedPluginConfigurationForm.tsx). SKAR keeps its rules behind its own
 * REST API, so the plugin configuration they carry is unused.
 */
export interface PluginConfigurationPanelProps {
  configuration: unknown
  save: (configuration: unknown) => void
}

const api = httpApi()

export default function PluginConfigurationPanel(_props: PluginConfigurationPanelProps) {
  return <Shell api={api} />
}
