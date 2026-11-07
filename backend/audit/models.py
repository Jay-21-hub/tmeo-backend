from django.db import models
from accounts.models import CustomUser
from accounts.identity import SnapshotSource


class AuditLog(models.Model):
    ACTION_CHOICES = [
        ('CREATE', 'Created'),
        ('UPDATE', 'Updated'),
        ('DELETE', 'Deleted'),
        ('LOGIN',  'Logged In'),
        ('LOGOUT', 'Logged Out'),
        ('DEPLOY', 'Enforcer Deployed'),
        ('EXPORT', 'Full Database Export'),
        ('ARCHIVE', 'Database Archived'),
    ]
    STATUS_CHOICES = [
        ('SUCCESS', 'Success'),
        ('FAILED',  'Failed'),
        ('WARNING', 'Warning'),
        ('INFO',    'Info'),
    ]

    user        = models.ForeignKey(CustomUser, on_delete=models.PROTECT, null=True)
    action      = models.CharField(max_length=20, choices=ACTION_CHOICES)
    module      = models.CharField(max_length=50)
    description = models.TextField()
    ip_address  = models.GenericIPAddressField(null=True, blank=True)
    status      = models.CharField(max_length=20, choices=STATUS_CHOICES, default='SUCCESS')
    timestamp   = models.DateTimeField(auto_now_add=True)
    details     = models.JSONField(null=True, blank=True)

    # ── Target being acted on (what record this log entry is about) ──────
    target_type = models.CharField(
        max_length=50, blank=True, default='',
        help_text="e.g. 'Violation', 'User', 'Schedule' — the model/entity affected.",
    )
    target_id = models.CharField(
        max_length=50, blank=True, default='',
        help_text="Primary key (or natural id, e.g. ticket number) of the affected record.",
    )

    # ── Before/after diff for UPDATE actions ──────────────────────────────
    changes = models.JSONField(
        null=True, blank=True,
        help_text="{'field': {'before': ..., 'after': ...}} — only changed fields.",
    )

    # ── Event-time actor identity (Role Evolution, Phase 1) ──────────────
    # `user` stays the stable FK (the person). These freeze who the actor
    # WAS when the action happened, so a later name/role/ID change cannot
    # rewrite history. NULL + source='unknown' on legacy rows: the identity
    # at the time cannot be proven from existing data.
    actor_name_snapshot = models.CharField(max_length=150, null=True, blank=True, editable=False)
    actor_role_snapshot = models.CharField(
        max_length=20, choices=CustomUser.Role.choices, null=True, blank=True, editable=False,
    )
    actor_id_number_snapshot = models.CharField(max_length=50, null=True, blank=True, editable=False)
    actor_snapshot_source = models.CharField(
        max_length=10, choices=SnapshotSource.choices, default=SnapshotSource.UNKNOWN, editable=False,
    )

    # ── Client / request device info (parsed from User-Agent) ─────────────
    user_agent = models.TextField(blank=True, default='')
    device     = models.CharField(max_length=30, blank=True, default='')   # Desktop / Mobile / Tablet
    os         = models.CharField(max_length=50, blank=True, default='')   # Windows 10, macOS, Android, iOS...
    browser    = models.CharField(max_length=50, blank=True, default='')   # Chrome 120, Safari, Firefox...

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['-timestamp']),
            models.Index(fields=['action']),
            models.Index(fields=['module']),
            models.Index(fields=['status']),
            models.Index(fields=['target_type', 'target_id']),
        ]

    def __str__(self):
        return f"{self.user} | {self.action} | {self.module} | {self.timestamp} | {self.status}"