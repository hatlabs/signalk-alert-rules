export function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** A priority as a coloured word, from caution to emergency. */
export function PriorityBadge({ priority }: { priority: string }) {
  return <span className={`skar-priority skar-priority-${priority}`}>{capitalised(priority)}</span>
}
