const paths = {
  refresh: 'M20 7v5h-5 M20 12a8 8 0 1 0-2.34 5.66',
  down: 'm6 9 6 6 6-6',
  right: 'm9 5 7 7-7 7',
  left: 'm15 5-7 7 7 7',
  close: 'm6 6 12 12 M18 6 6 18',
  records: 'M8 3h8l4 4v14H4V3h4 M15 3v5h5 M8 12h8 M8 16h6',
};
export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
