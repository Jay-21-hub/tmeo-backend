"""Reports service layer: one query/builder function per report."""
from django.utils import timezone

from .builders import (
    build_by_type, build_enforcer, build_location, build_monthly,
    build_outstanding, build_status, build_vehicle_type,
)
from .filters import SUPPORTED_FILTERS, FilterError, ReportFilters

REPORTS = {
    'status':       {'title': 'Violations by Status',   'build': build_status,
                     'scope': 'Active + archived records'},
    'monthly':      {'title': 'Monthly Violations',     'build': build_monthly,
                     'scope': 'Active + archived records'},
    'by_type':      {'title': 'Violations by Type',     'build': build_by_type,
                     'scope': 'Active + archived records'},
    'enforcer':     {'title': 'Enforcer Activity',      'build': build_enforcer,
                     'scope': 'Active + archived records'},
    'outstanding':  {'title': 'Outstanding Penalties',  'build': build_outstanding,
                     'scope': 'Active records only (unpaid tickets are never archived)'},
    'location':     {'title': 'Violations by Location', 'build': build_location,
                     'scope': 'Active + archived records'},
    'vehicle_type': {'title': 'Violations by Vehicle Type', 'build': build_vehicle_type,
                     'scope': 'Active + archived records'},
}
# Pre-redesign report ids still accepted by the API.
LEGACY_ALIASES = {'enforcer_activity': 'enforcer'}


def generate_report(report_id, params, user):
    report_id = LEGACY_ALIASES.get(report_id, report_id)
    if report_id not in REPORTS:
        raise FilterError(f'Invalid report type. Choose one of: {", ".join(REPORTS)}.')
    filters = ReportFilters(report_id, params)
    spec = REPORTS[report_id]
    body = spec['build'](filters)
    now = timezone.localtime()
    return {
        'meta': {
            'report': report_id, 'title': spec['title'], 'scope': spec['scope'],
            'generated_at': now.isoformat(timespec='seconds'),
            'generated_by': getattr(user, 'full_name', '') or getattr(user, 'email', ''),
            'filters_applied': filters.applied(),
            'supported_filters': SUPPORTED_FILTERS[report_id],
            'columns': body['columns'], 'notes': body['notes'],
            'record_count': len(body['rows']),
        },
        'summary': body['summary'],
        'rows': body['rows'],
    }