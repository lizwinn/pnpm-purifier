# SPDX-License-Identifier: MIT
"""Pin native repository sources and retain their Nix outputs for pnpm."""
import json
from pathlib import Path
import sys
sys.path.insert(0, sys.argv[1])
import project_inputs
_, _, lockfile, state, references, refresh = sys.argv
file, state = Path(lockfile), Path(state)
previous = json.loads(file.read_text()).get('projectInputs', []) if file.exists() else []
requested = json.loads(references)
if requested is None:
    requested = [item['reference'] for item in previous]
pins = project_inputs.pin(requested, previous, refresh == 'true')
state.mkdir(parents=True, exist_ok=True)
views = project_inputs.npm_views(pins, state/'input-roots')
(state/'input-views.json').write_text(json.dumps(views, default=str))
print(json.dumps(pins))
