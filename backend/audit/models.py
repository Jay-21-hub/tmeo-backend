from django.db import models
from accounts.models import CustomUser

class AuditLog(models.Model):
    ACTION_CHOICES = [
        ('CREATE', 'Created'),
        ('UPDATE', 'Updated'),
        ('DELETE', 'Deleted'),
        ('LOGIN',  'Logged In'),
        ('LOGOUT', 'Logged Out'),
        ('DEPLOY', 'Enforcer Deployed'),
    ]

    user         = models.ForeignKey(CustomUser, on_delete=models.SET_NULL, null=True)
    action       = models.CharField(max_length=20, choices=ACTION_CHOICES)
    module       = models.CharField(max_length=50)  # e.g. Violations, Enforcers
    description  = models.TextField()               # e.g. "Created violation TRF-2026-001"
    ip_address   = models.GenericIPAddressField(null=True, blank=True)
    timestamp    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']

    def __str__(self):
        return f"{self.user} | {self.action} | {self.module} | {self.timestamp}"