"""Deterministic per-world pixels. No generated light, geometric warp or cross-world blend.
Frozen look is a measured gain/bias field, not an invented lighting preset.
"""
import numpy as np


def composite(source, plate, alpha, room, gain, bias):
    arrays = (source, plate, room, gain, bias)
    if any(x.shape != source.shape or not np.isfinite(x).all() for x in arrays):
        raise ValueError('VFX_LOOK_OR_FRAME_INVALID')
    if alpha.shape != source.shape[:2] or not np.isfinite(alpha).all():
        raise ValueError('VFX_MATTE_INVALID')
    if np.any((alpha < 0) | (alpha > 1)) or np.any(gain < 0):
        raise ValueError('VFX_LOOK_OR_MATTE_RANGE')
    a = alpha[..., None]
    foreground = np.where((a > .02) & (a < .98),
                          np.clip((source - (1-a)*room)/np.maximum(a, .05), 0, 1), source)
    graded = np.clip(foreground*gain+bias, 0, 1)
    # Solid source pixels remain exact under the frozen grade. Grain belongs to master only.
    return np.clip(graded*a+plate*(1-a), 0, 1)
