/** One stroke weight, one corner style, drawn rather than borrowed from a font. */

interface Props {
  className?: string;
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function Caret({ className, size = 12 }: Props) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function Search({ size = 14 }: Props) {
  return (
    <svg {...base(size)}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L14 14" />
    </svg>
  );
}

export function ArrowRight({ size = 13 }: Props) {
  return (
    <svg {...base(size)}>
      <path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" />
    </svg>
  );
}
