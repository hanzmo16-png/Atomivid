#!/usr/bin/env python3
"""SOLO PRUEBA (scripts/podcast-e2e-local.ts): envuelve el editor REAL para inyectar un fallo concreto y después le
delega la llamada sin cambiarla.
  PODCAST_E2E_FAULT=tamper  -> en `validate`, altera el audio de entrada/ (un byte más) ANTES de validar: medio alterado.
  PODCAST_E2E_FAULT=kill    -> en `run`, termina con 137 sin renderizar: interrupción del render (SIGKILL simulado).
Uso: editor-fault.py <validate|run> <montaje.json> [args...]   (PODCAST_E2E_EDITOR = ruta del editor real)"""
import os, sys
fault, real = os.environ.get("PODCAST_E2E_FAULT", ""), os.environ["PODCAST_E2E_EDITOR"]
sub, manifest = sys.argv[1], sys.argv[2]
if fault == "tamper" and sub == "validate":
    audio = os.path.join(os.path.dirname(manifest), "audio", "episode.m4a")
    with open(audio, "ab") as f: f.write(b"\0")
if fault == "kill" and sub == "run":
    sys.exit(137)
os.execvp(sys.executable, [sys.executable, real, *sys.argv[1:]])
