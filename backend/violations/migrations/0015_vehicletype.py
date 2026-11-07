from django.db import migrations, models


SEED = [
    # (category, name, examples)
    ('motorcycle', 'Scooter', ''),
    ('motorcycle', 'Underbone', 'Honda XRM, Yamaha Mio'),
    ('motorcycle', 'Sportsbike', ''),
    ('motorcycle', 'Cruiser', ''),
    ('motorcycle', 'Dirt Bike / Trail', ''),
    ('motorcycle', 'Big Bike (400cc+)', ''),

    ('car', 'Sedan', 'Toyota Vios, Honda City'),
    ('car', 'Hatchback', 'Toyota Wigo, Honda Brio'),
    ('car', 'SUV', 'Ford Everest, Toyota Fortuner'),
    ('car', 'Crossover', 'Honda HR-V, Toyota Corolla Cross'),
    ('car', 'MPV / Van', 'Toyota Innova, Hyundai Starex'),
    ('car', 'Pick-up Truck', 'Toyota Hilux, Ford Ranger'),
    ('car', 'AUV', 'Toyota Revo, Mitsubishi Adventure'),

    ('puv', 'Tricycle (Motorized)', ''),
    ('puv', 'Pedicab (Non-motorized)', ''),
    ('puv', 'Jeepney (Traditional)', ''),
    ('puv', 'Modern PUV / E-Jeepney', ''),
    ('puv', 'UV Express', 'Toyota Hi-Ace'),
    ('puv', 'Bus (Provincial)', ''),
    ('puv', 'Bus (City)', ''),
    ('puv', 'Taxi', ''),
    ('puv', 'TNVS', 'Grab'),

    ('truck', 'Light Truck / Delivery Van', ''),
    ('truck', 'Medium Truck (4-wheeler)', ''),
    ('truck', 'Heavy Truck (6-wheeler)', ''),
    ('truck', 'Trailer Truck / Container Van', ''),
    ('truck', 'Dump Truck', ''),
    ('truck', 'Concrete Mixer', ''),
    ('truck', 'Crane Truck', ''),
    ('truck', 'Tanker Truck', ''),

    ('special', 'Ambulance', ''),
    ('special', 'Fire Truck', ''),
    ('special', 'Police Vehicle', ''),
    ('special', 'Military Vehicle', ''),
    ('special', 'Bicycle', ''),
    ('special', 'E-Bike / E-Scooter', ''),
    ('special', 'Tractor', ''),
    ('special', 'Forklift', ''),
    ('special', 'Other', ''),
]


def seed_vehicle_types(apps, schema_editor):
    VehicleType = apps.get_model('violations', 'VehicleType')
    VehicleType.objects.bulk_create([
        VehicleType(category=cat, name=name, examples=examples)
        for cat, name, examples in SEED
    ])


def remove_seed(apps, schema_editor):
    VehicleType = apps.get_model('violations', 'VehicleType')
    VehicleType.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0014_remove_violation_vehicle_classification_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='VehicleType',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=120)),
                ('category', models.CharField(choices=[
                    ('motorcycle', 'Motorcycles'),
                    ('car', 'Cars'),
                    ('puv', 'Public Utility Vehicles'),
                    ('truck', 'Trucks & Heavy Vehicles'),
                    ('special', 'Special / Other'),
                ], default='car', max_length=20)),
                ('examples', models.CharField(blank=True, help_text='e.g. Toyota Vios, Honda City', max_length=200)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'ordering': ['category', 'name'],
                'unique_together': {('name', 'category')},
            },
        ),
        migrations.RunPython(seed_vehicle_types, remove_seed),
    ]
