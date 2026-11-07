"""
Admin bulk import of historical violations (Excel .xlsx) — validation layer.

Business rules (approved):
  * ADMIN ONLY (enforced by the view's permission class).
  * .xlsx ONLY (.xlsm/macros rejected).
  * ALL-OR-NOTHING: any blocking error → nothing is saved.
  * PAID rows are rejected — settlement needs an Assessment/O.R. record that a
    spreadsheet cannot supply. Allowed statuses: pending, processing.
  * Dates: a real Excel date cell, or the text form YYYY-MM-DD ONLY. Text such
    as 03/04/2026 is ambiguous (US vs PH day-first) and is rejected.
  * Duplicates (same date + plate + violator + set of violation codes) are
    blocking, both inside the file and against existing active/archived
    records.
  * Imported records: enforcer = NULL, source = 'imported', imported_by =
    uploader. Their ViolationItem rows get NO item-level penalty (the 0
    snapshot is a placeholder → treated as UNAVAILABLE by Reports); the
    ticket-level penalty_amount from the sheet is what is stored.
"""
import datetime
import io
import re
import zipfile
from decimal import Decimal, InvalidOperation

from django.db.models.functions import Upper
from django.utils import timezone

from database_management.models import ArchivedViolation

from .models import Violation, ViolationType

MAX_FILE_BYTES = 2 * 1024 * 1024      # 2 MB
MAX_ROWS = 1000
MIN_YEAR = 2000
PREVIEW_ROWS = 50

REQUIRED_COLS = ['date_issued', 'plate_number', 'violator_name', 'violation_codes', 'penalty_amount']
OPTIONAL_COLS = ['license_number', 'location', 'address', 'vehicle_type', 'status', 'remarks']
ALL_COLS = REQUIRED_COLS + OPTIONAL_COLS
ALLOWED_STATUSES = ['pending', 'processing']

_ISO = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_WS = re.compile(r'\s+')
_MAX_LEN = {'plate_number': 20, 'violator_name': 200, 'license_number': 50,
            'location': 300, 'vehicle_type': 100}


class ImportFileError(Exception):
    """Whole-file problem (bad type, too big, missing columns…) → HTTP 400."""


def _norm(s):
    return _WS.sub(' ', (s or '')).strip()


def _text(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return _norm(str(v))


def read_workbook(file):
    """Returns (headers_lower, [(excel_row_number, {col: raw_value})])."""
    name = (file.name or '').lower()
    if not name.endswith('.xlsx'):
        raise ImportFileError('Only Excel (.xlsx) files are accepted.')
    if file.size > MAX_FILE_BYTES:
        raise ImportFileError(f'File is too large (max {MAX_FILE_BYTES // (1024 * 1024)} MB).')
    data = file.read()
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise ImportFileError('Could not read the Excel file. Make sure it is a valid .xlsx file.')
    import openpyxl
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        header = next(it, None)
        if header is None or not any(h is not None and str(h).strip() for h in header):
            raise ImportFileError('Excel file is empty or has no headers.')
        headers = [str(h).strip().lower() if h is not None else '' for h in header]
        present = [h for h in headers if h]
        if len(present) != len(set(present)):
            raise ImportFileError('Duplicate column headers found. Each column name must appear once.')
        missing = [c for c in REQUIRED_COLS if c not in present]
        if missing:
            raise ImportFileError(f'Missing required columns: {", ".join(sorted(missing))}')
        rows = []
        for n, values in enumerate(it, start=2):
            if values is None or all(v is None or (isinstance(v, str) and not v.strip()) for v in values):
                continue
            if len(rows) >= MAX_ROWS:
                raise ImportFileError(f'Too many rows (max {MAX_ROWS} per import). Split the file and import in parts.')
            rows.append((n, {h: (values[i] if i < len(values) else None)
                             for i, h in enumerate(headers) if h in ALL_COLS}))
    except ImportFileError:
        raise
    except Exception:
        raise ImportFileError('Could not read the Excel file. Make sure it is a valid .xlsx file.')
    if not rows:
        raise ImportFileError('The file has headers but no data rows.')
    ignored = sorted(set(present) - set(ALL_COLS))
    return present, rows, ignored


def _parse_date(raw, today):
    if isinstance(raw, datetime.datetime):
        d = raw.date()
    elif isinstance(raw, datetime.date):
        d = raw
    else:
        s = _text(raw)
        if not s:
            raise ValueError('date_issued is required.')
        if not _ISO.match(s):
            raise ValueError(f"date_issued '{s}' is not accepted. Use a real Excel date or the text format YYYY-MM-DD.")
        try:
            d = datetime.date.fromisoformat(s)
        except ValueError:
            raise ValueError(f"date_issued '{s}' is not a valid calendar date.")
    if d > today:
        raise ValueError(f'date_issued {d.isoformat()} is in the future.')
    if d.year < MIN_YEAR:
        raise ValueError(f'date_issued {d.isoformat()} is before {MIN_YEAR}.')
    return d


def _parse_money(raw):
    s = _text(raw).replace(',', '')
    if not s:
        raise ValueError('penalty_amount is required.')
    try:
        amt = Decimal(s)
    except InvalidOperation:
        raise ValueError(f"penalty_amount '{_text(raw)}' is not a valid number.")
    if not amt.is_finite() or amt < 0:
        raise ValueError(f"penalty_amount '{_text(raw)}' must be a non-negative number.")
    if amt >= Decimal('100000000'):          # check magnitude BEFORE quantize (1e50 would raise)
        raise ValueError('penalty_amount is too large.')
    return amt.quantize(Decimal('0.01'))


def _dup_key(d, plate, violator, codes):
    return (d, plate.upper(), _norm(violator).casefold(), frozenset(codes))


def _existing_duplicates(candidates):
    """candidates: {dup_key: first_row_number}. Returns {dup_key: 'label'} for keys that
    already exist in the active table or the archive."""
    if not candidates:
        return {}
    dates = {k[0] for k in candidates}
    plates = {k[1] for k in candidates}
    found = {}
    active = (Violation.objects.annotate(_p=Upper('plate_number'))
              .filter(date_issued__date__in=dates, _p__in=plates)
              .prefetch_related('items__violation_type'))
    for v in active:
        k = _dup_key(timezone.localtime(v.date_issued).date(), v.plate_number, v.violator_name,
                     [i.violation_type.code.upper() for i in v.items.all()])
        if k in candidates:
            found[k] = f'existing record #{v.id}'
    archived = (ArchivedViolation.objects.annotate(_p=Upper('plate_number'))
                .filter(date_issued__date__in=dates, _p__in=plates))
    for a in archived:
        codes = [(i.get('code') or '').upper() for i in (a.data or {}).get('items', [])]
        k = _dup_key(timezone.localtime(a.date_issued).date(), a.plate_number, a.violator_name, codes)
        if k in candidates:
            found[k] = f'archived record (original #{a.original_violation_id})'
    return found


def validate(file):
    """Full validation. Returns dict with valid rows (python objects), JSON-safe
    preview rows, and blocking errors. Never touches the DB for writes."""
    headers, raw_rows, ignored = read_workbook(file)
    today = timezone.localdate()
    vtypes = {vt.code.upper(): vt for vt in ViolationType.objects.filter(is_active=True)}

    errors, valid = [], []
    seen = {}
    for n, raw in raw_rows:
        errs = []
        get = lambda k: _text(raw.get(k))

        try:
            d = _parse_date(raw.get('date_issued'), today)
        except ValueError as e:
            errs.append(str(e)); d = None

        plate = get('plate_number').upper()
        if not plate:
            errs.append('plate_number is required.')
        violator = get('violator_name')
        if not violator:
            errs.append('violator_name is required.')
        for col, limit in _MAX_LEN.items():
            if len(get(col)) > limit:
                errs.append(f'{col} is too long (max {limit} characters).')

        try:
            amount = _parse_money(raw.get('penalty_amount'))
        except ValueError as e:
            errs.append(str(e)); amount = None

        status = get('status').lower() or 'pending'
        if status == 'paid':
            errs.append('Paid rows cannot be bulk-imported. Settlement requires an assessment and O.R. number '
                        'recorded by Staff — import the ticket as pending or processing instead.')
        elif status not in ALLOWED_STATUSES:
            errs.append(f"status '{status}' is invalid. Allowed: {', '.join(ALLOWED_STATUSES)}.")

        codes = [c.strip().upper() for c in get('violation_codes').split(',') if c.strip()]
        types = []
        if not codes:
            errs.append('violation_codes is required.')
        if len(codes) != len(set(codes)):
            errs.append('violation_codes contains the same code more than once.')
        for c in dict.fromkeys(codes):
            if c in vtypes:
                types.append(vtypes[c])
            else:
                errs.append(f"Violation code '{c}' does not exist or is inactive.")

        key = None
        if not errs:
            key = _dup_key(d, plate, violator, codes)
            if key in seen:
                errs.append(f'Duplicate of row {seen[key]} in this file (same date, plate, violator and violation codes).')
            else:
                seen[key] = n

        if errs:
            errors.append({'row': n, 'errors': errs,
                           'data': {k: _text(v) if not isinstance(v, (datetime.date, datetime.datetime))
                                    else v.strftime('%Y-%m-%d') for k, v in raw.items()}})
            continue

        valid.append({
            'row': n, 'key': key, 'date_issued': d, 'plate_number': plate, 'violator_name': violator,
            'license_number': get('license_number'), 'address': get('address'),
            'vehicle_type': get('vehicle_type'), 'location': get('location'),
            'remarks': get('remarks'), 'penalty_amount': amount, 'status': status, 'vtypes': types,
        })

    # Duplicates against existing records (one bounded query per source).
    dups = _existing_duplicates({r['key']: r['row'] for r in valid})
    if dups:
        still_valid = []
        for r in valid:
            if r['key'] in dups:
                errors.append({'row': r['row'], 'errors': [
                    f'Duplicate of {dups[r["key"]]} (same date, plate, violator and violation codes).'],
                    'data': {'plate_number': r['plate_number'], 'violator_name': r['violator_name'],
                             'date_issued': r['date_issued'].isoformat()}})
            else:
                still_valid.append(r)
        valid = still_valid
    errors.sort(key=lambda e: e['row'])

    preview = [{
        'row': r['row'], 'date_issued': r['date_issued'].isoformat(), 'plate_number': r['plate_number'],
        'violator_name': r['violator_name'], 'location': r['location'],
        'penalty_amount': str(r['penalty_amount']), 'status': r['status'],
        'violation_codes': [t.code for t in r['vtypes']],
        'violation_names': [t.name for t in r['vtypes']],
    } for r in valid[:PREVIEW_ROWS]]

    return {
        'headers': headers, 'ignored_columns': ignored,
        'valid': valid, 'preview_rows': preview, 'errors': errors,
        'total_rows': len(raw_rows),
    }