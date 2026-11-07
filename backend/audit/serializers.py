from rest_framework import serializers
from accounts.identity import audit_actor_identity
from .models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    # Phase 3: identity is the EVENT-TIME snapshot, not the live account.
    # user_email stays live (contact detail, not identity). Role / ID number
    # are never read from the live account.
    user_name  = serializers.SerializerMethodField()
    user_email = serializers.CharField(source='user.email', default='System')
    user_role  = serializers.SerializerMethodField()
    user_id_number = serializers.SerializerMethodField()
    # API-only: 'event' | 'derived' | 'unverified' | 'unknown'
    identity_certainty = serializers.SerializerMethodField()

    target_label = serializers.SerializerMethodField()
    client_summary = serializers.SerializerMethodField()

    class Meta:
        model  = AuditLog
        fields = [
            'id',
            'user_name',
            'user_email',
            'user_role',
            'user_id_number',
            'identity_certainty',
            'action',
            'module',
            'description',
            'ip_address',
            'status',
            'timestamp',
            'details',
            'target_type',
            'target_id',
            'target_label',
            'changes',
            'user_agent',
            'device',
            'os',
            'browser',
            'client_summary',
        ]

    def _ident(self, obj):
        cache = self.__dict__.setdefault('_ident_cache', {})
        if obj.pk not in cache:
            cache[obj.pk] = audit_actor_identity(obj)
        return cache[obj.pk]

    def get_user_name(self, obj):
        if obj.user_id is None and obj.actor_snapshot_source == 'unknown':
            return 'System'
        return self._ident(obj)['name'] or 'Unknown'

    def get_user_role(self, obj):
        if obj.user_id is None and obj.actor_snapshot_source == 'unknown':
            return 'system'
        return self._ident(obj)['role'] or ''

    def get_user_id_number(self, obj):
        return self._ident(obj)['id_number']

    def get_identity_certainty(self, obj):
        return self._ident(obj)['certainty']

    def get_target_label(self, obj):
        """Human-readable 'Violation #14' / 'User: jane@x.com' style label,
        built from target_type/target_id when present, falling back to
        whatever the old `details` blob already carried."""
        if obj.target_type and obj.target_id:
            return f'{obj.target_type} #{obj.target_id}'
        d = obj.details or {}
        for key in ('violation_id', 'target_user', 'deleted_user', 'ticket_number'):
            if d.get(key):
                return str(d[key])
        return None

    def get_client_summary(self, obj):
        """'Chrome on Windows 10/11 (Desktop)' style one-liner for the UI."""
        if not (obj.browser or obj.os or obj.device):
            return None
        parts = []
        if obj.browser and obj.browser != 'Unknown':
            parts.append(obj.browser)
        if obj.os and obj.os != 'Unknown':
            parts.append(f'on {obj.os}')
        summary = ' '.join(parts) if parts else 'Unknown client'
        if obj.device:
            summary += f' ({obj.device})'
        return summary