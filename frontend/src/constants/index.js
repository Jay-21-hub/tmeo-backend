export const ROLES = {
  ADMIN: 'admin',
  STAFF: 'staff',
  ENFORCER: 'enforcer',
}

export const API = {
  LOGIN:           '/api/auth/login/',
  REFRESH:         '/api/auth/token/refresh/',
  CHANGE_PASSWORD: '/api/auth/change-password/',
  FORGOT_PASSWORD: '/api/auth/forgot-password/',
  ME:              '/api/auth/me/',
  USERS:           '/api/auth/users/',
  DUTY_STATUS:     '/api/auth/duty-status/',
  VIOLATIONS:      '/api/violations/',
  VIOLATION_TYPES: '/api/violations/types/',
  // Role-aware counts. For an enforcer the backend scopes every count to
  // their OWN records, so the enforcer home can show real totals instead
  // of counting whatever happened to be on the first page of a list.
  VIOLATION_STATS: '/api/violations/stats/',
  VEHICLE_BRANDS:  '/api/violations/vehicle-brands/',
  SCAN_LICENSE:    '/api/violations/scan-license/',
  VIOLATOR_HISTORY_FULL: '/api/violations/violator-history-full/',
  VIOLATION_RELATED_ACTIVE: (id) => `/api/violations/${id}/related/`,
  VIOLATION_ASSESSMENT: (id) => `/api/violations/${id}/assessment/`,
  // Flat evidence endpoints — evidence is captured standalone (not nested
  // under a Violation/OVR) and associated to one afterwards.
  EVIDENCE:            '/api/violations/evidence/',
  EVIDENCE_ASSOCIATE:  (evidenceId) => `/api/violations/evidence/${evidenceId}/`,
  MARK_TICKET_PRINTED: (id) => `/api/violations/tickets/${id}/mark-printed/`,
  CONFIRM_PAYMENT:     (id) => `/api/violations/${id}/confirm-payment/`,
  // Confiscated Licenses (custody) — Admin + Staff only (Stage B backend).
  // `key` is the backend record key: "v<id>" (active) or "a<id>" (archived).
  CUSTODY_LIST:        '/api/violations/confiscated-licenses/',
  CUSTODY_SUMMARY:     '/api/violations/confiscated-licenses/summary/',
  CUSTODY_DETAIL:      (key) => `/api/violations/confiscated-licenses/${encodeURIComponent(key)}/`,
  CUSTODY_TIMELINE:    (key) => `/api/violations/confiscated-licenses/${encodeURIComponent(key)}/timeline/`,
  CUSTODY_MARK_READY:  (key) => `/api/violations/confiscated-licenses/${encodeURIComponent(key)}/mark-ready/`,
  CUSTODY_RELEASE:     (key) => `/api/violations/confiscated-licenses/${encodeURIComponent(key)}/release/`,
  CUSTODY_VERIFY:      (key) => `/api/violations/confiscated-licenses/${encodeURIComponent(key)}/verify-document-type/`,
  CUSTODY_CORRECT:     (key) => `/api/violations/confiscated-licenses/${encodeURIComponent(key)}/correct/`,
  ENFORCERS:       '/api/enforcers/',
  SCHEDULES:       '/api/enforcers/schedules/',
  MY_SCHEDULE:     '/api/enforcers/my-schedule/',
  LOCATION:        '/api/enforcers/update-location/',
  TODAY_STATUS:    '/api/enforcers/today-status/',
  REPORTS:         '/api/reports/',
  AUDIT:           '/api/audit/',
  NOTIFICATIONS:   '/api/notifications/',
  DB_EXPORT_FIELDS: '/api/database/export/fields/',
  DB_EXPORT_FULL:   '/api/database/export/full/',
  // PDF export data (Admin-only, read-only). The PDF is drawn in the browser.
  // DB_EXPORT_FULL / ARCHIVE_EXPORT above are the legacy .xlsx endpoints,
  // kept on the backend but no longer wired to any Admin screen.
  DB_EXPORT_FULL_PDF_DATA: '/api/database/export/full/pdf-data/',
  ARCHIVE_OVERVIEW: '/api/database/archive/overview/',
  ARCHIVE_EXECUTE:  '/api/database/archive/execute/',
  ARCHIVE_YEARS:    '/api/database/archive/years/',
  ARCHIVE_MONTHS:   '/api/database/archive/months/',
  ARCHIVE_RECORDS:  '/api/database/archive/records/',
  ARCHIVE_BATCHES:  '/api/database/archive/batches/',
  ARCHIVE_EXPORT_FIELDS: '/api/database/archive/export/fields/',
  ARCHIVE_EXPORT:        '/api/database/archive/export/',
  ARCHIVE_EXPORT_PDF_DATA: '/api/database/archive/export/pdf-data/',
}

export const VIOLATION_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  PAID: 'paid',
}