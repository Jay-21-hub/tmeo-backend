"""
Location canonicalisation for the Reports module.

Rules (approved business rules):
  * Trim + collapse whitespace + case-insensitive match (same as Analytics).
  * A CONTROLLED alias table folds known duplicates into one canonical
    location. Nothing else is merged: "X" and "X, Lucena" are NOT assumed to
    be the same place unless listed here. Add a row only after a human has
    confirmed the two spellings are the same physical location.
  * Blank / punctuation-only locations are reported as "Unspecified"
    (never silently dropped, so report totals always reconcile).

NOTE: Analytics (violations/analytics.py) intentionally does NOT apply this
alias table and keeps "Perez Park" and "Perez Park, Lucena" separate. Only
Reports merges them.
"""
from violations.analytics import clean_location, location_key

UNSPECIFIED = 'Unspecified'

# alias (lower-cased, whitespace-collapsed)  ->  canonical display name
LOCATION_ALIASES = {
    'perez park': 'Perez Park',
    'perez park, lucena': 'Perez Park',
}


def canonical_location(raw):
    """Return (key, display). `key` is what rows are grouped on."""
    cleaned = clean_location(raw)
    if not cleaned:
        return ('', UNSPECIFIED)
    key = location_key(cleaned)
    if key in LOCATION_ALIASES:
        display = LOCATION_ALIASES[key]
        return (display.casefold(), display)
    return (key, cleaned)