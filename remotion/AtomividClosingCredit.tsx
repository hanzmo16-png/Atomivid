import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

/** Explicit opt-in for the owner's new productions. Existing renders stay unchanged. */
export function AtomividClosingCredit() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  if (frame < Math.max(0, durationInFrames - Math.round(3 * fps))) return null;

  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", pointerEvents: "none" }}>
      <div style={{ marginTop: 64, display: "flex", alignItems: "center", gap: 22,
        padding: "18px 32px", borderRadius: 18, backgroundColor: "rgba(8,8,16,0.90)",
        border: "1px solid rgba(143,127,245,0.45)", fontFamily: "Arial, Helvetica, sans-serif" }}>
        <span style={{ color: "#ddd9ed", fontSize: 38, fontWeight: 500 }}>Powered by</span>
        <svg width="76" height="76" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <g stroke="#8f7ff5" strokeWidth="1.3" strokeLinecap="round">
            <ellipse cx="12" cy="12" rx="10" ry="4.1" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
          </g>
          <circle cx="12" cy="12" r="2.6" fill="#8f7ff5" />
        </svg>
        <span style={{ color: "white", fontSize: 64, fontWeight: 700, letterSpacing: -1 }}>Atomivid</span>
      </div>
    </AbsoluteFill>
  );
}
