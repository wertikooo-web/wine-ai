import json
from pathlib import Path
m=json.loads(Path("03_rive/rive_manifest.json").read_text())
assert m["stateMachine"]["name"]=="SommelierSM"
assert "idle" in m["requiredAnimations"]
assert "speaking" in m["requiredAnimations"]
print("Manifest OK")
