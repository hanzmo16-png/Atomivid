"""Offline-only event classifier. No model calls, agent dispatch, or production writes."""
import hashlib, hmac, json, sqlite3, time

def initialize(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS events(delivery TEXT PRIMARY KEY,digest TEXT NOT NULL UNIQUE,received INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,owner TEXT NOT NULL,pr INTEGER NOT NULL,sha TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,authorization_scope TEXT NOT NULL DEFAULT 'none',lease_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,delivery TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('killed','1');
    """)

def receive(db,secret,body,signature,delivery,event,now=None):
    now=int(time.time()) if now is None else now
    expected="sha256="+hmac.new(secret.encode(),body,hashlib.sha256).hexdigest()
    if not signature or not hmac.compare_digest(signature,expected): return "REJECT_SIGNATURE"
    if not delivery or len(delivery)>150: return "REJECT_DELIVERY"
    try: data=json.loads(body)
    except (ValueError,UnicodeError): return "REJECT_JSON"
    if not isinstance(data,dict): return "REJECT_JSON"
    digest=hashlib.sha256(body).hexdigest()
    with db:
        existing=db.execute("SELECT digest FROM events WHERE delivery=?",(delivery,)).fetchone()
        if existing: return "DUPLICATE" if existing[0]==digest else "REJECT_REPLAY_CONFLICT"
        if db.execute("SELECT 1 FROM events WHERE digest=?",(digest,)).fetchone(): return "REJECT_REPLAY_NEW_DELIVERY"
        db.execute("INSERT INTO events VALUES(?,?,?)",(delivery,digest,now))
        def audit(action,detail=""):
            db.execute("INSERT INTO audit(delivery,action,detail) VALUES(?,?,?)",(delivery,action,detail))
        if db.execute("SELECT value FROM settings WHERE key='killed'").fetchone()[0]=="1":
            audit("KILLED",event);return "KILLED"
        if event not in ("pull_request","check_suite","workflow_run","repository_dispatch"):
            audit("IGNORED",event);return "IGNORED"
        if event=="pull_request":
            pr=data.get("pull_request",{}).get("number")
            sha=data.get("pull_request",{}).get("head",{}).get("sha")
        elif event=="repository_dispatch":
            if data.get("action") not in ("delivered","completed"):
                audit("IGNORED_ACTION");return "IGNORED"
            pr=data.get("repository_dispatch",{}).get("pr")
            sha=data.get("repository_dispatch",{}).get("sha")
        else:
            sha=data.get("check_suite",{}).get("head_sha") if event=="check_suite" else data.get("workflow_run",{}).get("head_sha")
            audit("CI_OBSERVED",str(sha)[:12]);return "CI_OBSERVED"
        row=db.execute("SELECT task_id,sha,status FROM tasks WHERE pr=?",(pr,)).fetchone()
        if not row: audit("UNMAPPED",str(pr));return "UNMAPPED"
        if sha!=row[1]: audit("STALE_SHA",str(pr));return "STALE_SHA"
        if row[2] in ("APPROVED","BLOCKED"):
            audit("TERMINAL",str(pr));return "TERMINAL"
        audit("REVIEW_REQUIRED",row[0])
        return "REVIEW_REQUIRED"

def claim(db,task_id,owner,now):
    """Requires an explicit caller action, never triggered by a webhook."""
    with db:
        row=db.execute("SELECT owner,status,lease_until FROM tasks WHERE task_id=?",(task_id,)).fetchone()
        if not row or row[0]!=owner or row[1] not in ("PENDING","RUNNING"):return False
        if row[1]=="RUNNING" and row[2]>now:return False
        return db.execute("UPDATE tasks SET status='RUNNING',lease_until=?,attempts=attempts+1 WHERE task_id=? AND (status='PENDING' OR lease_until<=?) AND attempts<3",(now+300,task_id,now)).rowcount==1
