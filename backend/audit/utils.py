"""
audit/utils.py

- log_action()      — writes an AuditLog row. Backward compatible with every
                       existing call site (user, action, module, description,
                       request, status, details), plus new optional
                       target_type / target_id / changes kwargs.
- parse_user_agent() — small in-house UA parser (no extra dependency).
                       Detects browser, OS and device family.
- build_changes()    — computes a {field: {before, after}} diff between two
                       plain dicts, keeping only fields that actually changed.
- snapshot()         — grabs a plain-dict snapshot of selected fields off a
                       model instance, for use as the "before" side of a diff.
"""
import re

from accounts.identity import snapshot_fields
from core.network import get_client_ip
from .models import AuditLog


# ─────────────────────────────────────────────────────────────────────────
# User-Agent parsing (in-house — no external dependency)
# ─────────────────────────────────────────────────────────────────────────

_BROWSER_PATTERNS = [
    ('Edge',    re.compile(r'Edg(?:A|iOS)?/([\d.]+)')),
    ('Opera',   re.compile(r'(?:OPR|Opera)/([\d.]+)')),
    ('Chrome',  re.compile(r'Chrome/([\d.]+)')),
    ('Firefox', re.compile(r'Firefox/([\d.]+)')),
    ('Safari',  re.compile(r'Version/([\d.]+).*Safari')),
    ('IE',      re.compile(r'(?:MSIE |Trident.*rv:)([\d.]+)')),
]

_OS_PATTERNS = [
    ('Windows 11', re.compile(r'Windows NT 10\.0;.*Win64.*\)(?=.*Chrome/1[1-9][0-9])')),  # best-effort, falls back below
    ('Windows',    re.compile(r'Windows NT ([\d.]+)')),
    ('macOS',      re.compile(r'Mac OS X ([\d_]+)')),
    ('iOS',        re.compile(r'(?:iPhone|iPad|iPod).*OS ([\d_]+)')),
    ('Android',    re.compile(r'Android ([\d.]+)')),
    ('Linux',      re.compile(r'Linux')),
]

_WINDOWS_VERSION_MAP = {
    '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7',
}


def _detect_device(ua: str) -> str:
    ua_l = ua.lower()
    if 'ipad' in ua_l or ('android' in ua_l and 'mobile' not in ua_l):
        return 'Tablet'
    if 'mobi' in ua_l or 'iphone' in ua_l or 'android' in ua_l:
        return 'Mobile'
    return 'Desktop'


def _detect_os(ua: str) -> str:
    if 'Windows NT' in ua:
        m = re.search(r'Windows NT ([\d.]+)', ua)
        ver = _WINDOWS_VERSION_MAP.get(m.group(1), m.group(1)) if m else ''
        return f'Windows {ver}'.strip()
    if 'Mac OS X' in ua and 'iPhone' not in ua and 'iPad' not in ua:
        m = re.search(r'Mac OS X ([\d_]+)', ua)
        ver = m.group(1).replace('_', '.') if m else ''
        return f'macOS {ver}'.strip()
    if 'iPhone' in ua or 'iPad' in ua or 'iPod' in ua:
        m = re.search(r'OS ([\d_]+)', ua)
        ver = m.group(1).replace('_', '.') if m else ''
        return f'iOS {ver}'.strip()
    if 'Android' in ua:
        m = re.search(r'Android ([\d.]+)', ua)
        ver = m.group(1) if m else ''
        return f'Android {ver}'.strip()
    if 'Linux' in ua:
        return 'Linux'
    return 'Unknown'


def _detect_browser(ua: str) -> str:
    for name, pattern in _BROWSER_PATTERNS:
        m = pattern.search(ua)
        if m:
            try:
                version = m.group(1)
            except IndexError:
                version = ''
            major = version.split('.')[0] if version else ''
            return f'{name} {major}'.strip()
    return 'Unknown'


def parse_user_agent(ua: str | None) -> dict:
    """Returns {'device': ..., 'os': ..., 'browser': ...} from a raw
    User-Agent header. Never raises — unrecognized strings degrade to
    'Unknown' rather than throwing."""
    if not ua:
        return {'device': '', 'os': '', 'browser': ''}
    try:
        return {
            'device':  _detect_device(ua),
            'os':      _detect_os(ua),
            'browser': _detect_browser(ua),
        }
    except Exception:
        return {'device': 'Unknown', 'os': 'Unknown', 'browser': 'Unknown'}


# ─────────────────────────────────────────────────────────────────────────
# Before / after diffing
# ─────────────────────────────────────────────────────────────────────────

def snapshot(instance, fields):
    """Plain-dict snapshot of `fields` off a model instance — use as the
    'before' side of build_changes(). Missing/unreadable fields are skipped."""
    out = {}
    for f in fields:
        try:
            out[f] = getattr(instance, f)
        except Exception:
            continue
    return out


def _normalize(value):
    """Make a value JSON-safe and comparable (Decimal/date/model -> str)."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def build_changes(before: dict, after: dict, fields=None):
    """Diffs two plain dicts field-by-field, returning only what changed:
        {'status': {'before': 'pending', 'after': 'processing'}, ...}
    Returns None if nothing changed (so callers can skip attaching an
    empty `changes` blob)."""
    keys = fields if fields is not None else set(before) | set(after)
    diff = {}
    for key in keys:
        b = _normalize(before.get(key))
        a = _normalize(after.get(key))
        if b != a:
            diff[key] = {'before': b, 'after': a}
    return diff or None


# ─────────────────────────────────────────────────────────────────────────
# Core logger
# ─────────────────────────────────────────────────────────────────────────

def log_action(
    user, action, module, description,
    request=None, status='SUCCESS', details=None,
    target_type=None, target_id=None, changes=None,
):
    ip_address = None
    ua_string = ''
    if request:
        # Validated + proxy-aware (core.network): never raises, never stores a non-IP.
        ip_address = get_client_ip(request)
        ua_string = request.META.get('HTTP_USER_AGENT', '') or ''

    client = parse_user_agent(ua_string)

    AuditLog.objects.create(
        user        = user,
        action      = action,
        module      = module,
        description = description,
        ip_address  = ip_address,
        status      = status,
        details     = details,
        target_type = target_type or '',
        target_id   = str(target_id) if target_id not in (None, '') else '',
        changes     = changes,
        user_agent  = ua_string,
        device      = client['device'],
        os          = client['os'],
        browser     = client['browser'],
        # Event-time actor identity (Role Evolution, Phase 2). Taken from the
        # server-side user object at the moment the row is written — callers
        # cannot supply it. user=None yields source='unknown' (no actor is
        # fabricated).
        **snapshot_fields(user, 'actor'),
    )