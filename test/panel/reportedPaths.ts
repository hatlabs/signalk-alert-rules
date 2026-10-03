// The server's paths for panel tests. It imports nothing Node-only, so the
// render harness (harness/) serves the same paths in the browser.
import type { PathEntry, PathSource } from '../../src/panel/paths/selfPaths'
import { unitLookup } from '../../src/panel/signalUnits'
import { displayUnit } from '../../src/panel/units'

/** A unit shown as it is stored. */
const si = (units: string) =>
  displayUnit({ units, displayUnits: { formula: 'value * 1', symbol: units } })
const volts = si('V')
const rpm = displayUnit({ units: 'Hz', displayUnits: { formula: 'value * 60', symbol: 'rpm' } })
const celsius = displayUnit({
  units: 'K',
  displayUnits: { formula: 'value - 273.15', symbol: '°C' }
})
// The default nautical-metric preset's units, which the docs screenshots show.
export const distance = displayUnit({
  units: 'm',
  displayUnits: { formula: 'value * 0.0005399568034557236', symbol: 'nmi' }
})
const degrees = displayUnit({
  units: 'rad',
  displayUnits: { formula: 'value * 57.29577951308231', symbol: '°' }
})
const knots = displayUnit({
  units: 'm/s',
  displayUnits: { formula: 'value * 1.94384', symbol: 'kn' }
})
const percent = displayUnit({
  units: 'ratio',
  displayUnits: { formula: 'value * 100', symbol: '%' }
})

/** What the server reports: every path the worked examples read, and a few more. */
export const reported: PathEntry[] = [
  {
    path: 'electrical.batteries.house.voltage',
    units: 'V',
    unit: volts,
    value: 13.31,
    displayName: 'House battery voltage',
    zones: [
      { upper: 11.5, state: 'alarm' },
      { lower: 11.5, upper: 12, state: 'warn' }
    ]
  },
  {
    path: 'electrical.batteries.bowThruster.voltage',
    units: 'V',
    unit: volts,
    value: 12.9,
    displayName: 'Bow thruster battery voltage'
  },
  { path: 'electrical.batteries.start.voltage', units: 'V', unit: volts, value: 12.6 },
  { path: 'electrical.switches.bilgePump.state', unit: displayUnit({}), value: false },
  {
    path: 'navigation.headingMagnetic',
    units: 'rad',
    unit: degrees,
    value: 1.2,
    sources: ['compass.a', 'compass.b']
  },
  { path: 'propulsion.port.coolantTemperature', units: 'K', unit: celsius, value: 355 },
  { path: 'propulsion.starboard.coolantTemperature', units: 'K', unit: celsius, value: 356 },
  { path: 'propulsion.port.revolutions', units: 'Hz', unit: rpm, value: 20 },
  { path: 'propulsion.starboard.revolutions', units: 'Hz', unit: rpm, value: 20 },
  { path: 'propulsion.main.revolutions', units: 'Hz', unit: rpm, value: 0 },
  { path: 'propulsion.port.state', unit: displayUnit({}), value: 'started' },
  { path: 'propulsion.starboard.state', unit: displayUnit({}), value: 'started' },
  { path: 'environment.depth.belowTransducer', units: 'm', unit: si('m'), value: 4.2 },
  { path: 'tanks.freshWater.0.currentLevel', units: 'ratio', unit: percent, value: 0.6 },
  {
    path: 'navigation.position',
    unit: displayUnit({}),
    sources: ['gnss.bow', 'gnss.mast', 'gnss.stern']
  },
  { path: 'navigation.watch.acknowledged', unit: displayUnit({}), value: true },
  {
    path: 'navigation.speedOverGround',
    units: 'm/s',
    unit: knots,
    value: 2.5,
    sources: ['gnss.bow', 'gnss.stern'],
    preferredSource: 'gnss.stern'
  }
]

export const units = unitLookup(reported, distance)

export const pathSource: PathSource = {
  selfPaths: () => Promise.resolve(reported),
  distanceUnit: () => Promise.resolve(distance)
}
