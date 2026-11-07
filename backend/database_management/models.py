from django.db import models
from accounts.models import CustomUser


class ArchiveBatch(models.Model):
    class Status(models.TextChoices):
        IN_PROGRESS = 'in_progress', 'In Progress'
        SUCCESS     = 'success',     'Success'
        FAILED      = 'failed',      'Failed'

    created_by   = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='archive_batches',
    )
    created_at   = models.DateTimeField(auto_now_add=True)
    status       = models.CharField(max_length=20, choices=Status.choices, default=Status.IN_PROGRESS)

    active_count_before = models.PositiveIntegerField(default=0)
    archived_count       = models.PositiveIntegerField(default=0)

    # Records that existed in the active table at run time but were left
    # untouched because their staff processing was still in progress
    # (pending/processing, or locked for an active Resume session) —
    # see archive_utils._is_in_progress. They are not lost; they simply
    # weren't part of this batch and remain eligible for a future one.
    skipped_in_progress_count = models.PositiveIntegerField(default=0)

    error_message = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"ArchiveBatch #{self.id} — {self.status} ({self.archived_count} records)"


class ArchivedViolation(models.Model):
    class Settlement(models.TextChoices):
        SETTLED   = 'settled',   'Settled'
        UNSETTLED = 'unsettled', 'Unsettled'

    batch = models.ForeignKey(
        ArchiveBatch, on_delete=models.PROTECT, related_name='violations',
    )

    # Traceability back to the original (now-deleted) active record.
    original_violation_id = models.PositiveIntegerField(db_index=True)

    # ── Classification (PART 14/15) — always derived from date_issued ────
    violation_year = models.PositiveIntegerField(db_index=True)
    date_issued    = models.DateTimeField()

    # ── Settlement status is independent of the archive year (PART 16/17) ─
    settlement_status = models.CharField(
        max_length=20, choices=Settlement.choices, db_index=True,
    )
    settled_at = models.DateTimeField(
        null=True, blank=True,
        help_text='Best-available settlement timestamp (see deliverable notes on this assumption).',
    )

    violator_name  = models.CharField(max_length=200, db_index=True)
    license_number = models.CharField(max_length=50, blank=True, db_index=True)
    plate_number   = models.CharField(max_length=20, blank=True, db_index=True)
    data = models.JSONField()
    archived_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-violation_year', '-date_issued']
        indexes = [
            models.Index(fields=['violation_year', 'settlement_status']),
        ]

    def __str__(self):
        return f"Archived Violation #{self.original_violation_id} ({self.violation_year})"