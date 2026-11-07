"""Input validation and role-aware output for the Confiscated Licenses API."""
from rest_framework import serializers

from .custody import LAST4_RE, mask_last4
from .custody_models import LicenseCustody

CID = serializers.UUIDField  # client_request_id is a UUID


class _WriteBase(serializers.Serializer):
    expected_version = serializers.IntegerField(min_value=0)
    client_request_id = serializers.UUIDField()


class MarkReadySerializer(_WriteBase):
    pass


class ReleaseSerializer(_WriteBase):
    released_to_name = serializers.CharField(max_length=150)
    claimant_id_type = serializers.ChoiceField(choices=LicenseCustody.ClaimantIdType.choices)
    # Last four characters only. A full ID number is rejected by length.
    claimant_id_last4 = serializers.CharField(max_length=4, required=False, allow_blank=True, default='')
    authorization_reference = serializers.CharField(
        max_length=100,
        help_text='Reference of the authorization letter / SPA - NOT an ID number.')
    release_remarks = serializers.CharField(required=False, allow_blank=True, default='', max_length=1000)

    def validate_claimant_id_last4(self, v):
        v = (v or '').strip()
        if not LAST4_RE.match(v):
            raise serializers.ValidationError('Enter at most the last 4 letters/digits of the ID.')
        return v

    def validate_released_to_name(self, v):
        v = v.strip()
        if not v:
            raise serializers.ValidationError('Enter who the license is released to.')
        return v

    def validate_authorization_reference(self, v):
        v = v.strip()
        if not v:
            raise serializers.ValidationError('Enter the authorization reference.')
        return v


class VerifyDocumentTypeSerializer(_WriteBase):
    decision = serializers.ChoiceField(choices=['drivers_license', 'not_drivers_license'])
    reason = serializers.CharField(max_length=500)

    def validate_reason(self, v):
        v = v.strip()
        if not v:
            raise serializers.ValidationError('A reason is required.')
        return v


class CorrectSerializer(_WriteBase):
    license_number = serializers.CharField(max_length=50)
    reason = serializers.CharField(max_length=500)

    def validate_license_number(self, v):
        v = v.strip()
        if not v:
            raise serializers.ValidationError('Enter the corrected license number.')
        return v

    def validate_reason(self, v):
        v = v.strip()
        if not v:
            raise serializers.ValidationError('A reason is required.')
        return v


def event_payload(e, is_admin):
    """Staff: type, time, actor name, from/to status only.
    Admin: also the operation, reasons and before/after values."""
    out = {
        'id': e.id, 'event_type': e.event_type, 'created_at': e.created_at,
        'actor_name': e.actor_name_snapshot, 'from_status': e.from_status, 'to_status': e.to_status,
    }
    if is_admin:
        out.update({
            'operation': e.operation, 'actor_role': e.actor_role_snapshot,
            'details': e.details,
            'custody_id': e.custody_id,
        })
    return out


def release_payload(c):
    if c is None or c.released_at is None:
        return None
    return {
        'released_at': c.released_at,
        'released_by': c.released_by.full_name if c.released_by_id else '',
        'released_to_name': c.released_to_name,
        'claimant_id_type': c.claimant_id_type,
        'claimant_id': mask_last4(c.claimant_id_last4),
        'authorization_reference': c.authorization_reference,
        'remarks': c.release_remarks,
    }