#!/usr/bin/env python3
"""
Evidence for a Director-driven Reel render (local, no network). Reads the director.json stored next to the MP4
(input, plan, props, per-shot planned vs applied) and the MP4 itself, and writes:
  - tabla-por-plano.md / .csv: phrase, recipe, resource, duration, framing, movement, transitions (planned vs applied)
  - frames/shot-NN-{start,mid,end}.png and contact-sheet.png (one row per shot)
  - segments/shot-NN.mp4: the full segment of each shot (movement is judged on whole segments, not stills)
  - medidas.json: objective checks on the picture area only (caption band and label badge excluded):
      * motion: SSIM between the shot's first and last frame (static ~1.0; zoom/pan/clip lower)
      * boundary: luma/SSIM around each cut to tell a cut (abrupt) from a fade (dip to dark) or a crossfade
Usage: python3 -I scripts/director-reel-evidence.py <director.json> <final.mp4> <outdir>
"""
import csv, json, os, re, subprocess, sys

FPS = 30
CROP = "crop=1080:900:0:180"  # picture area: below the label badge (top) and above the caption band (bottom)


def sh(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def frame(mp4, t, out):
    sh("ffmpeg", "-v", "error", "-y", "-ss", f"{max(0, t):.3f}", "-i", mp4, "-frames:v", "1", out)


def ssim(mp4, t1, t2):
    """SSIM of the picture area between two timestamps."""
    r = subprocess.run(["ffmpeg", "-v", "info", "-ss", f"{max(0, t1):.3f}", "-i", mp4, "-ss", f"{max(0, t2):.3f}", "-i", mp4,
                        "-filter_complex", f"[0:v]{CROP},trim=end_frame=1[a];[1:v]{CROP},trim=end_frame=1[b];[a][b]ssim", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"All:([0-9.]+)", r.stderr)
    return float(m.group(1)) if m else None


def luma(mp4, t):
    r = subprocess.run(["ffmpeg", "-v", "info", "-ss", f"{max(0, t):.3f}", "-i", mp4, "-frames:v", "1", "-vf", f"{CROP},signalstats,metadata=print",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"lavfi.signalstats.YAVG=([0-9.]+)", r.stderr)
    return float(m.group(1)) if m else None


def main():
    dj, mp4, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    os.makedirs(os.path.join(out, "segments"), exist_ok=True)
    d = json.load(open(dj))
    if not d.get("ok"):
        json.dump({"ok": False, "blockers": d.get("blockers")}, open(os.path.join(out, "medidas.json"), "w"), ensure_ascii=False, indent=2)
        print("director.json is a blocked plan: no render to measure"); return
    scenes, applied = d["props"]["scenes"], d["applied"]
    plan = {s["id"]: s for s in d["plan"]["shots"]}
    rows, measures = [], []
    for i, (sc, a) in enumerate(zip(scenes, applied)):
        st, en = sc["startSeconds"], sc["endSeconds"]
        s = plan.get(a["shotId"], {})
        for tag, t in (("start", st + 0.12), ("mid", (st + en) / 2), ("end", en - 0.12)):
            frame(mp4, t, os.path.join(out, "frames", f"shot-{i:02d}-{tag}.png"))
        sh("ffmpeg", "-v", "error", "-y", "-ss", f"{st:.3f}", "-to", f"{en:.3f}", "-i", mp4, "-c:v", "libx264", "-crf", "23", "-an",
           os.path.join(out, "segments", f"shot-{i:02d}.mp4"))
        motion_ssim = ssim(mp4, st + 0.15, en - 0.15)
        m = {"shot": a["shotId"], "motionApplied": a["applied"]["motion"], "ssimFirstLast": motion_ssim,
             "lumaStart": luma(mp4, st + 0.02), "lumaMid": luma(mp4, (st + en) / 2), "lumaEnd": luma(mp4, en - 0.02)}
        if i + 1 < len(scenes):
            b = en
            m["boundaryOut"] = {"time": b, "planned": a["applied"]["transitionOut"], "nextIn": applied[i + 1]["applied"]["transitionIn"],
                                "ssimAcross": ssim(mp4, b - 2 / FPS, b + 2 / FPS), "lumaAtBoundary": luma(mp4, b - 1 / FPS)}
        measures.append(m)
        rows.append({
            "n": i, "plano": a["shotId"], "frase": a["anchorText"], "receta": a["recipeId"] or "(sin receta)",
            "recurso": sc["mediaUrl"].split("/")[-1].split("?")[0], "tipo": sc["mediaType"],
            "inicio_s": st, "fin_s": en, "dur_aplicada_s": round(en - st, 3),
            "dur_prevista_s": round(s.get("end", 0) - s.get("start", 0), 3) if s else None,
            "encuadre_previsto": f'{a["planned"]["shotType"]} — {a["planned"]["composition"] or ""}',
            "encuadre_aplicado": "no soportado como propiedad: el recurso se encuadra con object-fit cover 1080×1920",
            "mov_previsto": a["planned"]["movement"], "mov_aplicado": a["applied"]["motion"],
            "trans_in_prevista": a["planned"]["transitionIn"], "trans_in_aplicada": a["applied"]["transitionIn"],
            "trans_out_prevista": a["planned"]["transitionOut"], "trans_out_aplicada": a["applied"]["transitionOut"],
            "etiqueta": a["applied"]["label"] or "", "no_soportado": "; ".join(a["unsupported"]),
            "ssim_inicio_fin": motion_ssim,
        })
    # Contact sheet: one row per shot (start / mid / end)
    sheet_inputs = []
    for i in range(len(rows)):
        for tag in ("start", "mid", "end"):
            sheet_inputs += ["-i", os.path.join(out, "frames", f"shot-{i:02d}-{tag}.png")]
    n = len(rows) * 3
    sh("ffmpeg", "-v", "error", "-y", *sheet_inputs, "-filter_complex",
       "".join(f"[{k}:v]scale=240:-2[s{k}];" for k in range(n)) + "".join(f"[s{k}]" for k in range(n)) + f"xstack=inputs={n}:layout=" +
       "|".join(f"{(k % 3) * 240}_{(k // 3) * 427}" for k in range(n)), os.path.join(out, "contact-sheet.png"))
    with open(os.path.join(out, "tabla-por-plano.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    with open(os.path.join(out, "tabla-por-plano.md"), "w") as f:
        f.write("| # | Frase | Receta | Recurso | Dur. prevista→aplicada (s) | Movimiento previsto→aplicado | Entrada | Salida | Etiqueta | SSIM inicio/fin | No soportado |\n")
        f.write("|---|---|---|---|---|---|---|---|---|---|---|\n")
        for r in rows:
            f.write(f'| {r["n"]} | {r["frase"]} | {r["receta"]} | {r["recurso"]} ({r["tipo"]}) | {r["dur_prevista_s"]}→{r["dur_aplicada_s"]} '
                    f'({r["inicio_s"]}–{r["fin_s"]}) | {r["mov_previsto"]}→{r["mov_aplicado"]} | {r["trans_in_prevista"]}→{r["trans_in_aplicada"]} | '
                    f'{r["trans_out_prevista"]}→{r["trans_out_aplicada"]} | {r["etiqueta"]} | {r["ssim_inicio_fin"]} | {r["no_soportado"]} |\n')
    json.dump(measures, open(os.path.join(out, "medidas.json"), "w"), ensure_ascii=False, indent=2)
    print(f"{len(rows)} shots → {out}")


if __name__ == "__main__":
    main()
