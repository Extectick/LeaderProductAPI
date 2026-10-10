"""Local GlitchTip compatibility patch; upstream remains pinned and unmodified on disk."""
from pathlib import Path
from symbolic import SourceMapCache

# Prove the installed symbolic binding expects one-based line AND column.
cache = SourceMapCache.from_bytes(b'ab', b'{"version":3,"sources":["a.js"],"sourcesContent":["first\\nsecond"],"names":[],"mappings":"AAAA,CACA"}')
assert cache.lookup(1, 1, 0).line == 1
assert cache.lookup(1, 2, 0).line == 2
path = Path('/code/apps/event_ingest/javascript_event_processor.py')
source = path.read_text()
old = '            frame.colno - 1,\n'
assert source.count(old) == 1, 'Review symbolic compatibility before upgrading GlitchTip'
path.write_text(source.replace(old, '            frame.colno,  # symbolic SourceMapCache uses one-based columns\n'))
print('Verified and applied GlitchTip 6.2.6 symbolic column compatibility fix')
