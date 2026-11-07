"""
database_management/export_utils.py

Full Database Export — dynamic field discovery (PART 6/7/8).

The exportable column list is NOT a hardcoded list maintained by hand.
It is derived at request time from `Violation._meta.get_fields()`, so a
new scalar field added to the model later (e.g. a future "vehicle_type"
style addition) appears in the export automatically with no code change
here.

Two things are NOT purely introspected, and are documented as an explicit
assumption per PART 45:

1. `INTERNAL_FIELD_NAMES` — a short denylist of fields that exist on the
   model but are workflow/technical rather than business data (a lock
   flag, raw GPS floats when a human-readable location string already
   exists, the binary image reference). This is the mechanism PART 7
   requires ("dynamic does not mean export everything blindly").

2. A handful of *computed* columns (violation items joined into a
   readable string, enforcer/assessor display names instead of raw
   foreign-key ids) that cannot be discovered by introspecting scalar
   model fields alone, because they come from a related table or need
   human-readable resolution. These are registered once, appended after
   the introspected columns, and require no changes when new *scalar*
   Violation fields are added.

Foreign keys are never exported as raw ids — they are resolved to their
human-readable representation (PART 7's "technical foreign-key fields...
when human-readable related data is available").
"""
from decimal import Decimal
from datetime import datetime, date
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from django.utils import timezone

from accounts.identity import (
    assessor_identity, enforcer_identity, resolve_historical_identity,
)

from violations.models import Violation
from .historical import archived_in_period, deduped_archived
from .models import ArchivedViolation

# Fields that exist on the model but must never appear in a business
# export automatically, even though the dynamic introspection would
# otherwise pick them up.
INTERNAL_FIELD_NAMES = {
    'locked_by',      # workflow lock (who currently has this open) — not business data
    'image',          # binary file reference
    'latitude',       # raw GPS pair — 'location' text field is the human-readable version
    'longitude',
    'enforcer',       # raw FK object — replaced by the computed 'enforcer_name' column below
    'assessed_by',    # raw FK object — replaced by the computed 'assessed_by_name' column below
}

# Human-readable overrides for a few field names whose auto-generated
# verbose_name would be technically correct but awkward. Every field NOT
# listed here still gets a label automatically from its verbose_name, so
# this is a polish layer, not the mechanism that makes new fields appear.
LABEL_OVERRIDES = {
    'id': 'Ticket ID',
    'ovr_number': 'OVR Number',
}


EXPORT_TZ = ZoneInfo('Asia/Manila')


def _to_manila(dt):
    """Timezone-aware datetimes are converted to Asia/Manila BEFORE they are
    formatted (the database hands them back in UTC, which printed an
    8-hour-early wall clock). A naive datetime is left exactly as stored."""
    if timezone.is_aware(dt):
        return dt.astimezone(EXPORT_TZ)
    return dt


def _imported_by_text(user):
    """Readable Admin identity for `imported_by` (the uploader of an Excel
    import) — never a Django model object. Name only; blank when the record
    was not imported."""
    if user is None:
        return ''
    return (getattr(user, 'full_name', '') or '').strip()


def _format_value(value):
    """Make a field value Excel/JSON-safe and human-readable."""
    if value is None:
        return ''
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return _to_manila(value).strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(value, date):
        return value.strftime('%Y-%m-%d')
    return value


def get_exportable_columns():
    """
    Returns an ordered list of (key, header_label) derived dynamically
    from the live Violation model, i.e. the columns a Full Database
    Export will contain right now.
    """
    columns = []
    for f in Violation._meta.get_fields():
        if not getattr(f, 'concrete', False):
            continue  # skip reverse relations (e.g. `items`) — handled as computed columns below
        if f.name in INTERNAL_FIELD_NAMES:
            continue

        if f.name in LABEL_OVERRIDES:
            label = LABEL_OVERRIDES[f.name]
        else:
            label = str(getattr(f, 'verbose_name', f.name)).replace('_', ' ').title()

        columns.append((f.name, label))

    # Computed columns — not introspectable scalar fields, registered once.
    columns.append(('violation_types', 'Violation Type(s)'))
    columns.append(('enforcer_name', 'Filed By (Enforcer)'))
    columns.append(('assessed_by_name', 'Assessed By'))

    return columns


def _resolve_row(violation, columns):
    """Builds one export row (dict of key -> value) for a Violation instance."""
    row = {}
    for key, _label in columns:
        if key == 'violation_types':
            row[key] = ', '.join(
                i.violation_type.name for i in violation.items.all() if i.violation_type
            )
        elif key == 'enforcer_name':
            # Phase 3: event-time snapshot first; live NAME only as an
            # unverified fallback (never role / ID / badge).
            row[key] = enforcer_identity(violation)['name'] or ''
        elif key == 'assessed_by_name':
            # Phase 3: the ASSESSOR from the assessor snapshot. Violation.
            # assessed_by is not used (legacy payment confirmation overwrote
            # it); an unprovable legacy assessor is blank.
            record = getattr(violation, 'assessment', None)
            row[key] = (assessor_identity(record)['name'] or '') if record else ''
        elif key == 'imported_by':
            row[key] = _imported_by_text(violation.imported_by)
        elif key == 'status':
            row[key] = violation.get_status_display()
        elif key == 'license_status':
            row[key] = violation.get_license_status_display()
        else:
            row[key] = _format_value(getattr(violation, key, ''))
    return row


_FORMULA_LEAD_CHARS = ('=', '+', '-', '@')


def _sanitize_cell(value):
    """
    Neutralizes Excel/CSV formula injection: a string value that begins
    with a formula-triggering character is prefixed with a leading
    apostrophe so spreadsheet software treats it as plain text.
    """
    if isinstance(value, str) and value[:1] in _FORMULA_LEAD_CHARS:
        return "'" + value
    return value


# ─────────────────────────────────────────────────────────────────────────
# ARCHIVED RECORDS EXPORT
#
# Reuses the same column discovery / cell-safety machinery as the Full
# Database Export above (get_exportable_columns, _format_value,
# _sanitize_cell) — this is NOT a second export engine. The only
# difference is where each row's data comes from: a live Violation
# instance there, vs. the frozen `ArchivedViolation.data` JSON snapshot
# here (the original active record no longer exists once archived).
# ─────────────────────────────────────────────────────────────────────────

# Payment/preservation columns that only exist on archived records — the
# settlement info captured off the related Assessment at archive time
# (see archive_utils._snapshot_violation), plus the archive timestamp
# itself. Appended after the introspected + computed columns.
ARCHIVED_PRESERVATION_COLUMNS = [
    ('or_number', 'OR Number'),
    ('amount_paid', 'Amount Paid'),
    ('date_paid', 'Date Paid'),
    ('received_by', 'Received By'),
    ('assessed_by_processed', 'Payment Processed By'),
    ('archived_at', 'Archived At'),
]


def _format_archived_datetime(key, value):
    """Best-effort readable formatting for the ISO date/datetime strings
    stored inside the JSON snapshot — falls back to the raw string if it
    isn't parseable, since the snapshot is the source of truth, not this
    formatting layer."""
    if not isinstance(value, str) or not value:
        return value
    if key not in ('date_issued', 'created_at', 'updated_at', 'assessed_at', 'date_paid'):
        return value
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return value
    if key == 'date_paid':
        return dt.strftime('%Y-%m-%d')
    if 'T' not in value:
        return dt.strftime('%Y-%m-%d')
    return _to_manila(dt).strftime('%Y-%m-%d %H:%M:%S')


def _archived_payment_processor_name(assessment):
    """'Payment Processed By' for an archived record = the PAYMENT CONFIRMER.

    Event-time confirmer snapshot first; else the confirmer's name as stored
    at archive time (unverified fallback). It NEVER reads the assessor
    (assessment['assessed_by_name'] / assessor_*): legacy code overwrote the
    assessor FK with the payment confirmer, and the assessor must not reach
    an archived export. A legacy row with no provable confirmer is blank.
    """
    if not assessment:
        return ''
    ident = resolve_historical_identity(
        name=assessment.get('payment_confirmer_name_snapshot'),
        role=assessment.get('payment_confirmer_role_snapshot'),
        source=assessment.get('payment_confirmer_snapshot_source'),
        live_user=SimpleNamespace(full_name=assessment.get('payment_confirmed_by_name')),
    )
    return ident['name'] or ''


def _resolve_archived_row(archived, columns):
    """Builds one export row (dict of key -> value) for an ArchivedViolation
    instance, reading exclusively from its frozen `data` snapshot (plus the
    ArchivedViolation row itself for `archived_at`) — never from the active
    Violation table, which no longer holds this record."""
    data = archived.data or {}
    assessment = data.get('assessment') or {}
    row = {}
    for key, _label in columns:
        if key == 'violation_types':
            row[key] = ', '.join(i.get('name', '') for i in data.get('items', []) if i.get('name'))
        elif key == 'enforcer_name':
            row[key] = resolve_historical_identity(
                name=data.get('enforcer_name_snapshot'),
                source=data.get('enforcer_snapshot_source'),
                live_user=SimpleNamespace(full_name=data.get('enforcer_name')),
            )['name'] or ''
        elif key in ('status', 'license_status', 'assessed_by_name'):
            row[key] = data.get(key, '')
        elif key in ('or_number', 'amount_paid', 'received_by', 'date_paid'):
            row[key] = _format_archived_datetime(key, _format_value(assessment.get(key)))
        elif key == 'assessed_by_processed':
            row[key] = _archived_payment_processor_name(assessment)
        elif key == 'archived_at':
            row[key] = _format_value(archived.archived_at)
        else:
            row[key] = _format_archived_datetime(key, _format_value(data.get(key)))
    return row


def get_archived_export_columns():
    """
    Column list for the Archived Records export specifically. Same base
    columns as get_exportable_columns() (shared with the active Full
    Database Export) plus ARCHIVED_PRESERVATION_COLUMNS, but with
    'assessed_by_name' ("Assessed By") excluded.

    Archive confidentiality: who *assessed* a violation must not leak
    into the archived export or its pre-export field preview, once a
    record is archived. This is distinct from 'assessed_by_processed'
    ("Payment Processed By", Assessment.assessed_by — who recorded the
    payment), which is preserved. The active Full Database Export and
    requirement #9's My Reports are untouched — they call
    get_exportable_columns() directly and still include Assessed By.

    Single source of truth for both build_archived_export_workbook and
    ArchivedExportFieldsView, so the pre-export preview and the actual
    generated file can never drift apart.
    """
    base = [c for c in get_exportable_columns() if c[0] != 'assessed_by_name']
    return base + ARCHIVED_PRESERVATION_COLUMNS


def build_archived_export_workbook(year=None):
    """
    Reads ArchivedViolation records (optionally filtered to one archive
    `year`) and returns an openpyxl Workbook — same column-discovery and
    cell-safety pipeline as the active export, plus payment/preservation
    columns unique to archived records. Read-only: never touches active
    data, and never mutates or deletes the archive it reads from.
    """
    import openpyxl
    from openpyxl.utils import get_column_letter

    columns = get_archived_export_columns()

    # Checkpoint 2: Asia/Manila year of date_issued, duplicate snapshots
    # removed, newest violation first (same rule as the archive browser).
    qs = archived_in_period(deduped_archived(), year=year)
    records = list(qs.order_by('-date_issued', '-pk'))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f'Archived {year}' if year else 'Archived Records Export'

    for col_num, (_key, label) in enumerate(columns, 1):
        ws[f'{get_column_letter(col_num)}1'] = label
        ws[f'{get_column_letter(col_num)}1'].font = openpyxl.styles.Font(bold=True)

    row_num = 2
    for a in records:
        row = _resolve_archived_row(a, columns)
        for col_num, (key, _label) in enumerate(columns, 1):
            ws.cell(row=row_num, column=col_num, value=_sanitize_cell(row[key]))
        row_num += 1

    return wb, len(records)


def build_full_export_workbook():
    """
    Reads every active Violation record and returns an openpyxl Workbook
    containing the full, currently-active dataset. Read-only — never
    mutates active records (PART 9: EXPORT = COPY, never MOVE).
    """
    import openpyxl
    from openpyxl.utils import get_column_letter

    columns = get_exportable_columns()

    violations = (
        Violation.objects
        .select_related('enforcer', 'imported_by', 'assessment', 'assessment__assessed_by')
        .prefetch_related('items__violation_type')
        .all()
    )

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Full Database Export'

    for col_num, (_key, label) in enumerate(columns, 1):
        ws[f'{get_column_letter(col_num)}1'] = label
        ws[f'{get_column_letter(col_num)}1'].font = openpyxl.styles.Font(bold=True)

    row_num = 2
    for v in violations:
        row = _resolve_row(v, columns)
        for col_num, (key, _label) in enumerate(columns, 1):
            ws.cell(row=row_num, column=col_num, value=_sanitize_cell(row[key]))
        row_num += 1

    return wb, violations.count()


# ─────────────────────────────────────────────────────────────────────────
# PDF EXPORT DATA (read-only)
#
# The PDF itself is drawn client-side (jsPDF). These two builders return the
# SAME resolved rows the legacy Excel export builds — same column discovery,
# same identity resolution (enforcer_identity / assessor_identity /
# resolve_historical_identity), same Archived-export exclusion of
# "Assessed By" — as plain JSON, with no spreadsheet-only cell sanitising
# (a leading "=" is harmless in a PDF, and an apostrophe would be a lie).
# Values are JSON-safe: missing → '', true zero stays 0.0, False stays False.
# ─────────────────────────────────────────────────────────────────────────

def _payload(columns, rows):
    return {
        'columns': [{'key': key, 'label': label} for key, label in columns],
        'records': rows,
        'record_count': len(rows),
    }


def build_full_pdf_payload():
    """Every active Violation, resolved exactly as the Full Database Export
    resolves it (36 fields). Read-only."""
    columns = get_exportable_columns()
    violations = (
        Violation.objects
        .select_related('enforcer', 'imported_by', 'assessment', 'assessment__assessed_by')
        .prefetch_related('items__violation_type')
        .all()
    )
    return _payload(columns, [_resolve_row(v, columns) for v in violations])


def build_archived_pdf_payload(year=None):
    """Archived snapshots (optionally one violation year), resolved exactly as
    the Archived Records Export resolves them (41 fields; 'Assessed By' is
    excluded). Nothing is reconstructed from live tables: a field the frozen
    snapshot does not hold stays blank. Read-only."""
    columns = get_archived_export_columns()
    qs = archived_in_period(deduped_archived(), year=year)
    records = qs.order_by('-date_issued', '-pk')
    return _payload(columns, [_resolve_archived_row(a, columns) for a in records])