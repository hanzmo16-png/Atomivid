import hashlib,hmac,json,sqlite3,unittest
from coordinator import initialize,receive,claim

class Tests(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');initialize(self.db)
  self.db.execute("INSERT INTO tasks(task_id,owner,pr,sha,status) VALUES ('T1','claude',7,'abc','PENDING')")
  self.db.execute("UPDATE settings SET value='0' WHERE key='killed'")
 def send(self,obj,delivery='a',event='pull_request',valid=True):
  body=json.dumps(obj).encode()
  signature='sha256='+hmac.new(b'test-secret',body,hashlib.sha256).hexdigest()
  return receive(self.db,'test-secret',body,signature if valid else 'bad',delivery,event,100)
 def payload(self,sha='abc'):return {'pull_request':{'number':7,'head':{'sha':sha}}}
 def test_signature(self):self.assertEqual(self.send({},valid=False),'REJECT_SIGNATURE')
 def test_green_not_approval(self):
  self.assertEqual(self.send(self.payload()),'REVIEW_REQUIRED')
  self.assertEqual(self.db.execute('SELECT status FROM tasks').fetchone()[0],'PENDING')
 def test_duplicate(self):
  self.send(self.payload());self.assertEqual(self.send(self.payload()),'DUPLICATE')
 def test_conflicting_replay(self):
  self.send(self.payload());self.assertEqual(self.send({'x':1}),'REJECT_REPLAY_CONFLICT')
 def test_new_delivery_replay(self):
  self.send(self.payload());self.assertEqual(self.send(self.payload(),delivery='b'),'REJECT_REPLAY_NEW_DELIVERY')
 def test_stale(self):self.assertEqual(self.send(self.payload('old')),'STALE_SHA')
 def test_ci_pass(self):
  self.assertEqual(self.send({'workflow_run':{'head_sha':'abc','conclusion':'success'}},event='workflow_run'),'CI_OBSERVED')
  self.assertEqual(self.db.execute('SELECT status FROM tasks').fetchone()[0],'PENDING')
 def test_ci_failure(self):
  self.assertEqual(self.send({'check_suite':{'head_sha':'abc','conclusion':'failure'}},event='check_suite'),'CI_OBSERVED')
 def test_terminal(self):
  self.db.execute("UPDATE tasks SET status='APPROVED'")
  self.assertEqual(self.send(self.payload()),'TERMINAL')
 def test_missing_ack(self):
  self.send(self.payload());self.assertEqual(self.db.execute('SELECT attempts FROM tasks').fetchone()[0],0)
 def test_killswitch(self):
  self.db.execute("UPDATE settings SET value='1'");self.assertEqual(self.send(self.payload()),'KILLED')
 def test_lock(self):
  self.assertFalse(claim(self.db,'T1','grok',100))
  self.assertTrue(claim(self.db,'T1','claude',100))
  self.assertFalse(claim(self.db,'T1','claude',101))
  self.assertTrue(claim(self.db,'T1','claude',401))
  self.assertTrue(claim(self.db,'T1','claude',702))
  self.assertFalse(claim(self.db,'T1','claude',1003))
 def test_dispatch(self):
  self.assertEqual(self.send({'action':'completed','repository_dispatch':{'pr':7,'sha':'abc'}},event='repository_dispatch'),'REVIEW_REQUIRED')

if __name__=='__main__':unittest.main(verbosity=2)
