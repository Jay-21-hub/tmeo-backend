"""
Management command: python manage.py seed_violations
Seeds ViolationType from the official TMEO violation list.
Run once after migration.
"""
from django.core.management.base import BaseCommand
from violations.models import ViolationType


VIOLATIONS = [
    # (code, name, category, penalty)
    # ── SAFETY VIOLATIONS ──────────────────────────────────────────────
    ("SV-01", "No Helmet (Driver)",                          "safety",  500),
    ("SV-02", "No Helmet (Passenger)",                       "safety",  500),
    ("SV-03", "Overloading of Passengers",                   "safety",  500),
    ("SV-04", "No Side Mirror",                              "safety",  500),
    ("SV-05", "Defective Lights / No Lights",                "safety",  500),
    ("SV-06", "Defective Brakes",                            "safety", 1000),
    ("SV-07", "No Rearview Mirror",                          "safety",  500),
    ("SV-08", "Overloading of Cargo",                        "safety",  500),
    ("SV-09", "Unsecured Cargo",                             "safety",  500),
    ("SV-10", "No Seatbelt (Driver)",                        "safety",  500),
    ("SV-11", "No Seatbelt (Passenger)",                     "safety",  500),
    ("SV-12", "Child not in Child Restraint System",         "safety", 1000),
    # ── TRAFFIC VIOLATIONS ─────────────────────────────────────────────
    ("TV-01", "Beating Red Light",                           "traffic", 1000),
    ("TV-02", "Illegal Parking",                             "traffic",  500),
    ("TV-03", "Obstruction of Traffic",                      "traffic",  500),
    ("TV-04", "Illegal U-Turn",                              "traffic",  500),
    ("TV-05", "Overspeeding",                                "traffic", 1000),
    ("TV-06", "Reckless Driving",                            "traffic", 2000),
    ("TV-07", "Driving Under the Influence (DUI)",           "traffic", 5000),
    ("TV-08", "Counterflow",                                 "traffic", 1000),
    ("TV-09", "No Operator's Permit (NOP)",                  "traffic",  500),
    ("TV-10", "No Driver's License",                         "traffic", 1500),
    ("TV-11", "Expired Driver's License",                    "traffic",  500),
    ("TV-12", "Expired Registration",                        "traffic", 1000),
    ("TV-13", "No OR/CR",                                    "traffic",  500),
    ("TV-14", "Tampered / No Plate Number",                  "traffic", 1000),
    ("TV-15", "Illegal Coding Violation",                    "traffic",  500),
    ("TV-16", "Wrong Lane / Improper Lane Change",           "traffic",  500),
    ("TV-17", "Failure to Give Way to Pedestrian",           "traffic",  500),
    ("TV-18", "Illegal Loading / Unloading",                 "traffic",  500),
    ("TV-19", "Disobeying Traffic Signs / Signals",          "traffic",  500),
    ("TV-20", "Use of Mobile Phone While Driving",           "traffic", 1000),
    # ── OTHER ──────────────────────────────────────────────────────────
    ("OV-01", "Smoke Belching",                              "other",   500),
    ("OV-02", "No MVIS Sticker",                             "other",   500),
    ("OV-03", "Unauthorized Use of Siren / Blinkers",        "other",  2000),
    ("OV-04", "Tinted Windows Beyond Legal Limit",           "other",   500),
    ("OV-05", "Modified Exhaust (Loud Muffler)",             "other",   500),
]


class Command(BaseCommand):
    help = "Seed ViolationType records from the official TMEO list"

    def handle(self, *args, **options):
        created = 0
        updated = 0
        for code, name, category, penalty in VIOLATIONS:
            obj, was_created = ViolationType.objects.update_or_create(
                code=code,
                defaults=dict(name=name, category=category, penalty_amount=penalty, is_active=True)
            )
            if was_created:
                created += 1
            else:
                updated += 1

        self.stdout.write(self.style.SUCCESS(
            f"Done — {created} created, {updated} updated. Total: {created + updated} violation types."
        ))