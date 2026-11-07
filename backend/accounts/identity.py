"""
Event-time identity snapshots (Role Evolution — Phase 1).

CustomUser.id is the stable identity of a PERSON. Role, id_number and
full_name may change over that person's career (Enforcer -> Staff -> Admin).
Historical records therefore keep BOTH:

    stable FK            "who is this person now?"
    event-time snapshot  "who were they when this happened?"

This module is the single authoritative place that decides what an
event-time snapshot looks like. Models only declare the columns; callers
obtain the values from here, always from the SERVER-SIDE user object
(request.user / a database row) — never from client-supplied data.

Phase 1 provides the schema and this helper. Wiring it into the actual
create/update paths is deliberately a later phase.
"""
from django.db import models


class SnapshotSource(models.TextChoices):
    """How trustworthy an identity snapshot is (provenance)."""
    EVENT   = 'event',   'Captured at event time'
    DERIVED = 'derived', 'Reconstructed from reliable system evidence'
    ASSUMED = 'assumed', 'Best-effort legacy inference'
    UNKNOWN = 'unknown', 'Cannot be determined'


def normalize_role(role):
    """Return `role` as a valid CustomUser.Role value, or None.

    Anything that is not exactly one of the project's role values (after
    trimming/lower-casing) is treated as unknown rather than guessed.
    """
    from .models import CustomUser   # local import: models imports this module's siblings

    if role is None:
        return None
    value = str(role).strip().lower()
    return value if value in CustomUser.Role.values else None


def capture_identity(user):
    """Event-time identity of `user`, taken from the server-side account.

    Returns a plain dict:

        {
          'user_id':      stable CustomUser pk (the person),
          'name':         full_name right now,
          'role':         normalized role right now (or None),
          'id_number':    id_number right now,
          'badge_number': badge_number right now (Enforcer attribution),
          'source':       SnapshotSource.EVENT, or UNKNOWN when there is
                          no account to capture (None / unsaved / anonymous),
        }

    Call it at the moment the event happens, with the authenticated user
    object. It deliberately accepts no request and no free-form values:
    client-supplied identity is never trusted.
    """
    if user is None or getattr(user, 'pk', None) is None:
        return {
            'user_id': None, 'name': None, 'role': None,
            'id_number': None, 'badge_number': None,
            'source': SnapshotSource.UNKNOWN,
        }
    return {
        'user_id':      user.pk,
        'name':         (getattr(user, 'full_name', '') or '').strip() or None,
        'role':         normalize_role(getattr(user, 'role', None)),
        'id_number':    getattr(user, 'id_number', None) or None,
        'badge_number': (getattr(user, 'badge_number', '') or '').strip() or None,
        'source':       SnapshotSource.EVENT,
    }


def snapshot_fields(user, prefix, *, badge=False):
    """capture_identity(user) shaped as model kwargs for `prefix`.

        AuditLog.objects.create(..., **snapshot_fields(request.user, 'actor'))

    yields <prefix>_name_snapshot, <prefix>_role_snapshot,
    <prefix>_id_number_snapshot, <prefix>_snapshot_source and, with
    badge=True, <prefix>_badge_snapshot.
    """
    ident = capture_identity(user)
    out = {
        f'{prefix}_name_snapshot':      ident['name'],
        f'{prefix}_role_snapshot':      ident['role'],
        f'{prefix}_id_number_snapshot': ident['id_number'],
        f'{prefix}_snapshot_source':    ident['source'],
    }
    if badge:
        out[f'{prefix}_badge_snapshot'] = ident['badge_number']
    return out

# ─────────────────────────────────────────────────────────────────────────
# Phase 3 — READ side.  Turn stored snapshots back into display identity.
#
# Rules (the same everywhere, so every screen / export agrees):
#   event / derived  -> show the stored snapshot values as-is.
#   assumed          -> NOT shown as fact.  Treated like "no trustworthy
#                       snapshot": name may fall back (labelled unverified);
#                       role / id_number / badge are never shown.
#   unknown          -> same as assumed.
#   Live fallback    -> NAME ONLY, and only when no trustworthy snapshot name
#                       exists, always certainty='unverified'.  Role, ID number
#                       and badge are NEVER read from the live account.
# ─────────────────────────────────────────────────────────────────────────
TRUSTED_SOURCES = (SnapshotSource.EVENT, SnapshotSource.DERIVED)


def resolve_historical_identity(*, name=None, role=None, id_number=None,
                                badge=None, source=None, live_user=None):
    """Display identity for one historical event.

    Returns {name, role, id_number, badge, certainty, historical} where
      certainty  'event' | 'derived' | 'unverified' | 'unknown'
      historical True  -> values come from the stored snapshot
                 False -> not provable (name, if any, is a live fallback)
    """
    src = source if source in SnapshotSource.values else SnapshotSource.UNKNOWN
    if src in TRUSTED_SOURCES:
        return {
            'name': (name or '').strip() or None,
            'role': normalize_role(role),
            'id_number': id_number or None,
            'badge': (badge or '').strip() or None,
            'certainty': str(src),
            'historical': True,
        }
    live_name = (getattr(live_user, 'full_name', '') or '').strip() if live_user is not None else ''
    if live_name:
        return {'name': live_name, 'role': None, 'id_number': None, 'badge': None,
                'certainty': 'unverified', 'historical': False}
    return {'name': None, 'role': None, 'id_number': None, 'badge': None,
            'certainty': 'unknown', 'historical': False}


def _resolve(obj, prefix, live_attr, *, badge=False):
    return resolve_historical_identity(
        name=getattr(obj, f'{prefix}_name_snapshot', None),
        role=getattr(obj, f'{prefix}_role_snapshot', None),
        id_number=getattr(obj, f'{prefix}_id_number_snapshot', None),
        badge=getattr(obj, f'{prefix}_badge_snapshot', None) if badge else None,
        source=getattr(obj, f'{prefix}_snapshot_source', None),
        live_user=getattr(obj, live_attr, None),
    )


def audit_actor_identity(log):
    ident = _resolve(log, 'actor', 'user')
    if log.user_id is None and not ident['historical']:
        ident['certainty'] = 'unknown'
    return ident


def notification_actor_identity(notif):
    return _resolve(notif, 'actor', 'related_user')


def enforcer_identity(violation):
    return _resolve(violation, 'enforcer', 'enforcer', badge=True)


def assessor_identity(assessment):
    """Assessor ONLY.  A legacy row whose assessor snapshot is not
    trustworthy returns no live name: Assessment.assessed_by was overwritten by
    payment confirmation in old code, so the FK does not prove who assessed."""
    ident = _resolve(assessment, 'assessor', 'assessed_by')
    if not ident['historical']:
        return {'name': None, 'role': None, 'id_number': None, 'badge': None,
                'certainty': 'unknown', 'historical': False}
    return ident


def payment_confirmer_identity(assessment):
    return _resolve(assessment, 'payment_confirmer', 'payment_confirmed_by')


def latest_enforcer_snapshots(user_ids=None):
    """{stable user id: {'name': ..., 'badge': ...}} from EVENT-TIME snapshots.

    One entry per person: the name (and, separately, the badge) on that
    person's most recent filed violation carrying a trusted snapshot (latest
    by date_issued, then id).  Badge is SNAPSHOT-ONLY: the live account badge
    is never used, so a person with no trustworthy badge snapshot gets
    badge=''.  People with no trusted name snapshot are absent (the caller
    falls back to the live NAME only, labelled unverified).
    """
    from violations.models import Violation
    qs = (Violation.objects
          .filter(enforcer__isnull=False,
                  enforcer_snapshot_source__in=[str(s) for s in TRUSTED_SOURCES])
          .order_by('date_issued', 'id')            # oldest -> newest: last wins
          .values_list('enforcer_id', 'enforcer_name_snapshot', 'enforcer_badge_snapshot'))
    if user_ids is not None:
        qs = qs.filter(enforcer_id__in=list(user_ids))
    out = {}
    for uid, name, badge in qs:
        e = out.setdefault(uid, {'name': None, 'badge': ''})
        if (name or '').strip():
            e['name'] = name.strip()
        if (badge or '').strip():
            e['badge'] = badge.strip()
    return {uid: e for uid, e in out.items() if e['name']}


def latest_enforcer_labels(user_ids=None):
    """{stable user id: latest event-time enforcer name} (see above)."""
    return {uid: e['name'] for uid, e in latest_enforcer_snapshots(user_ids).items()}


def grouped_enforcer_identity(user_id, live_name, snaps):
    """Display identity for one GROUPED row (dashboard / analytics / report).

    Name: latest event-time snapshot name; else live name (unverified).
    Badge: latest snapshot badge only, '' when none.  Never the live badge.
    """
    snap = snaps.get(user_id)
    if snap:
        return {'name': snap['name'], 'badge': snap['badge'], 'historical': True}
    return {'name': (live_name or '').strip() or None, 'badge': '', 'historical': False}