import { ImageResponse } from "next/og";

export const alt = "Atomivid — Videos verticales con IA";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          background:
            "radial-gradient(60% 90% at 50% 30%, rgba(124,106,239,0.28), transparent 70%), #08080c",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <svg width="88" height="88" viewBox="0 0 24 24" fill="none">
            <g stroke="#7c6aef" strokeWidth="1.6" strokeLinecap="round">
              <ellipse cx="12" cy="12" rx="10" ry="4.1" />
              <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
              <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
            </g>
            <circle cx="12" cy="12" r="2.8" fill="#7c6aef" />
          </svg>
          <span style={{ fontSize: 84, fontWeight: 700, color: "#f5f5f7" }}>Atomivid</span>
        </div>
        <span style={{ fontSize: 34, color: "#a3a3b0" }}>Videos verticales con IA</span>
      </div>
    ),
    { ...size },
  );
}
