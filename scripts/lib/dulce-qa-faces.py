"""L1 local QA helper: frontal+profile face counts at 2 fps (OpenCV Haar). Prints {"counts": [...]}.
Cheap signal for duplicated / appearing people; flags only, never approves or rejects on its own."""
import json, sys
import cv2

cap = cv2.VideoCapture(sys.argv[1])
fps = cap.get(cv2.CAP_PROP_FPS) or 24
step = max(1, int(round(fps / 2)))
front = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
prof = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
counts, i = [], 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    if i % step == 0:
        g = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        n = len(front.detectMultiScale(g, 1.15, 6, minSize=(60, 60))) + len(prof.detectMultiScale(g, 1.15, 6, minSize=(60, 60)))
        counts.append(int(n))
    i += 1
print(json.dumps({"counts": counts}))
