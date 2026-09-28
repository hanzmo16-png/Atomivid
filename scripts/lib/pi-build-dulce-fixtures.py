"""Builds Production Intelligence regression fixtures from EXISTING DULCE evidence only.
Reproducible: python3 scripts/lib/pi-build-dulce-fixtures.py
Inputs are committed files; findings from CI runs cite the run and the fixing commit."""
import json

OUT = 'src/lib/production-intelligence/fixtures/'
V1 = 'content/qa-datasets/dulce-v1-visual-labels.json'
CLIPS = 'content/long-form/dulce-part1/approved-clips.json'
SM = 'content/long-form/dulce-part1/smart-mix.json'
KEEP = {'GOOD', 'DUPLICATION', 'IDENTITY_DRIFT', 'DEFORMATION', 'EXTRA_LIMB', 'CHARACTER_APPEARANCE', 'NARRATIVE_MISMATCH'}

fx = []
for it in json.load(open(V1))['items']:
    if it['label'] not in KEEP:
        continue
    fx.append({'id': 'v1-' + it['clipId'], 'category': it['label'], 'scope': 'clip', 'severity': 'LOW' if it['label'] == 'GOOD' else 'HIGH',
               'usableUntilSeconds': it['usableUntilSeconds'], 'needSeconds': it['editSeconds'], 'humanDetected': False, 'userKept': None,
               'evidence': f"{V1}#{it['clipId']} ({it['evidence']})", 'note': it['note'], 'humanVerdict': it['verdictV1']})
for c in json.load(open(CLIPS)):
    if 'identity-drift' in (c.get('reasons') or []):
        fx.append({'id': 'p1-' + c['asset'], 'category': 'IDENTITY_DRIFT', 'scope': 'clip', 'severity': 'HIGH', 'usableUntilSeconds': None, 'needSeconds': 6.1,
                   'humanDetected': False, 'userKept': None, 'evidence': f"{CLIPS}#{c['asset']} sha {c['sha256'][:12]}", 'note': c['note']})
for a in ['N01', 'N04', 'N05', 'N26', 'N33', 'N48']:
    fx.append({'id': 'p1-unused-' + a, 'category': 'UNUSED_PAID_APPROVED_ASSET', 'scope': 'master', 'severity': 'HIGH', 'humanDetected': False, 'userKept': None,
               'evidence': f'GitHub Actions run 36483609552 qc.json: {a} clip paid (ledger video-{a}-v1) and approved in {CLIPS}, rendered as still; fixed by commit 5483fa6',
               'note': 'B+ upgrade pack never switched in the storyboard'})
for slot, src, held in [('P1-033', 'N11', 0.68), ('P1-024', 'D08-03', 0.17), ('P1-092', 'N35', 0.08)]:
    fx.append({'id': f'p1-held-{slot}', 'category': 'HELD_FRAME', 'scope': 'master', 'severity': 'MEDIUM' if held > 0.3 else 'LOW', 'heldSeconds': held,
               'humanDetected': False, 'userKept': None, 'evidence': f'GitHub Actions run 36480547152 qc.json issues: "{slot} {src}: {held} s held beyond clean window"; fixed by commit 1ff9a88', 'note': 'last frame held to fill the slot'})
for t, what in [('0:11.5', 'levels graphic notice under the subtitle'), ('0:32.5', 'name caption above the subtitle'), ('9:17.5', 'Paul Bennewitz caption above the subtitle')]:
    fx.append({'id': 'p1-overlap-' + t.replace(':', '').replace('.', ''), 'category': 'TEXT_SUBTITLE_OVERLAP', 'scope': 'master', 'severity': 'MEDIUM',
               'humanDetected': False, 'userKept': None, 'evidence': f'GitHub Actions run 36480547152 qa-every-5s sheets at {t}: {what}; fixed by commit 1ff9a88', 'note': what})
fx.append({'id': 'p1-flashlight', 'category': 'PHYSICS_INCONSISTENCY', 'scope': 'clip', 'severity': 'LOW', 'humanDetected': True, 'userKept': True,
           'evidence': 'owner review of the approved DULCE Part I master (2026-09-28); shot and timestamp not recorded', 'note': 'flashlight beam direction briefly disagrees with the character orientation; accepted by the user'})
json.dump({'dataset': 'pi-dulce-regression', 'version': 1, 'sources': [V1, CLIPS, 'GitHub runs 36480547152 and 36483609552', 'owner review'], 'fixtures': fx}, open(OUT + 'dulce-regression.json', 'w'), indent=1, ensure_ascii=False)

# Mix fixture: the 44 real candidates of the DULCE Part I Smart Mix audit, normalized to Shot Contracts.
RECURRING = {'Thomas', 'George', 'técnico'}
REQ = {'MOTION_ESSENTIAL': 'complex', 'MOTION_BENEFICIAL': 'simple', 'MOTION_UNNECESSARY': 'camera_only'}
contracts = []
for c in json.load(open(SM))['clips']:
    flags = ['identity_critical'] if RECURRING & set(c['characters']) and c['shotClass'] in ('single_human', 'multi_human', 'human_creature') else []
    contracts.append({'shotId': c['asset'], 'shotClass': c['shotClass'], 'narrationIntent': c['narrationIntent'], 'visualIntent': c['visualIntent'], 'characters': c['characters'],
                      'motionRequirement': REQ[c['classification']], 'motionLeverage': c['motionValue'], 'riskClass': c['deformationRisk'], 'riskFlags': flags,
                      'desiredDuration': round(sum(c['slotSeconds']), 2), 'maxGeneratedDuration': 10, 'qualityTier': 'hero' if c['recommendedMethod'] == 'i2v_hero' else 'economy',
                      'humanIntervention': 'human'})
sm = json.load(open(SM))['summary']
json.dump({'dataset': 'pi-dulce-mix', 'version': 1, 'source': SM, 'finishedSeconds': 582.7, 'planA': {'generativeClips': sm['planA']['generativeClips'], 'generativeSeconds': sm['planA']['generativeSeconds']},
           'shippedBPlus': {'generativeClipsApproved': 11, 'newGenerativeSeconds': 70.9}, 'contracts': contracts}, open(OUT + 'dulce-mix-contracts.json', 'w'), indent=1, ensure_ascii=False)
print(len(fx), 'regression fixtures;', len(contracts), 'mix contracts')
