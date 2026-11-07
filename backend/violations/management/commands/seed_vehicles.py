"""
Management command: python manage.py seed_vehicles

Why this exists
---------------
Migration 0016 seeded the vehicle catalog before categories existed, and
migration 0021 then gave every row without a linked type the default
category 'car'. Result: motorcycles such as Honda XRM 125 or Yamaha Mio sit
under "Cars", the other categories are empty, and the Vehicle Type dropdown
in Issue OVR only offers "Cars".

What it does
------------
  1. Adds the vehicles most commonly apprehended in Lucena City that are
     missing: motorcycles, tricycles, cars/pickups, vans, jeepneys, buses,
     trucks, and light electric vehicles.
  2. Moves rows that already exist into the correct category (this is what
     repairs the motorcycles stuck under "Cars"). Every move is printed.
     Run with --keep-existing to skip this and only add missing rows.

Safe to run more than once. Nothing is deleted, and is_active is never
changed. Everything can be edited afterwards from the admin
"Manage Vehicle Catalog" screen.
"""
from django.core.management.base import BaseCommand
from violations.models import VehicleBrandModel

M, C, P, T, S = 'motorcycle', 'car', 'puv', 'truck', 'special'

# (category, brand, [models])
# Spellings follow the rows migration 0016 already created, so existing rows
# are matched (and re-categorised) instead of duplicated.
CATALOG = [
    # ── Motorcycles ────────────────────────────────────────────────────
    (M, 'Honda', ['XRM 125', 'Click 125i', 'Click 160', 'Beat', 'Genio', 'TMX 125', 'TMX 155', 'Wave 110',
                  'CBR150R', 'RS 125', 'ADV 160', 'PCX 160']),
    (M, 'Yamaha', ['Mio Sporty', 'Mio i125', 'Mio Gear', 'Mio Soul i125', 'Fazzio', 'NMAX', 'Aerox 155',
                   'Sniper 155', 'YTX 125']),
    (M, 'Suzuki', ['Raider R150', 'Smash 115', 'Skydrive', 'Burgman Street', 'Gixxer SF 150']),
    (M, 'Kawasaki', ['Barako', 'Rouser NS160', 'Rouser 200', 'Rouser 135', 'Ninja 400']),
    (M, 'Rusi', ['Classic 250']),
    (M, 'Bajaj', ['Pulsar 200NS', 'Dominar 400']),

    # ── Cars, SUVs, pickups ────────────────────────────────────────────
    (C, 'Toyota', ['Vios', 'Wigo', 'Avanza', 'Rush', 'Raize', 'Innova', 'Fortuner', 'Hilux',
                   'Corolla Altis', 'Corolla Cross']),
    (C, 'Mitsubishi', ['Mirage', 'Mirage G4', 'Xpander', 'Montero Sport', 'Adventure', 'Strada']),
    (C, 'Honda', ['City', 'Civic', 'Brio', 'Jazz', 'BR-V', 'CR-V', 'HR-V']),
    (C, 'Nissan', ['Almera', 'Navara', 'Terra']),
    (C, 'Suzuki', ['Ertiga', 'APV', 'Celerio', 'Dzire', 'Jimny']),
    (C, 'Ford', ['Ranger', 'Everest', 'EcoSport']),
    (C, 'Isuzu', ['D-Max', 'mu-X']),
    (C, 'Hyundai', ['Accent', 'Reina', 'Starex', 'Tucson']),
    (C, 'Kia', ['Picanto', 'Soluto']),
    (C, 'Mazda', ['Mazda3', 'CX-5']),

    # ── Public utility vehicles ────────────────────────────────────────
    (P, 'Tricycle', ['Honda TMX 155', 'Honda TMX Supremo', 'Kawasaki Barako', 'Kawasaki Barako II',
                     'Yamaha YTX 125', 'Suzuki GD110']),
    (P, 'Jeepney', ['Traditional', 'Modern']),
    (P, 'Toyota', ['Hiace Commuter', 'Hiace GL Grandia']),
    (P, 'Nissan', ['NV350 Urvan']),
    (P, 'Mitsubishi', ['L300 FB']),
    (P, 'Bus', ['City Bus', 'Provincial Bus']),

    # ── Trucks & heavy vehicles ────────────────────────────────────────
    (T, 'Mitsubishi', ['L300']),
    (T, 'Isuzu', ['Elf', 'Forward', 'Giga']),
    (T, 'Hino', ['300 Series', '500 Series']),
    (T, 'Mitsubishi Fuso', ['Canter', 'Fighter']),
    (T, 'Suzuki', ['Carry']),
    (T, 'Foton', ['Tornado']),
    (T, 'Hyundai', ['H-100']),
    (T, 'Truck', ['Cargo Truck', 'Dump Truck', 'Trailer Truck']),

    # ── Special / other ────────────────────────────────────────────────
    (S, 'Others', ['E-Trike', 'E-Bike', 'Kuliglig', 'Pedicab', 'Farm Tractor']),
    (S, 'Other', ['Other / Not Listed']),
]


class Command(BaseCommand):
    help = "Seed the vehicle catalog with commonly apprehended vehicles and fix mis-filed categories"

    def add_arguments(self, parser):
        parser.add_argument(
            '--keep-existing', action='store_true',
            help="Only add missing rows; don't move existing rows to the correct category.",
        )

    def handle(self, *args, **options):
        keep_existing = options['keep_existing']
        created, moved, unchanged = 0, [], 0

        for category, brand, models in CATALOG:
            for model in models:
                obj, was_created = VehicleBrandModel.objects.get_or_create(
                    brand=brand, model=model,
                    defaults={'category': category, 'is_active': True},
                )
                if was_created:
                    created += 1
                elif obj.category != category and not keep_existing:
                    moved.append(f"{brand} {model}: {obj.category} -> {category}")
                    obj.category = category
                    obj.save(update_fields=['category'])
                else:
                    unchanged += 1

        for line in moved:
            self.stdout.write(f"  moved  {line}")
        self.stdout.write(self.style.SUCCESS(
            f"Done — {created} added, {len(moved)} moved to the right category, {unchanged} unchanged. "
            f"Catalog now has {VehicleBrandModel.objects.count()} rows."
        ))