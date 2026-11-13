"""
Role Evolution, Phase 5: the ONE place where an existing account changes role.

`change_user_role()` owns the whole transition atomically:

    lock the account -> validate -> allocate the new ID (Phase 1 ledger +
    advisory lock) -> append UserRoleHistory -> update role/id_number ->
    clear role-specific transient state -> blacklist refresh tokens ->
    write the audit entry

Anything that fails rolls back the entire transition, so there is never a
half-applied change, a stray ledger row, or a success audit for a change that
did not happen. Nothing else in the codebase may assign `user.role` /
`user.id_number` (the generic user-update serializers and the Django admin
already treat them as read-only on existing accounts).

Access tokens issued before the change stop working because they are bound to
the old role/id_number (see accounts.authentication); the user signs in again
with the NEW ID number.

Policy (conservative, derived from the code - no business rule was invented):

  * Only an active Administrator may change roles.
  * Supported: Staff <-> Enforcer.
  * Admin accounts are never demoted and nobody is promoted to Admin here:
    the codebase has no rule for final-admin protection (deferred since
    Phase 4) and privilege escalation needs its own product decision.
  * An administrator cannot change their own role.
  * The target must be an active, non-separated account.
  * Enforcer -> Staff is refused while the enforcer still has schedules dated
    today or later (the schedule screens assume the assignee is an enforcer);
    the admin removes them first. Historical schedules are never touched.
  * Nothing is fabricated: no schedule, GPS fix or duty record is created.
"""
from dataclasses import dataclass

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status as http
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from audit.utils import log_action

from .models import CustomUser, UserRoleHistory

Role = CustomUser.Role

SUPPORTED_TRANSITIONS = frozenset({
    (Role.STAFF.value, Role.ENFORCER.value),
    (Role.ENFORCER.value, Role.STAFF.value),
})
MAX_REASON_LENGTH = 500
_ID_ATTEMPTS = 3


class RoleChangeError(Exception):
    """A refused/failed transition. Carries a safe message and an HTTP status."""

    def __init__(self, code, message, http_status, *, audit=True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.audit = audit          # security-relevant refusal -> FAILED audit row (written by the caller)


@dataclass
class RoleChangeResult:
    user: CustomUser
    history: UserRoleHistory
    old_role: str
    old_id_number: str
    sessions_invalidated: int


def _blacklist_outstanding_tokens(user):
    ids = list(
        OutstandingToken.objects.filter(user=user)
        .exclude(blacklistedtoken__isnull=False)
        .values_list('id', flat=True)
    )
    BlacklistedToken.objects.bulk_create(
        [BlacklistedToken(token_id=i) for i in ids], ignore_conflicts=True,
    )
    return len(ids)


def _clear_role_specific_state(user, old_role):
    """Reset TRANSIENT state that belongs to the role being left. Never deletes history."""
    from enforcers.models import EnforcerLocation
    from violations.models import Violation

    if old_role == Role.ENFORCER.value:
        # Forced sign-off, same effect as the enforcer logging out: not on
        # duty, no live GPS marker. The location row itself is kept.
        user.duty_status = CustomUser.DutyStatus.OFF_DUTY
        user.break_started_at = None
        user.duty_status_updated_at = timezone.now()
        EnforcerLocation.objects.filter(enforcer=user).update(
            status=EnforcerLocation.StatusChoices.INACTIVE,
            geofence_outside_since=None,
        )
    if old_role == Role.STAFF.value:
        # An assessment lock is only meaningful for assessing staff.
        Violation.objects.filter(locked_by=user).update(locked_by=None)


def change_user_role(*, target_pk, new_role, actor, reason, expected_role=None, request=None):
    """Change `target_pk`'s role. Returns RoleChangeResult or raises RoleChangeError."""
    from enforcers.models import EnforcerSchedule

    if not (getattr(actor, 'is_authenticated', False) and actor.is_admin and actor.is_active):
        raise RoleChangeError('permission_denied', 'Permission denied.', http.HTTP_403_FORBIDDEN)

    if new_role not in CustomUser.Role.values:
        raise RoleChangeError('invalid_role', 'Invalid role.', http.HTTP_400_BAD_REQUEST, audit=False)
    reason = (reason or '').strip()
    if not reason:
        raise RoleChangeError('reason_required', 'A reason for the role change is required.',
                              http.HTTP_400_BAD_REQUEST, audit=False)
    if len(reason) > MAX_REASON_LENGTH:
        raise RoleChangeError('reason_too_long',
                              f'The reason must be {MAX_REASON_LENGTH} characters or fewer.',
                              http.HTTP_400_BAD_REQUEST, audit=False)

    with transaction.atomic():
        try:
            target = CustomUser.objects.select_for_update().get(pk=target_pk)
        except CustomUser.DoesNotExist:
            raise RoleChangeError('not_found', 'User not found.', http.HTTP_404_NOT_FOUND, audit=False)

        if target.pk == actor.pk:
            raise RoleChangeError('self_change', 'You cannot change your own role.', http.HTTP_403_FORBIDDEN)

        old_role, old_id = target.role, target.id_number

        if Role.ADMIN.value in (old_role, new_role):
            raise RoleChangeError(
                'admin_transition_not_supported',
                'Role changes to or from Administrator are not supported.',
                http.HTTP_400_BAD_REQUEST,
            )
        if expected_role is not None and expected_role != old_role:
            raise RoleChangeError(
                'stale_request',
                "This account's role has changed since you loaded it. Refresh and try again.",
                http.HTTP_409_CONFLICT,
            )
        if new_role == old_role:
            raise RoleChangeError(
                'role_unchanged', 'This account already has that role.', http.HTTP_409_CONFLICT,
            )
        if (old_role, new_role) not in SUPPORTED_TRANSITIONS:
            raise RoleChangeError('unsupported_transition', 'This role change is not supported.',
                                  http.HTTP_400_BAD_REQUEST)
        if not target.is_active or target.is_separated:
            raise RoleChangeError(
                'account_inactive',
                'Only an active account can change role. Reactivate the account first.',
                http.HTTP_409_CONFLICT,
            )
        if old_role == Role.ENFORCER.value and EnforcerSchedule.objects.filter(
            enforcer_id=target.pk, date__gte=timezone.localdate(),
        ).exists():
            raise RoleChangeError(
                'schedules_exist',
                "This enforcer still has schedules dated today or later. "
                "Remove them before changing the role.",
                http.HTTP_409_CONFLICT,
            )

        # New ID: server-side only, from the Phase 1 ledger-aware generator
        # (advisory lock on PostgreSQL), keeping the account's ORIGINAL hired_year.
        history = None
        for attempt in range(_ID_ATTEMPTS):
            new_id = CustomUser.objects.generate_id_number_for_user(target, new_role)
            try:
                with transaction.atomic():
                    history = UserRoleHistory.objects.create(
                        user=target, old_role=old_role, new_role=new_role,
                        old_id_number=old_id, new_id_number=new_id,
                        effective_at=timezone.now(), changed_by=actor, reason=reason,
                    )
                break
            except IntegrityError:
                if attempt == _ID_ATTEMPTS - 1:
                    raise RoleChangeError(
                        'id_conflict',
                        'Could not allocate a new ID number. Please try again.',
                        http.HTTP_409_CONFLICT,
                    )

        target.role = new_role
        target.id_number = new_id
        # Badge number: an account that becomes an Enforcer and has none yet gets
        # the next system-generated one (same transaction, advisory-locked). An
        # existing badge is kept as is, and the badge of someone leaving the
        # Enforcer role is left on the account, so a number is never reissued.
        badge_assigned = None
        if new_role == Role.ENFORCER.value and not (target.badge_number or '').strip():
            badge_assigned = CustomUser.objects.generate_badge_number()
            target.badge_number = badge_assigned
        _clear_role_specific_state(target, old_role)
        target.save(update_fields=[
            'role', 'id_number', 'badge_number',
            'duty_status', 'break_started_at', 'duty_status_updated_at',
        ])

        invalidated = _blacklist_outstanding_tokens(target)

        log_action(
            user=actor, action='UPDATE', module='User Management',
            description=(f'Changed role of {target.full_name}: {old_role} -> {new_role} '
                         f'(ID {old_id} -> {new_id})'),
            request=request, target_type='User', target_id=target.pk,
            details={
                'target_user': target.full_name,
                'old_role': old_role, 'new_role': new_role,
                'old_id_number': old_id, 'new_id_number': new_id,
                'reason': reason,
                'badge_number_assigned': badge_assigned,
                'sessions_invalidated': True,
            },
            changes={
                'role':      {'before': old_role, 'after': new_role},
                'id_number': {'before': old_id,   'after': new_id},
            },
        )

    return RoleChangeResult(target, history, old_role, old_id, invalidated)