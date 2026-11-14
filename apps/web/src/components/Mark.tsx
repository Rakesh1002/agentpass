export default function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path
        d="M22 10C16 10 14 13 14 18V25C14 29 12 32 8 32C12 32 14 35 14 39V46C14 51 16 54 22 54"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M42 10C48 10 50 13 50 18V25C50 29 52 32 56 32C52 32 50 35 50 39V46C50 51 48 54 42 54"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="28" r="5.5" className="fill-accent" />
      <path d="M29.2 31H34.8L36.6 41H27.4Z" className="fill-accent" />
    </svg>
  );
}
