from rest_framework import serializers
from accounts.identity import notification_actor_identity
from .models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    time_ago = serializers.SerializerMethodField()
    # Additive: WHO performed the event (from the stored related_user), kept
    # separate from whoever is viewing the notification.
    actor_name = serializers.SerializerMethodField()
    actor_role = serializers.SerializerMethodField()
    # Phase 3: 'event' | 'derived' | 'unverified' | 'unknown'
    actor_certainty = serializers.SerializerMethodField()

    class Meta:
        model  = Notification
        fields = [
            'id', 'notif_type', 'title', 'message',
            'is_read', 'related_user', 'related_violation_id',
            'created_at', 'time_ago', 'actor_name', 'actor_role', 'actor_certainty',
        ]

    # Phase 3: WHO acted, as they were then (event-time snapshot). The live
    # account supplies a NAME only when no trustworthy snapshot exists; the
    # role is never read from the live account.
    def get_actor_name(self, obj):
        return notification_actor_identity(obj)['name']

    def get_actor_role(self, obj):
        return notification_actor_identity(obj)['role']

    def get_actor_certainty(self, obj):
        return notification_actor_identity(obj)['certainty']

    def get_time_ago(self, obj):
        from django.utils import timezone
        diff = timezone.now() - obj.created_at
        s = diff.total_seconds()
        if s < 60:     return 'Just now'
        if s < 3600:   return f'{int(s // 60)}m ago'
        if s < 86400:  return f'{int(s // 3600)}h ago'
        return f'{int(s // 86400)}d ago'