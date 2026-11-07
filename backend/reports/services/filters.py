"""Query-parameter parsing/validation for report generation."""
import datetime

from violations.models import Violation, ViolationType

# Which optional filters each report actually supports. The frontend reads
# the same map (via meta.supported_filters) so it never shows a control the
# backend would ignore.
SUPPORTED_FILTERS = {
    'status':       [],
    'monthly':      ['status'],
    'by_type':      ['status', 'category', 'vehicle_type'],
    'enforcer':     ['status'],
    'outstanding':  ['vehicle_type'],
    'location':     ['status'],
    'vehicle_type': ['status'],
}

VALID_STATUS = [v for v, _ in Violation.Status.choices]
VALID_CATEGORY = [v for v, _ in ViolationType.Category.choices]
UNPAID_STATUS = ['pending', 'processing']
MAX_RANGE_DAYS = 3660  # ~10 years; guards against absurd ranges


class FilterError(ValueError):
    pass


class ReportFilters:
    def __init__(self, report_id, params):
        supported = SUPPORTED_FILTERS[report_id]
        get = lambda k: (params.get(k) or '').strip()

        self.date_from = self._date('date_from', get('date_from'))
        self.date_to = self._date('date_to', get('date_to'))
        if self.date_from and self.date_to:
            if self.date_from > self.date_to:
                raise FilterError('date_from must not be later than date_to.')
            if (self.date_to - self.date_from).days > MAX_RANGE_DAYS:
                raise FilterError('The selected date range is too large.')

        self.status = self._choice('status', get('status').lower(), VALID_STATUS) \
            if 'status' in supported else ''
        self.category = self._choice('category', get('category').lower(), VALID_CATEGORY) \
            if 'category' in supported else ''
        self.vehicle_type = get('vehicle_type')[:100] if 'vehicle_type' in supported else ''

    @staticmethod
    def _date(name, value):
        if not value:
            return None
        try:
            return datetime.date.fromisoformat(value)
        except ValueError:
            raise FilterError(f'{name} must be a valid YYYY-MM-DD date.')

    @staticmethod
    def _choice(name, value, valid):
        if not value:
            return ''
        if value not in valid:
            raise FilterError(f'{name} must be one of: {", ".join(valid)}.')
        return value

    def applied(self):
        """Only filters that were really applied — echoed back in meta and
        printed on the PDF, so what the user sees is what was queried."""
        out = {}
        if self.date_from:
            out['date_from'] = self.date_from.isoformat()
        if self.date_to:
            out['date_to'] = self.date_to.isoformat()
        for k in ('status', 'category', 'vehicle_type'):
            if getattr(self, k):
                out[k] = getattr(self, k)
        return out