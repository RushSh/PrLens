/** Small inline icons (16px grid, currentColor), drawn for this app. */
import type { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

export const PullIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="4" cy="3.5" r="1.75" />
    <circle cx="4" cy="12.5" r="1.75" />
    <circle cx="12" cy="12.5" r="1.75" />
    <path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
  </Svg>
);
export const CommitIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M1 8h4.5M10.5 8H15" />
  </Svg>
);
export const LensIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 4 4M5 7h4M7 5v4" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="m3 8.5 3 3 7-7" />
  </Svg>
);
export const XIcon = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const DotIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />
  </Svg>
);
export const FileIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.75h5L12.5 5v9.25H4z" />
    <path d="M9 1.75V5h3.5" />
  </Svg>
);
export const ChevronIcon = ({ open, ...p }: P & { open?: boolean }) => (
  <Svg {...p} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}>
    <path d="m6 4 4 4-4 4" />
  </Svg>
);
export const CommentIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5z" />
  </Svg>
);
export const ShieldIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.5 13.5 3.5v4c0 3.5-2.5 5.8-5.5 7-3-1.2-5.5-3.5-5.5-7v-4z" />
    <path d="m5.5 8 2 2 3-3.5" />
  </Svg>
);
export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.5v9l7-4.5z" />
  </Svg>
);
export const ChartIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 13.5h12M4 11V7M8 11V4M12 11V8.5" />
  </Svg>
);
export const BugIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="8" cy="9" rx="3.5" ry="4.5" />
    <path d="M8 4.5v9M4.5 7.5 2 6.5M11.5 7.5 14 6.5M4.5 11 2 12M11.5 11l2.5 1M6 4.5 5 2.5M10 4.5l1-2" />
  </Svg>
);
export const SkipIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5 7.5 8 3 11.5zM8.5 4.5 13 8l-4.5 3.5z" />
  </Svg>
);
