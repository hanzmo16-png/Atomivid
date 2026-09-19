import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#08080c",
          borderRadius: 8,
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
          <g stroke="#7c6aef" strokeWidth="1.6" strokeLinecap="round">
            <ellipse cx="12" cy="12" rx="10" ry="4.1" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)" />
          </g>
          <circle cx="12" cy="12" r="2.8" fill="#7c6aef" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
