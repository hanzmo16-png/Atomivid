import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

export type OceanModel = "sonar" | "satellite" | "grid" | "rift";

/** Explanatory animation, explicitly schematic: no invented survey measurements. */
export function OceanScientificDiagram({ model, title }: { model: OceanModel; title: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <OceanScientificFrame model={model} title={title} timeSeconds={frame / fps} />;
}

export function OceanScientificFrame({ model, title, timeSeconds: t }: { model: OceanModel; title: string; timeSeconds: number }) {
  const pulse = (t % 2.4) / 2.4;
  const x = 900 + Math.sin(t * .3) * 130;
  const floor = (v: number) => 685 - 65 * Math.sin(v / 270) - 95 * Math.exp(-(((v - 1200) / 210) ** 2));
  const points = Array.from({ length: 81 }, (_, i) => [160 + i * 20, floor(160 + i * 20)]);
  const floorPath = "M " + points.map(p => p.join(",")).join(" L ") + " L1760,860 L160,860 Z";
  const text = { fill: "#d5e8ee", fontFamily: "Arial, sans-serif", fontSize: 36 };
  return <AbsoluteFill style={{ background: "#061725" }}>
    <svg viewBox="0 0 1920 1080" width="100%" height="100%">
      <defs><linearGradient id="ocean-science-water" x2="0" y2="1"><stop stopColor="#143b53"/><stop offset="1" stopColor="#061725"/></linearGradient></defs>
      <rect width="1920" height="1080" fill="url(#ocean-science-water)"/>
      <text x="960" y="135" textAnchor="middle" fill="#f4f8fa" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="54">{title}</text>
      <text x="960" y="190" textAnchor="middle" fill="#83a8bc" fontFamily="Arial, sans-serif" fontSize="25">SCHEMATIC · NOT TO SCALE</text>
      {model === "sonar" && <>
        <path d={floorPath} fill="#234d5b" stroke="#4a8390" strokeWidth="4"/>
        <line x1="160" y1="330" x2="1760" y2="330" stroke="#74bace" strokeWidth="3"/>
        <g transform={`translate(${x},295)`}><path d="M-100,0 L100,0 L65,40 L-60,40 Z" fill="#d3e3e8"/><rect x="-55" y="-35" width="75" height="35" fill="#c1d4dd"/><line x1="-15" y1="-35" x2="-15" y2="-95" stroke="#c1d4dd" strokeWidth="6"/></g>
        {Array.from({length: 9}, (_, i) => { const end = x - 330 + i * 82.5; const y = floor(end); const q = pulse < .5 ? pulse * 2 : (1 - pulse) * 2; return <g key={i}><line x1={x} y1="337" x2={end} y2={y} stroke="#66e4dd" strokeWidth="2" opacity=".28"/><circle cx={x + (end - x) * q} cy={337 + (y - 337) * q} r="7" fill={pulse < .5 ? "#6ff2e0" : "#f3cf78"}/></g>; })}
        <text x="215" y="435" {...text}>Sound pulses</text><text x="1360" y="460" {...text}>Returning echoes</text><text x="960" y="805" textAnchor="middle" {...text}>Travel time becomes a depth measurement</text>
      </>}
      {model === "satellite" && <>
        <path d={floorPath} fill="#234d5b" stroke="#4a8390" strokeWidth="4"/>
        <path d="M160,445 C650,445 870,445 1010,433 C1140,417 1190,409 1270,425 C1390,444 1510,445 1760,445" fill="none" stroke="#6ff2e0" strokeWidth="5"/>
        <g transform={`translate(${x},290)`}><rect x="-25" y="-20" width="50" height="40" rx="5" fill="#efcc76"/><rect x="-130" y="-30" width="92" height="60" fill="#3e8aaf" stroke="#8cc4df" strokeWidth="3"/><rect x="38" y="-30" width="92" height="60" fill="#3e8aaf" stroke="#8cc4df" strokeWidth="3"/></g>
        <line x1={x} y1="316" x2={x} y2="432" stroke="#efcc76" strokeWidth="3" strokeDasharray="10 10" strokeDashoffset={-t*45}/>
        <text x="200" y="400" {...text}>Sea-surface height</text><text x="1160" y="370" {...text}>Tiny gravity-related bumps</text><text x="960" y="805" textAnchor="middle" {...text}>An indirect estimate of broad seafloor features</text>
      </>}
      {model === "grid" && <>
        {Array.from({length: 48}, (_, i) => {const col=i%12,row=Math.floor(i/12),revealed=i<Math.min(48,Math.floor(t*9)+1);return <g key={i}><rect x={210+col*125} y={280+row*115} width="120" height="110" rx="4" fill={revealed ? "#287987" : "#0e2d40"} stroke="#4e7687" strokeWidth="2"/>{revealed&&<circle cx={270+col*125} cy={330+row*115} r="8" fill="#f0ce7b"/>}</g>;})}
        <text x="960" y="805" textAnchor="middle" {...text}>A measured depth inside a defined grid cell</text>
      </>}
      {model === "rift" && <>
        <path d="M160,725 C340,720 470,650 590,580 L750,460 L865,495 L915,535 L960,580 L1005,535 L1060,495 L1170,460 L1340,590 C1490,665 1640,720 1760,725 L1760,860 L160,860 Z" fill="#234d5b" stroke="#62b0bb" strokeWidth="5"/>
        <path d="M800,685 L620,685 M620,685 L650,665 M620,685 L650,705 M1120,685 L1300,685 M1300,685 L1270,665 M1300,685 L1270,705" fill="none" stroke="#efcc76" strokeWidth="6" transform={`translate(${Math.sin(t)*8},0)`}/>
        <line x1="960" y1="330" x2="960" y2="515" stroke="#efcc76" strokeWidth="3" strokeDasharray="10 8" strokeDashoffset={-t*20}/>
        <text x="960" y="300" textAnchor="middle" {...text}>Rift valley</text><text x="960" y="805" textAnchor="middle" {...text}>A valley along the crest of the Mid-Atlantic Ridge</text>
      </>}
    </svg>
  </AbsoluteFill>;
}
