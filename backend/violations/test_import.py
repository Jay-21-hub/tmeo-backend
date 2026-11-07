"""
Admin bulk-import tests.  Run: python manage.py test violations.test_import --settings=core.test_settings
"""
import datetime
import io
from unittest import mock
from zoneinfo import ZoneInfo

import openpyxl
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APITestCase

from accounts.models import CustomUser
from audit.models import AuditLog
from database_management.models import ArchiveBatch, ArchivedViolation
from violations.import_service import ALL_COLS
from violations.models import Violation, ViolationItem, ViolationType

MNL = ZoneInfo('Asia/Manila')
URL = '/api/violations/import/'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def make_xlsx(rows, headers=None, name='import.xlsx'):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers or ALL_COLS)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return SimpleUploadedFile(name, buf.getvalue(), content_type=XLSX)


def row(**kw):
    base = {'date_issued': '2026-05-05', 'plate_number': 'abc 123', 'violator_name': 'Juan Dela Cruz',
            'license_number': 'N01', 'violation_codes': 'NH', 'location': 'Perez Park', 'address': '',
            'vehicle_type': 'Cars', 'penalty_amount': '500', 'status': 'pending', 'remarks': ''}
    base.update(kw)
    return [base[c] for c in ALL_COLS]


class ImportBase(APITestCase):
    @classmethod
    def setUpTestData(cls):
        def user(role, n):
            return CustomUser.objects.create_user(
                email=f'{role}{n}@tmeo.test', password='x', full_name=f'{role.title()} {n}',
                id_number=f'I-{role}-{n}', role=role)
        cls.admin, cls.staff, cls.enforcer = user('admin', 1), user('staff', 1), user('enforcer', 1)
        cls.nh = ViolationType.objects.create(code='NH', name='No Helmet', penalty_amount=500)
        cls.dl = ViolationType.objects.create(code='DL', name='No License', penalty_amount=750)
        cls.off = ViolationType.objects.create(code='OFF', name='Inactive', penalty_amount=100, is_active=False)

    def post(self, f, user=None, save=False):
        self.client.force_authenticate(user or self.admin)
        return self.client.post(URL + ('?save=true' if save else ''), {'file': f}, format='multipart')

    def errors_for(self, res, needle):
        return [m for e in res.json()['errors'] for m in e['errors'] if needle in m]


class PermissionTests(ImportBase):
    def test_only_admin_may_import(self):
        f = lambda: make_xlsx([row()])
        self.assertEqual(self.post(f(), user=self.staff).status_code, 403)
        self.assertEqual(self.post(f(), user=self.enforcer).status_code, 403)
        self.assertEqual(self.post(f(), user=self.staff, save=True).status_code, 403)
        self.assertEqual(self.post(f(), user=self.enforcer, save=True).status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.post(URL, {'file': f()}, format='multipart').status_code, 401)
        self.assertEqual(Violation.objects.count(), 0)
        self.assertEqual(self.post(f(), user=self.admin).status_code, 200)

    def test_template_is_admin_only(self):
        for u in (self.staff, self.enforcer):
            self.client.force_authenticate(u)
            self.assertEqual(self.client.get(URL + 'template/').status_code, 403)


class FileLevelTests(ImportBase):
    def test_xlsm_and_other_extensions_rejected(self):
        for name in ('x.xlsm', 'x.csv', 'x.xls'):
            with self.subTest(name=name):
                self.assertEqual(self.post(make_xlsx([row()], name=name)).status_code, 400)

    def test_not_really_a_zip_rejected(self):
        res = self.post(SimpleUploadedFile('x.xlsx', b'not a workbook'))
        self.assertEqual(res.status_code, 400)

    def test_missing_required_columns_and_duplicate_headers(self):
        self.assertEqual(self.post(make_xlsx([['x']], headers=['plate_number'])).status_code, 400)
        h = ALL_COLS[:]; h[1] = 'date_issued'
        self.assertEqual(self.post(make_xlsx([row()], headers=h)).status_code, 400)

    def test_size_and_row_limits(self):
        with mock.patch('violations.import_service.MAX_ROWS', 2):
            res = self.post(make_xlsx([row(plate_number=f'P{i}') for i in range(3)]))
            self.assertEqual(res.status_code, 400)
            self.assertIn('Too many rows', res.json()['error'])
        with mock.patch('violations.import_service.MAX_FILE_BYTES', 10):
            res = self.post(make_xlsx([row()]))
            self.assertEqual(res.status_code, 400)
            self.assertIn('too large', res.json()['error'])

    def test_header_only_file(self):
        self.assertEqual(self.post(make_xlsx([])).status_code, 400)


class RowValidationTests(ImportBase):
    def test_preview_is_json_safe_and_lists_real_names(self):
        res = self.post(make_xlsx([row(violation_codes='NH, DL', penalty_amount='1,250.50')]))
        self.assertEqual(res.status_code, 200, res.content)     # was a 500 (model instances in JSON)
        d = res.json()
        self.assertTrue(d['can_import'])
        r = d['valid_rows'][0]
        self.assertEqual((r['violation_codes'], r['penalty_amount'], r['plate_number']),
                         (['NH', 'DL'], '1250.50', 'ABC 123'))
        self.assertEqual(Violation.objects.count(), 0)          # preview never writes

    def test_paid_rows_rejected(self):
        res = self.post(make_xlsx([row(status='paid')]))
        self.assertFalse(res.json()['can_import'])
        self.assertTrue(self.errors_for(res, 'Paid rows cannot be bulk-imported'))

    def test_ambiguous_and_invalid_dates_rejected_iso_text_and_real_dates_accepted(self):
        for bad in ('03/04/2026', '3-4-2026', '2026-5-5', '2026-02-30', 'yesterday', '45000'):
            with self.subTest(bad=bad):
                self.assertFalse(self.post(make_xlsx([row(date_issued=bad)])).json()['can_import'])
        self.assertTrue(self.post(make_xlsx([row(date_issued='2026-05-05')])).json()['can_import'])
        self.assertTrue(self.post(make_xlsx([row(date_issued=datetime.datetime(2026, 5, 5))])).json()['can_import'])
        self.assertTrue(self.post(make_xlsx([row(date_issued=datetime.date(2026, 5, 5))])).json()['can_import'])

    def test_future_and_ancient_dates_rejected(self):
        with mock.patch('django.utils.timezone.localdate', return_value=datetime.date(2026, 6, 1)):
            self.assertTrue(self.errors_for(self.post(make_xlsx([row(date_issued='2026-06-02')])), 'future'))
        self.assertTrue(self.errors_for(self.post(make_xlsx([row(date_issued='1999-12-31')])), 'before'))

    def test_bad_money(self):
        for bad in ('abc', '-5', 'nan', 'inf', '1e50', ''):
            with self.subTest(bad=bad):
                self.assertFalse(self.post(make_xlsx([row(penalty_amount=bad)])).json()['can_import'])

    def test_codes_unknown_inactive_duplicate_missing(self):
        for codes, needle in (('ZZZ', 'does not exist'), ('OFF', 'inactive'), ('NH,NH', 'more than once'),
                              ('', 'required')):
            with self.subTest(codes=codes):
                res = self.post(make_xlsx([row(violation_codes=codes)]))
                self.assertTrue(self.errors_for(res, needle), res.json())

    def test_required_fields_lengths_and_status_values(self):
        self.assertTrue(self.errors_for(self.post(make_xlsx([row(plate_number='')])), 'plate_number is required'))
        self.assertTrue(self.errors_for(self.post(make_xlsx([row(violator_name='')])), 'violator_name is required'))
        self.assertTrue(self.errors_for(self.post(make_xlsx([row(violator_name='x' * 201)])), 'too long'))
        self.assertTrue(self.errors_for(self.post(make_xlsx([row(status='settled')])), 'invalid'))
        self.assertTrue(self.post(make_xlsx([row(status='')])).json()['can_import'])   # defaults to pending

    def test_ignored_columns_reported_not_fatal(self):
        res = self.post(make_xlsx([row() + ['zzz']], headers=ALL_COLS + ['Mystery']))
        self.assertEqual(res.json()['ignored_columns'], ['mystery'])
        self.assertTrue(res.json()['can_import'])


class DuplicateTests(ImportBase):
    def test_duplicate_within_file(self):
        res = self.post(make_xlsx([row(), row(plate_number='ABC 123 ', violator_name='juan  dela cruz')]))
        self.assertEqual(res.json()['error_count'], 1)
        self.assertTrue(self.errors_for(res, 'Duplicate of row 2'))

    def test_same_ticket_but_different_codes_or_date_is_not_a_duplicate(self):
        res = self.post(make_xlsx([row(), row(violation_codes='NH,DL'), row(date_issued='2026-05-06')]))
        self.assertTrue(res.json()['can_import'])

    def test_duplicate_of_existing_active_record(self):
        v = Violation.objects.create(
            violator_name='Juan Dela Cruz', plate_number='ABC 123', ovr_number='O1',
            date_issued=datetime.datetime(2026, 5, 5, 8, 0, tzinfo=MNL), enforcer=self.enforcer)
        ViolationItem.objects.create(violation=v, violation_type=self.nh)
        res = self.post(make_xlsx([row()]))
        self.assertEqual(res.json()['error_count'], 1)
        self.assertTrue(self.errors_for(res, f'existing record #{v.id}'))

    def test_duplicate_of_archived_record(self):
        batch = ArchiveBatch.objects.create(status='success', archived_count=1, active_count_before=1)
        ArchivedViolation.objects.create(
            batch=batch, original_violation_id=77, violation_year=2026,
            date_issued=datetime.datetime(2026, 5, 5, 8, 0, tzinfo=MNL), settlement_status='settled',
            violator_name='Juan Dela Cruz', plate_number='ABC 123',
            data={'items': [{'code': 'NH', 'name': 'No Helmet', 'category': 'traffic', 'penalty_amount': 500}]})
        self.assertTrue(self.errors_for(self.post(make_xlsx([row()])), 'archived record'))


class SaveTests(ImportBase):
    def test_all_or_nothing(self):
        res = self.post(make_xlsx([row(), row(plate_number='OK2'), row(plate_number='BAD', status='paid')]), save=True)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(Violation.objects.count(), 0)
        self.assertEqual(ViolationItem.objects.count(), 0)
        self.assertFalse(AuditLog.objects.filter(module='Violations', action='CREATE').exists())

    def test_saved_records_have_no_enforcer_and_carry_provenance(self):
        res = self.post(make_xlsx([row(violation_codes='NH,DL', penalty_amount='900'),
                                   row(plate_number='XYZ 1', status='processing')]), save=True)
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()['created'], 2)
        v = Violation.objects.get(plate_number='ABC 123')
        self.assertIsNone(v.enforcer)
        self.assertEqual(v.source, 'imported')
        self.assertEqual(v.imported_by, self.admin)
        self.assertEqual(str(v.penalty_amount), '900.00')          # ticket-level total from the sheet
        self.assertEqual(v.items.count(), 2)
        self.assertEqual(Violation.objects.get(plate_number='XYZ 1').status, 'processing')
        self.assertEqual(timezone_date(v), datetime.date(2026, 5, 5))
        self.assertEqual(self.admin.violations_filed.count(), 0)   # uploader is NOT the issuing enforcer
        self.assertEqual(self.admin.violations_imported.count(), 2)

    def test_audit_entry_preserved(self):
        self.post(make_xlsx([row()]), save=True)
        log = AuditLog.objects.get(module='Violations', action='CREATE')
        self.assertEqual(log.user, self.admin)
        self.assertEqual(log.details['imported_count'], 1)
        self.assertEqual(log.details['imported_by'], 'Admin 1')
        self.assertEqual(log.details['source'], 'imported')
        self.assertEqual(len(log.details['violation_ids']), 1)

    def test_second_import_of_same_file_is_blocked_as_duplicate(self):
        self.assertEqual(self.post(make_xlsx([row()]), save=True).status_code, 201)
        res = self.post(make_xlsx([row()]), save=True)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(Violation.objects.count(), 1)


class SourceCannotBeForgedViaNormalApiTests(ImportBase):
    def _payload(self, **kw):
        return {'violator_name': 'X', 'plate_number': 'P1', 'ovr_number': 'OVR-1',
                'date_issued': timezone.now().isoformat(),
                'violation_type_ids': [str(self.nh.id)], **kw}

    def test_normal_create_api_rejects_imported_source_for_every_role(self):
        for user in (self.admin, self.staff, self.enforcer):
            with self.subTest(role=user.role):
                self.client.force_authenticate(user)
                res = self.client.post('/api/violations/create/', self._payload(source='imported'), format='json')
                # enforcer: source is forced to enforcer_ovr (client value ignored) → 201
                # admin/staff: must be refused, never accepted as 'imported'
                if user.role == 'enforcer':
                    self.assertEqual(res.json().get('source'), 'enforcer_ovr', res.content)
                else:
                    self.assertEqual(res.status_code, 400, res.content)
                    self.assertIn('source', res.json())
        self.assertFalse(Violation.objects.filter(source='imported').exists())

    def test_existing_records_cannot_be_relabelled_to_or_from_imported(self):
        normal = Violation.objects.create(violator_name='N', plate_number='N1', ovr_number='O',
                                          date_issued=datetime.datetime(2026, 5, 5, tzinfo=MNL), enforcer=self.enforcer)
        imported = Violation.objects.create(violator_name='I', plate_number='I1', source='imported',
                                            imported_by=self.admin, enforcer=None,
                                            date_issued=datetime.datetime(2026, 5, 5, tzinfo=MNL))
        self.client.force_authenticate(self.admin)
        r1 = self.client.patch(f'/api/violations/{normal.id}/', {'source': 'imported'}, format='json')
        r2 = self.client.patch(f'/api/violations/{imported.id}/', {'source': 'staff_walk_in'}, format='json')
        self.assertEqual((r1.status_code, r2.status_code), (400, 400), (r1.content, r2.content))
        normal.refresh_from_db(); imported.refresh_from_db()
        self.assertEqual((normal.source, imported.source), ('enforcer_ovr', 'imported'))


def timezone_date(v):
    from django.utils import timezone
    return timezone.localtime(v.date_issued).date()


class TemplateTests(ImportBase):
    def test_template_has_real_active_codes_and_no_sample_rows(self):
        self.client.force_authenticate(self.admin)
        res = self.client.get(URL + 'template/')
        self.assertEqual(res.status_code, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        self.assertEqual([c.value for c in wb['Violations'][1]], ALL_COLS)
        self.assertEqual(wb['Violations'].max_row, 1)                # headers only — no dummy data
        codes = [r[0].value for r in wb['Violation Codes'].iter_rows(min_row=2)]
        self.assertEqual(sorted(codes), ['DL', 'NH'])                # active only; 'OFF' excluded