"""
Server-side binding between an issued JWT and the account it was issued for
(Role Evolution, Phase 5).

Why this exists
---------------
`request.user` is always re-read from the database, so authorization already
uses the CURRENT role. What a role change must additionally guarantee is that
credentials issued BEFORE the change stop working altogether, so the person
has to sign in again and receive tokens that describe the new role/ID.

How
---
Tokens minted by `accounts.views.get_tokens` carry the account's `role` and
`id_number`. An id_number is never reissued (Phase 1 ledger) and the role
engine always assigns a brand-new one, so "claims still equal the live
account" is an exact "no role change since issue" test. It needs no new
column and no extra query. It is enforced:

  * on every authenticated API request (TMEOJWTAuthentication),
  * on the SSE endpoints (they authenticate manually and use the same class),
  * on token refresh (accounts.token_views.TMEOTokenRefreshView), so an old refresh token cannot
    mint fresh access tokens.

The role engine also blacklists the user's outstanding refresh tokens
(belt and braces for the refresh path).

A token WITHOUT the claims (never minted by the login flow) is accepted only
if it was issued after the account's latest recorded role transition.
"""
from rest_framework import exceptions
from rest_framework_simplejwt.authentication import JWTAuthentication

SESSION_INVALIDATED_MESSAGE = 'Your session is no longer valid. Please sign in again.'
SESSION_INVALIDATED_CODE = 'session_invalidated'


def token_matches_account(payload, user):
    """True if a token's payload is still valid for `user`'s current role/ID."""
    claim_role = payload.get('role')
    claim_id = payload.get('id_number')
    if claim_role is not None or claim_id is not None:
        return claim_role == user.role and claim_id == user.id_number

    # Claim-less token: valid only if issued after the latest role transition.
    from .models import UserRoleHistory
    latest = (
        UserRoleHistory.objects.filter(user_id=user.pk)
        .order_by('-effective_at').values_list('effective_at', flat=True).first()
    )
    if latest is None:
        return True
    iat = payload.get('iat')
    return iat is not None and iat >= latest.timestamp()


class TMEOJWTAuthentication(JWTAuthentication):
    """SimpleJWT authentication that also rejects tokens issued for a previous role/ID."""

    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        if not token_matches_account(validated_token.payload, user):
            raise exceptions.AuthenticationFailed(
                {'detail': SESSION_INVALIDATED_MESSAGE, 'code': SESSION_INVALIDATED_CODE},
                code=SESSION_INVALIDATED_CODE,
            )
        return user


def account_still_matches(user_id, role, id_number):
    """For long-lived SSE streams authenticated once at connect: False once the
    account's role/ID changed (or it was deactivated), so the stream must end."""
    from .models import CustomUser
    return CustomUser.objects.filter(
        pk=user_id, role=role, id_number=id_number, is_active=True,
    ).exists()