const paths = {
  refresh: 'M20 7v5h-5 M20 12a8 8 0 1 0-2.34 5.66',
  down: 'm6 9 6 6 6-6',
  right: 'm9 5 7 7-7 7',
  left: 'm15 5-7 7 7 7',
  close: 'm6 6 12 12 M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M20 20l-3.5-3.5',
  fork: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 9a9 9 0 0 1-9 9',
  agent: 'M12 3v3 M5 9h14v10H5z M9 13h.01 M15 13h.01 M9 17h6',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
};
export type IconName = keyof typeof paths;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
