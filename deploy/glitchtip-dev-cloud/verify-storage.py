"""Run with manage.py shell in the isolated dev diagnostic container."""
import uuid
import urllib.parse
import urllib.request
import urllib.error
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

assert default_storage.location == 'dev/diagnostics/storage'
name = default_storage.save('checks/' + str(uuid.uuid4()) + '.txt', ContentFile(b'private-dev-diagnostics-check'))
try:
    assert default_storage.open(name).read() == b'private-dev-diagnostics-check'
    url = default_storage.url(name)
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query)
    assert 'X-Amz-Signature' in query or 'Signature' in query, 'Signed storage URL required'
    unsigned = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))
    try:
        urllib.request.urlopen(unsigned, timeout=15)
        raise RuntimeError('Diagnostic object is publicly readable')
    except urllib.error.HTTPError as error:
        assert error.code in (401, 403), 'Expected denied anonymous access'
    print('Private dev S3 diagnostic storage: write/read and signed access passed')
finally:
    default_storage.delete(name)  # Exact disposable probe, not a user artifact.
