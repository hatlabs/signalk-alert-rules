/** Stroke icons on a 24-unit grid, drawn in the text colour and hidden from screen readers. */
function Icon({ size, paths }: { size: number; paths: readonly string[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export const BackIcon = () => <Icon size={20} paths={['M15 18l-6-6 6-6']} />
export const PowerIcon = () => <Icon size={20} paths={['M12 3v9', 'M6.3 7.3a8 8 0 1011.4 0']} />
export const EditIcon = () => <Icon size={16} paths={['M4 20h4L19 9l-4-4L4 16z']} />
export const CheckIcon = () => <Icon size={16} paths={['M5 12l5 5 9-10']} />
