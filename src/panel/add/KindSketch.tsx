import type { ConditionKind } from '../editor/conditionKinds'

const LIMIT = '#a3201f'
const VALUE = '#003399'

/** A value against its limit, drawn small: what each condition kind looks like over time. */
const SKETCHES: Readonly<Record<ConditionKind, React.ReactNode>> = {
  below: (
    <>
      <line x1="0" y1="22" x2="64" y2="22" stroke={LIMIT} strokeWidth="1.5" strokeDasharray="4 3" />
      <polyline points="2,8 18,10 32,14 44,26 62,29" fill="none" stroke={VALUE} strokeWidth="2" />
    </>
  ),
  above: (
    <>
      <line x1="0" y1="14" x2="64" y2="14" stroke={LIMIT} strokeWidth="1.5" strokeDasharray="4 3" />
      <polyline points="2,29 18,27 32,22 44,10 62,7" fill="none" stroke={VALUE} strokeWidth="2" />
    </>
  ),
  outside: (
    <>
      <line x1="0" y1="11" x2="64" y2="11" stroke={LIMIT} strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="0" y1="25" x2="64" y2="25" stroke={LIMIT} strokeWidth="1.5" strokeDasharray="4 3" />
      <polyline
        points="2,18 10,16 18,5 26,4 36,18 46,31 62,32"
        fill="none"
        stroke={VALUE}
        strokeWidth="2"
      />
    </>
  ),
  rate: (
    <>
      <polyline points="2,8 26,9 40,16 62,32" fill="none" stroke={VALUE} strokeWidth="2" />
      <polyline
        points="40,16 62,16 62,32"
        fill="none"
        stroke={LIMIT}
        strokeWidth="1.5"
        strokeDasharray="3 3"
      />
    </>
  ),
  projection: (
    <>
      <line x1="0" y1="28" x2="64" y2="28" stroke={LIMIT} strokeWidth="1.5" strokeDasharray="4 3" />
      <polyline points="2,6 22,12 34,16" fill="none" stroke={VALUE} strokeWidth="2" />
      <polyline
        points="34,16 56,28"
        fill="none"
        stroke={VALUE}
        strokeWidth="2"
        strokeDasharray="3 3"
      />
    </>
  ),
  silent: (
    <>
      <polyline points="2,18 14,16 26,19 34,17" fill="none" stroke={VALUE} strokeWidth="2" />
      <path d="M44 12l8 8M52 12l-8 8" stroke={LIMIT} strokeWidth="2" />
    </>
  ),
  state: (
    <>
      <polyline
        points="2,26 22,26 22,10 42,10 42,26 62,26"
        fill="none"
        stroke={VALUE}
        strokeWidth="2"
      />
      <line x1="22" y1="6" x2="42" y2="6" stroke={LIMIT} strokeWidth="2" />
    </>
  ),
  often: (
    <>
      {[8, 18, 24, 30, 36, 44].map((x) => (
        <line
          key={x}
          x1={x}
          y1="28"
          x2={x}
          y2="12"
          stroke={x > 20 && x < 40 ? LIMIT : VALUE}
          strokeWidth="2"
        />
      ))}
    </>
  ),
  total: (
    <>
      <line x1="0" y1="8" x2="64" y2="8" stroke={LIMIT} strokeWidth="1.5" strokeDasharray="4 3" />
      <polyline
        points="2,32 14,26 20,26 34,18 40,18 58,6"
        fill="none"
        stroke={VALUE}
        strokeWidth="2"
      />
    </>
  ),
  missing: (
    <>
      {[6, 14, 22].map((x) => (
        <line key={x} x1={x} y1="28" x2={x} y2="12" stroke={VALUE} strokeWidth="2" />
      ))}
      <line
        x1="30"
        y1="20"
        x2="62"
        y2="20"
        stroke={LIMIT}
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
    </>
  )
}

export function KindSketch({ kind }: { kind: ConditionKind }) {
  return (
    <svg className="skar-sketch" width="64" height="36" viewBox="0 0 64 36" aria-hidden="true">
      {SKETCHES[kind]}
    </svg>
  )
}
