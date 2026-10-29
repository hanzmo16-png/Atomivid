#!/usr/bin/env bash
# Dependencias Python del estudio (recorte RVM + verificación visual CLIP), fijadas. Requiere Python 3.12 (setup-python en
# el workflow): con 3.14 (imagen ubuntu-26.04 de «ubuntu-latest», 2026-10-29) no hay ruedas de pillow/numpy/torch fijados
# y pip intenta compilar pillow sin libjpeg → falla antes de producir (episodio ec30c594). Solo ruedas binarias: si una
# versión no tiene rueda para este Python, falla aquí con un mensaje claro en vez de compilar.
set -euo pipefail
python3 -c 'import sys; assert sys.version_info[:2] == (3, 12), f"Python {sys.version.split()[0]}: el estudio requiere 3.12"'
PIP="python3 -m pip install -q --disable-pip-version-check --only-binary=:all:"
$PIP "onnxruntime==1.31.1" "numpy==2.2.6" "opencv-python-headless==4.10.0.84" "pillow==11.0.0"
$PIP --index-url https://download.pytorch.org/whl/cpu "torch==2.5.1"
$PIP "sentence-transformers==3.3.1"
python3 -c 'import onnxruntime, numpy, cv2, PIL, torch, sentence_transformers; print("PY_DEPS_OK", ".".join(map(str, __import__("sys").version_info[:3])), "pillow", PIL.__version__, "torch", torch.__version__)'
