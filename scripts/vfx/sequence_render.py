"""Trusted local runner. Called only after the durable worker's scoped review gates.
Usage: sequence_render.py manifest.json output-directory
"""
import hashlib, json, os, subprocess, sys
import numpy as np
from sequence_pixels import composite, validate_motion


def fingerprint(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    c = json.load(open(sys.argv[1]))
    outdir = sys.argv[2]
    for name in ('source', 'plate', 'matte', 'room', 'look'):
        if fingerprint(c[name]['path']) != c[name]['sha256']:
            raise ValueError('VFX_INPUT_CHANGED:'+name)
    w, h, fps = c['width'], c['height'], c['fps']
    n = c['endFrame']-c['startFrame']
    if not 0 <= c['startFrame'] < c['endFrame'] or n < 2:
        raise ValueError('VFX_INTERVAL_INVALID')
    matte = np.load(c['matte']['path'], mmap_mode='r', allow_pickle=False)
    room = np.load(c['room']['path'], allow_pickle=False)
    with np.load(c['look']['path'], allow_pickle=False) as look:
        gain, bias = look['gain'], look['bias']
    if matte.shape != (c['frames'], h, w) or matte.dtype != np.uint8:
        raise ValueError('VFX_MATTE_SOURCE_ALIGNMENT')
    if any(x.shape != (h,w,3) for x in (room,gain,bias)):
        raise ValueError('VFX_FROZEN_LOOK_FORMAT')
    motion_mode = c.get('plateMotion',{}).get('mode','moving')
    if motion_mode == 'fixed_lunar_flag':
        if c['environmentId'] != 'moon' or c['worldKind'] != 'moon' or c['lighting'] != 'sun_hard':
            raise ValueError('VFX_FIXED_FLAG_LUNAR_ONLY')
        approval_file = c['plateMotion']['authorization']
        if fingerprint(approval_file['path']) != approval_file['sha256']:
            raise ValueError('VFX_FIXED_FLAG_APPROVAL_CHANGED')
        approval = json.load(open(approval_file['path']))
        if approval.get('approved') is not True or approval.get('stage') != 'fixed-background-direction' or approval.get('environmentId') != 'moon' or approval.get('materialSha256') != c['plate']['sha256'] or approval.get('sourceSha256') != c['source']['sha256']:
            raise ValueError('VFX_FIXED_FLAG_APPROVAL_CHANGED')
    def decode(path, start):
        return subprocess.Popen(['ffmpeg','-v','error','-i',path,'-vf',
            f'trim=start_frame={start}:end_frame={start+n},setpts=PTS-STARTPTS',
            '-pix_fmt','rgb24','-f','rawvideo','-'], stdout=subprocess.PIPE)
    source = decode(c['source']['path'], c['startFrame'])
    plate = decode(c['plate']['path'], c['plateStartFrame'])
    output = os.path.join(outdir,'composite.partial.mp4')
    encoder = subprocess.Popen(['ffmpeg','-v','error','-n','-f','rawvideo','-pix_fmt','rgb24',
        '-s',f'{w}x{h}','-r',str(fps),'-i','-','-an','-c:v','libx264','-crf','14',
        '-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709',
        '-colorspace','bt709','-movflags','+faststart',output], stdin=subprocess.PIPE)
    motion, source_motion, lock, interior, previous, previous_source = [], [], 0, 0, None, None
    try:
        for i in range(n):
            def frame(proc):
                raw = proc.stdout.read(w*h*3)
                if len(raw) != w*h*3:
                    raise ValueError('VFX_MEDIA_SHORT_OR_FORMAT')
                return np.frombuffer(raw,np.uint8).reshape(h,w,3).astype(np.float32)/255
            s, p = frame(source), frame(plate)
            a = matte[c['startFrame']+i].astype(np.float32)/255
            result = composite(s,p,a,room,gain,bias)
            o8 = np.rint(result*255).astype(np.uint8)
            mask = a == 1
            if mask.any():
                ref = np.rint(np.clip(s*gain+bias,0,1)*255).astype(np.uint8)
                lock = max(lock,int(np.abs(o8[mask].astype(np.int16)-ref[mask].astype(np.int16)).max()))
                interior += int(mask.sum())
            if previous is not None:
                motion.append(float(np.abs(p-previous).mean()*255))
                if mask.any():
                    source_motion.append(float(np.abs(s-previous_source)[mask].mean()*255))
            previous = p
            previous_source = s
            encoder.stdin.write(o8.tobytes())
        encoder.stdin.close()
        if encoder.wait() or source.wait() or plate.wait():
            raise ValueError('VFX_CODEC_FAILED')
        mean_motion = float(np.mean(motion))
        mean_source_motion = float(np.mean(source_motion)) if source_motion else 0
        validate_motion(mean_motion, mean_source_motion, motion_mode)
        if interior == 0 or lock != 0:
            raise ValueError('VFX_PIXEL_QA_FAILED')
        os.rename(output, os.path.join(outdir,'composite.mp4'))
        report = dict(frames=n, subjectInteriorPixels=interior, subjectMaxDifference=lock,
                      plateMotionMeanAbsFrameDiff=mean_motion, grainPasses=0,
                      plateMotionMode=motion_mode,sourceMotionMeanAbsFrameDiff=mean_source_motion,
                      transition='cut', environmentId=c['environmentId'])
        json.dump(report,open(os.path.join(outdir,'report.json'),'w'),indent=2)
    finally:
        for proc in (source,plate,encoder):
            if proc.poll() is None:
                proc.kill()
            proc.wait()


if __name__ == '__main__':
    main()
