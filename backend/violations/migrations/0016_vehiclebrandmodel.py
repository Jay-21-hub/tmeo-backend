from django.db import migrations, models


SEED = [
    ('Honda',      ['XRM 125', 'Click 125i', 'Beat', 'TMX 125', 'Wave 110', 'CBR150R', 'Civic', 'City', 'Brio', 'BR-V', 'CR-V']),
    ('Yamaha',     ['Mio Sporty', 'Mio i125', 'Sniper 155', 'YTX 125', 'NMAX', 'Aerox 155']),
    ('Suzuki',     ['Raider R150', 'Smash 115', 'Skydrive', 'Ertiga', 'APV']),
    ('Kawasaki',   ['Barako', 'Rouser NS160', 'Rouser 200']),
    ('Toyota',     ['Vios', 'Wigo', 'Innova', 'Fortuner', 'Hilux', 'Avanza', 'Corolla Cross']),
    ('Mitsubishi', ['Mirage', 'Xpander', 'Montero Sport', 'Adventure', 'L300']),
    ('Ford',       ['Everest', 'Ranger', 'EcoSport']),
    ('Hyundai',    ['Accent', 'Reina', 'Starex', 'Tucson']),
    ('Nissan',     ['Almera', 'Navara', 'Terra']),
    ('Isuzu',      ['D-Max', 'mu-X']),
    ('Other',      ['Other / Not Listed']),
]


def seed_vehicle_brand_models(apps, schema_editor):
    VehicleBrandModel = apps.get_model('violations', 'VehicleBrandModel')
    VehicleBrandModel.objects.bulk_create([
        VehicleBrandModel(brand=brand, model=model)
        for brand, models_list in SEED
        for model in models_list
    ])


def remove_seed(apps, schema_editor):
    VehicleBrandModel = apps.get_model('violations', 'VehicleBrandModel')
    VehicleBrandModel.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('violations', '0015_vehicletype'),
    ]

    operations = [
        migrations.CreateModel(
            name='VehicleBrandModel',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('brand', models.CharField(max_length=60)),
                ('model', models.CharField(max_length=100)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'ordering': ['brand', 'model'],
                'unique_together': {('brand', 'model')},
            },
        ),
        migrations.RunPython(seed_vehicle_brand_models, remove_seed),
    ]
