import type { ChipKind } from './attention'

interface ChipLook {
  label: string
  /** Stroke paths of a 24-unit icon, distinct per state so the chip reads without colour. */
  icon: readonly string[]
}

const CHIP_LOOK: Readonly<Record<ChipKind, ChipLook>> = {
  alerting: {
    label: 'Alerting',
    icon: ['M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 003.4 0']
  },
  problem: {
    label: 'Problem',
    icon: ['M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z']
  },
  noData: { label: 'No data', icon: ['M4 12h3l2-5 4 10 2-5h5', 'M3 3l18 18'] },
  disabled: {
    label: 'Disabled',
    icon: ['M12 3a9 9 0 110 18 9 9 0 010-18z', 'M5.7 5.7l12.6 12.6']
  },
  present: {
    label: 'Present',
    icon: ['M12 3a9 9 0 110 18 9 9 0 010-18z', 'M12 8v5', 'M12 16h.01']
  },
  normal: {
    label: 'Normal',
    icon: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 110 6 3 3 0 010-6z']
  }
}

/**
 * A state as an icon and a word. It is deliberately not a live region: the
 * list polls every few seconds and a screen reader would otherwise announce
 * every row each time.
 */
export function StateChip({ kind }: { kind: ChipKind }) {
  const look = CHIP_LOOK[kind]
  return (
    <span className={`skar-chip skar-chip-${kind}`}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {look.icon.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      {look.label}
    </span>
  )
}
