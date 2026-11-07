"""
core/network.py

Single source of truth for "which IP made this request" behind Render's proxy.

Why: X-Forwarded-For is a client-controllable header. Used naively (first entry),
anyone can forge the IP written to the audit log, and a non-IP value used to
crash the audit insert (AuditLog.ip_address is a GenericIPAddressField).

Behaviour (matches DRF's NUM_PROXIES semantics used by the throttles):
  * settings.NUM_PROXIES is None  -> legacy behaviour: first X-Forwarded-For
                                     entry (but only if it is a valid IP).
  * settings.NUM_PROXIES == 0     -> ignore X-Forwarded-For, use REMOTE_ADDR.
  * settings.NUM_PROXIES == N > 0 -> the Nth entry from the RIGHT of
                                     X-Forwarded-For (the hop appended by your
                                     own trusted proxies; not client-forgeable).
Anything that is not a valid IP address falls back to REMOTE_ADDR, then None.
"""
import ipaddress

from django.conf import settings


def _valid_ip(value):
    """Return a canonical IP string, or None. Accepts what proxies really send:
    plain IPv4/IPv6, "1.2.3.4:5678" and "[2001:db8::1]:443". Rejects scoped IPv6
    ("fe80::1%eth0" is a valid Python address but PostgreSQL `inet` refuses it)."""
    if not value:
        return None
    v = value.strip()
    if v.startswith('['):
        end = v.find(']')
        if end == -1:
            return None
        v = v[1:end]
    elif v.count(':') == 1 and '.' in v:      # IPv4 with :port
        v = v.rsplit(':', 1)[0]
    if '%' in v:
        return None
    try:
        return str(ipaddress.ip_address(v))
    except ValueError:
        return None


def get_client_ip(request):
    meta = request.META
    remote = _valid_ip(meta.get('REMOTE_ADDR') or '')
    xff = meta.get('HTTP_X_FORWARDED_FOR')
    num_proxies = getattr(settings, 'NUM_PROXIES', None)
    if xff and num_proxies != 0:
        parts = [p.strip() for p in xff.split(',') if p.strip()]
        if parts:
            candidate = parts[0] if num_proxies is None else parts[-min(num_proxies, len(parts))]
            ip = _valid_ip(candidate)
            if ip:
                return ip
    return remote