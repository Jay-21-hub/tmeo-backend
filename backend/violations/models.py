from django.db import models
from accounts.models import CustomUser
from accounts.identity import SnapshotSource


class ViolationType(models.Model):
    class Category(models.TextChoices):
        SAFETY = 'safety', 'Safety Violation'
        TRAFFIC = 'traffic', 'Traffic Violation'
        OTHER = 'other', 'Other'

    code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=200)
    category = models.CharField(max_length=20, choices=Category.choices, default=Category.TRAFFIC)
    penalty_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['code']

    def __str__(self):
        return f"{self.code} - {self.name}"


class Violation(models.Model):
    class Status(models.TextChoices):
        PENDING    = 'pending',    'Pending'
        PROCESSING = 'processing', 'Processing'
        PAID       = 'paid',       'Paid'

    class Source(models.TextChoices):
        """
        Distinguishes how this record originated:
          - ENFORCER_OVR: Enforcer issued a physical OVR in the field
            (Issue OVR wizard). ovr_number is REQUIRED and manually
            entered by the enforcer (comes from City Hall booklets).
          - STAFF_WALK_IN: Staff created the record from zero for a
            walk-in complainant with no prior Enforcer OVR. There is
            no OVR number in this case — the system must NOT fabricate
            one or pretend an Enforcer issued it.
          - IMPORTED: Admin bulk-imported this historical record from an
            Excel file. `enforcer` is NULL (no legitimate issuing enforcer)
            and `imported_by` holds the Admin who uploaded it. Its
            ViolationItem rows carry NO authoritative item-level penalty
            (penalty_amount_snapshot is a 0 placeholder, not a real zero);
            only the ticket-level `penalty_amount` is authoritative.
        """
        ENFORCER_OVR  = 'enforcer_ovr',  'Enforcer-Issued OVR'
        STAFF_WALK_IN = 'staff_walk_in', 'Staff Walk-in Complaint'
        IMPORTED      = 'imported',      'Admin Excel Import'

    # Origin of this record — see Source docstring above.
    source = models.CharField(
        max_length=20, choices=Source.choices, default=Source.ENFORCER_OVR,
        help_text='How this record was created: Enforcer OVR vs Staff walk-in.'
    )

    # Violator info
    violator_name = models.CharField(max_length=200)
    license_number = models.CharField(max_length=50, blank=True)
    license_status = models.CharField(max_length=20, choices=[('confiscated','Confiscated'),('not_confiscated','Not Confiscated')], default='not_confiscated')

    class ConfiscatedDocument(models.TextChoices):
        """INTERNAL record field only — never printed on the Assessment Form."""
        DRIVERS_LICENSE = 'drivers_license', "Driver's License"
        BIR             = 'bir',             'BIR-related ID/document'
        UMID            = 'umid',            'UMID'
        COMPANY_ID      = 'company_id',      'Company ID'
        PHILHEALTH      = 'philhealth',      'PhilHealth ID'
        OTHERS          = 'others',          'Others'

    # Confiscation details (only meaningful while license_status='confiscated';
    # the serializer clears them otherwise). For Driver's License the number
    # stays in `license_number` (single source of truth, backward compatible);
    # `confiscated_document_number` is used for every non-license document.
    confiscated_document_type = models.CharField(
        max_length=20, choices=ConfiscatedDocument.choices, blank=True, default='',
    )
    confiscated_document_name = models.CharField(
        max_length=100, blank=True, default='',
        help_text='Custom document name — required when the type is Others.',
    )
    confiscated_document_number = models.CharField(
        max_length=50, blank=True, default='',
        help_text='Document / Reference Number for non-license documents.',
    )
    plate_number = models.CharField(max_length=20, blank=True)
    registration_number = models.CharField(max_length=50, blank=True)
    vehicle_type = models.CharField(max_length=100, blank=True)
    vehicle_brand = models.CharField(max_length=100, blank=True)
    vehicle_model = models.CharField(max_length=100, blank=True)

    class VehicleUse(models.TextChoices):
        """Matches the [ ] Private / [ ] Public checkbox on the printed OVR."""
        PRIVATE = 'private', 'Private'
        PUBLIC  = 'public',  'Public'

    vehicle_use = models.CharField(
        max_length=10, choices=VehicleUse.choices, blank=True,
        help_text='Private or Public use, as checked on the printed OVR.'
    )
    address = models.TextField(blank=True)
    ovr_number = models.CharField(max_length=50, blank=True)

    # Idempotency key for offline-queued OVR submissions (Requirement #10).
    # Generated client-side once per offline record and sent back on every
    # sync attempt for that record. Lets ViolationCreateView detect and
    # safely replay a duplicate POST (retry after a dropped response,
    # re-sync after app restart, etc.) without creating a second row.
    # Left null for every normal (non-offline) submission — null, not
    # blank '', so the unique constraint doesn't collide across those rows.
    client_offline_id = models.CharField(
        max_length=100, null=True, blank=True, unique=True, db_index=True,
        help_text='Client-generated idempotency key for offline-queued OVR submissions.'
    )

    # Violation details
    location = models.CharField(max_length=300, blank=True)
    latitude  = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    date_issued = models.DateTimeField()
    remarks = models.TextField(blank=True)

    # Computed total — sum of all ViolationItems
    penalty_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    # Status & relations
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    enforcer = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='violations_filed'
    )
    # Uploader of an Excel bulk import (source='imported'). This is NOT the
    # issuing enforcer and must never be counted as enforcement activity.
    # NULL for every non-imported record.
    imported_by = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='violations_imported',
        help_text='Admin who bulk-imported this record (source=imported). Not the issuing enforcer.'
    )
    # Event-time identity of the apprehending Enforcer (Role Evolution, Phase 1).
    # `enforcer` stays the stable FK (the person); these freeze who they WERE
    # when the OVR was issued, so a later name / role / ID-number change cannot
    # rewrite the record. The source column says how far to trust them:
    #   event   captured when the OVR was created
    #   assumed best-effort legacy inference (role only, see migration 0014)
    #   unknown legacy row — nothing can be proven (name/ID stay NULL)
    # NULL for imports and staff walk-ins (no apprehending enforcer).
    enforcer_name_snapshot      = models.CharField(max_length=150, null=True, blank=True, editable=False)
    enforcer_role_snapshot      = models.CharField(
        max_length=20, choices=CustomUser.Role.choices, null=True, blank=True, editable=False,
    )
    enforcer_id_number_snapshot = models.CharField(max_length=50, null=True, blank=True, editable=False)
    enforcer_badge_snapshot     = models.CharField(max_length=50, null=True, blank=True, editable=False)
    enforcer_snapshot_source    = models.CharField(
        max_length=10, choices=SnapshotSource.choices, default=SnapshotSource.UNKNOWN, editable=False,
    )
    # Denormalised mirror of Assessment.assessed_by — the ASSESSOR (set by
    # PATCH /assess/). Confirm Payment never changes it; the payment
    # confirmer lives on Assessment.payment_confirmed_by.
    assessed_by = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='violations_assessed'
    )
    assessed_at = models.DateTimeField(null=True, blank=True)
    assessment_notes = models.TextField(blank=True)

    locked_by = models.ForeignKey(
        CustomUser, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='violations_locked',
        help_text='Staff member currently assessing this violation'
    )

    # Image/evidence
    image = models.ImageField(upload_to='violations/', null=True, blank=True)

    # Ticket tracking
    is_printed = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Violation #{self.id} - {self.violator_name}"

    def compute_total(self):
        """Recompute penalty_amount from all ViolationItems' snapshotted
        amounts (NOT the live ViolationType price) and save."""
        total = self.items.aggregate(
            total=models.Sum('penalty_amount_snapshot')
        )['total'] or 0
        self.penalty_amount = total
        self.save(update_fields=['penalty_amount'])
        return self.penalty_amount


class ViolationItem(models.Model):
    """One row per violation type selected for a given Violation ticket."""
    violation = models.ForeignKey(
        Violation, on_delete=models.CASCADE, related_name='items'
    )
    violation_type = models.ForeignKey(
        ViolationType, on_delete=models.PROTECT, related_name='violation_items'
    )
    # Penalty amount AT THE TIME this item was created — never changes even
    # if the ViolationType's penalty_amount is edited later.
    penalty_amount_snapshot = models.DecimalField(
        max_digits=10, decimal_places=2, default=0
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('violation', 'violation_type')

    def __str__(self):
        return f"Violation #{self.violation_id} → {self.violation_type.code}"


class VehicleBrandModel(models.Model):
    """
    Admin-managed catalog of brand/model pairs used by the brand-model
    autocomplete on the violation report forms (enforcer Submit Report
    and staff Assessment Form both use this — single source of truth,
    replacing what used to be two separate hardcoded frontend lists).

    `category` is a direct field on this model — there used to be a
    separate `VehicleType` table (Category → Type → Brand → Model) but
    that intermediate "Type" layer was removed per product decision:
    Category alone (Motorcycle/Car/PUV/Truck/Special) is now the only
    classification enforcers and staff pick from. Every brand/model row
    always has a category (defaults to CAR), so there is no more
    "unassigned type" edge case to guard against in the picker UI.
    """
    class Category(models.TextChoices):
        MOTORCYCLE = 'motorcycle', 'Motorcycles'
        CAR        = 'car',        'Cars'
        PUV        = 'puv',        'Public Utility Vehicles'
        TRUCK      = 'truck',      'Trucks & Heavy Vehicles'
        SPECIAL    = 'special',    'Special / Other'

    brand = models.CharField(max_length=60)
    model = models.CharField(max_length=100)
    category = models.CharField(max_length=20, choices=Category.choices, default=Category.CAR)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['brand', 'model']
        unique_together = ('brand', 'model')

    def __str__(self):
        return f"{self.brand} {self.model}"


class Assessment(models.Model):
    """
    STAFF-SIDE record — kept deliberately SEPARATE from Violation/OVR.

    Architecture (per Jay's non-negotiable requirement):
        Violation/OVR (Enforcer)
            |
            └── Assessment (Staff, OneToOne)
                    ├── or_number       (manual, from City Hall)
                    ├── penalty
                    ├── amount_paid
                    ├── received_by
                    ├── date_paid
                    ├── assessed_by            (the ASSESSOR)
                    └── payment_confirmed_by   (who pressed Confirm Payment)

    This is what the official "ASSESSMENT FORM" (Image 1) is generated
    from. The Enforcer's Violation/OVR record is NEVER edited to hold
    these fields — Staff filling out O.R./payment info must not touch
    or retype anything the Enforcer already submitted.

    One Violation has at most one Assessment (OneToOneField) — created
    the first time Staff opens/processes a pending record, then updated
    as Staff progresses through assessment → payment.
    """
    violation = models.OneToOneField(
        Violation, on_delete=models.CASCADE, related_name='assessment'
    )

    # O.R. Number — MANUAL INPUT by Staff, comes from City Hall.
    # Never auto-generated. Blank until Staff records payment.
    or_number = models.CharField(max_length=50, blank=True)

    penalty      = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    amount_paid  = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    received_by  = models.CharField(max_length=150, blank=True)
    date_paid    = models.DateField(null=True, blank=True)

    assessed_by  = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='assessments_made'
    )
    assessed_at  = models.DateTimeField(null=True, blank=True)
    # Event-time identity of the ASSESSOR (Role Evolution, Phase 1). Deliberately
    # named assessor_*: the person who confirms PAYMENT is a different concept
    # (payment_confirmer_* below) and must not share these.
    # assessed_by / assessed_at / assessor_* are written when Staff/Admin
    # assess (PATCH /assess/) and are NEVER touched by Confirm Payment.
    assessor_name_snapshot      = models.CharField(max_length=150, null=True, blank=True, editable=False)
    assessor_role_snapshot      = models.CharField(
        max_length=20, choices=CustomUser.Role.choices, null=True, blank=True, editable=False,
    )
    assessor_id_number_snapshot = models.CharField(max_length=50, null=True, blank=True, editable=False)
    assessor_snapshot_source    = models.CharField(
        max_length=10, choices=SnapshotSource.choices, default=SnapshotSource.UNKNOWN, editable=False,
    )
    # ── PAYMENT CONFIRMER (Role Evolution, Phase 2) ──────────────────────
    # Whoever pressed Confirm Payment. A different event from assessing, so
    # it has its own FK + event-time snapshot. SET_NULL like every other
    # attribution FK today: the snapshot keeps the identity if the account
    # row is ever removed. NULL + source='unknown' on legacy rows unless
    # reliable AuditLog evidence exists (source='derived', migration 0031).
    # payment_confirmed_at is the INSTANT of confirmation; date_paid stays
    # the authoritative settlement DATE.
    payment_confirmed_by = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='payments_confirmed'
    )
    payment_confirmed_at = models.DateTimeField(null=True, blank=True)
    payment_confirmer_name_snapshot      = models.CharField(max_length=150, null=True, blank=True, editable=False)
    payment_confirmer_role_snapshot      = models.CharField(
        max_length=20, choices=CustomUser.Role.choices, null=True, blank=True, editable=False,
    )
    payment_confirmer_id_number_snapshot = models.CharField(max_length=50, null=True, blank=True, editable=False)
    payment_confirmer_snapshot_source    = models.CharField(
        max_length=10, choices=SnapshotSource.choices, default=SnapshotSource.UNKNOWN, editable=False,
    )
    notes        = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Assessment for Violation #{self.violation_id}"


class ViolationEvidence(models.Model):
    """
    Camera-capture evidence — a SEPARATE feature from the OVR form itself
    (never a wizard step, never printed on the official OVR). Linked to
    its Violation/OVR for audit/dispute purposes only.

    Each photo records who captured it, when it was captured on-device,
    when it actually reached the server (these can differ when the
    Enforcer was offline), and where it was captured.
    """
    # Nullable/SET_NULL: a photo can be captured standalone (before an OVR
    # exists yet) and associated to a Violation afterwards via the
    # "Associate with OVR" action — see EvidenceAssociateView. Deleting the
    # Violation later must not destroy the evidence photo itself.
    violation = models.ForeignKey(
        Violation, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='evidence'
    )
    image = models.ImageField(upload_to='evidence/')

    captured_at        = models.DateTimeField(help_text='Timestamp from the device at the moment of capture.')
    server_received_at = models.DateTimeField(auto_now_add=True, help_text='When this evidence reached the backend.')

    latitude  = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    gps_accuracy = models.FloatField(
        null=True, blank=True,
        help_text='Device-reported GPS accuracy radius in meters at time of capture.'
    )

    # Always the authenticated uploader — never trust a client-supplied
    # enforcer id, to prevent spoofing another Enforcer's identity.
    captured_by = models.ForeignKey(
        CustomUser, on_delete=models.PROTECT, null=True, blank=True,
        related_name='evidence_captured'
    )

    # Archive hardening (Checkpoint 1): when a Violation is archived its row
    # is deleted, and `violation` above would silently become NULL, leaving
    # the photo looking like an unassociated standalone capture that anyone
    # could re-attach to a different ticket. Archiving instead RELINKS the
    # evidence here, to the ArchivedViolation snapshot of its ticket.
    #   * PROTECT: an archived record that still owns evidence cannot be
    #     deleted out from under it (the delete view answers 409).
    #   * evidence_active_xor_archived_link (see Meta): a photo is linked to
    #     an ACTIVE violation or an ARCHIVED one, never both.
    #   * editable=False and absent from every serializer's writable fields:
    #     only archive_utils sets it.
    archived_violation = models.ForeignKey(
        'database_management.ArchivedViolation', on_delete=models.PROTECT,
        null=True, blank=True, editable=False, related_name='evidence',
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-captured_at']
        constraints = [
            models.CheckConstraint(
                condition=~(models.Q(violation__isnull=False) & models.Q(archived_violation__isnull=False)),
                name='evidence_active_xor_archived_link',
            ),
        ]

    def __str__(self):
        return f"Evidence #{self.id} for Violation #{self.violation_id}"


# Confiscated Licenses custody ledger (Checkpoint 3). Imported last so that
# Violation exists; this also registers the pre_save confiscation lock.
from .custody_models import LicenseCustody, LicenseCustodyEvent  # noqa: E402,F401