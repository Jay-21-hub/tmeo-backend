"""
Role Evolution - PHASE 3: HISTORICAL READ-SIDE identity.

Run:  python manage.py test violations.test_phase3_historical --settings=core.test_settings
(Analytics needs PostgreSQL; run with a PostgreSQL settings module for the full file.)

"Later the user changes" is simulated with QuerySet.update(), which bypasses
every model guard (what a future role change would do to the LIVE account).
No UserRoleHistory row is created and no migration is involved.
"""
from datetime import timedelta

from django.core.management import call_command
from django.utils import timezone

from accounts.identity import (
    assessor_identity, audit_actor_identity, enforcer_identity,
    grouped_enforcer_identity, latest_enforcer_labels, latest_enforcer_snapshots,
    notification_actor_identity, resolve_historical_identity, snapshot_fields,
)
from accounts.models import CustomUser
from audit.models import AuditLog
from database_management.archive_utils import _snapshot_violation
from database_management.export_utils import (
    build_archived_export_workbook, build_full_export_workbook,
)
from database_management.models import ArchiveBatch, ArchivedViolation
from notifications.models import Notification
from reports.services.builders import build_enforcer
from violations.models import Assessment, Violation, ViolationItem
from violations.tests import BaseRoleTestCase


def mutate(user, *, name='Renamed Person', role='staff', id_number=None, badge='LIVE-999'):
    """Change the LIVE account the way a future role change would."""
    id_number = id_number or f'2099-NEW-{user.pk:04d}'
    CustomUser.objects.filter(pk=user.pk).update(
        full_name=name, role=role, id_number=id_number, badge_number=badge)
    user.refresh_from_db()


class P3Base(BaseRoleTestCase):

    def filed(self, enforcer, ovr, *, when=None, badge=True, **extra):
        """A violation filed by `enforcer` WITH event-time snapshots."""
        v = self._make_violation(enforcer, ovr, date_issued=when)
        for k, val in snapshot_fields(enforcer, 'enforcer', badge=badge).items():
            setattr(v, k, val)
        for k, val in extra.items():
            setattr(v, k, val)
        v.save()
        return v

    def get(self, user, url):
        res = self.as_user(user).get(url)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def rows(self, data):
        return data['results'] if isinstance(data, dict) and 'results' in data else data


# ─── resolver (pure) ─────────────────────────────────────────────────────────

class ResolverTests(P3Base):

    def test_event_and_derived_show_the_snapshot(self):
        for src in ('event', 'derived'):
            r = resolve_historical_identity(name='Old Name', role='enforcer', id_number='ID-1',
                                            badge='B-1', source=src)
            self.assertEqual((r['name'], r['role'], r['id_number'], r['badge']),
                             ('Old Name', 'enforcer', 'ID-1', 'B-1'))
            self.assertTrue(r['historical'])
            self.assertEqual(r['certainty'], src)

    def test_assumed_is_never_shown_as_fact(self):
        r = resolve_historical_identity(name='X', role='enforcer', id_number='ID', badge='B', source='assumed')
        self.assertEqual((r['name'], r['role'], r['id_number'], r['badge']), (None, None, None, None))
        self.assertFalse(r['historical'])
        self.assertEqual(r['certainty'], 'unknown')

    def test_unknown_falls_back_to_live_NAME_only_and_is_unverified(self):
        mutate(self.enforcer_a, name='Live Name', role='admin', id_number='LIVE-ID', badge='LIVE-B')
        r = resolve_historical_identity(source='unknown', live_user=self.enforcer_a)
        self.assertEqual(r['name'], 'Live Name')
        self.assertEqual(r['certainty'], 'unverified')
        self.assertFalse(r['historical'])
        self.assertEqual((r['role'], r['id_number'], r['badge']), (None, None, None))

    def test_live_account_never_supplies_role_id_or_badge_even_for_assumed(self):
        mutate(self.enforcer_a)
        r = resolve_historical_identity(role='enforcer', source='assumed', live_user=self.enforcer_a)
        self.assertEqual((r['role'], r['id_number'], r['badge']), (None, None, None))

    def test_nothing_at_all_is_unknown(self):
        r = resolve_historical_identity()
        self.assertEqual(r['certainty'], 'unknown')
        self.assertIsNone(r['name'])

    def test_invalid_source_is_treated_as_unknown(self):
        r = resolve_historical_identity(name='X', source='bogus')
        self.assertIsNone(r['name'])


# ─── Audit Trail ─────────────────────────────────────────────────────────────

class AuditHistoricalTests(P3Base):
    URL = '/api/audit/logs/'

    def _log(self, user, desc='p3'):
        AuditLog.objects.create(user=user, action='UPDATE', module='P3', description=desc,
                                **snapshot_fields(user, 'actor'))
        return AuditLog.objects.filter(module='P3').latest('id')

    def _row(self, log):
        data = self.get(self.admin, self.URL)
        return next(r for r in self.rows(data) if r['id'] == log.id)

    def test_snapshot_survives_rename_role_change_and_id_change(self):
        log = self._log(self.enforcer_a)
        mutate(self.enforcer_a, name='Now Staff Person', role='staff', id_number='2099-STF-1')
        row = self._row(log)
        self.assertEqual(row['user_name'], 'Enforcer 1')
        self.assertEqual(row['user_role'], 'enforcer')
        self.assertEqual(row['user_id_number'], 'TEST-enforcer-1')
        self.assertEqual(row['identity_certainty'], 'event')

    def test_legacy_row_uses_live_name_only_and_is_unverified(self):
        log = AuditLog.objects.create(user=self.staff, action='UPDATE', module='P3', description='legacy')
        mutate(self.staff, name='Live Staff', role='admin', id_number='LIVE-1')
        row = self._row(log)
        self.assertEqual(row['user_name'], 'Live Staff')
        self.assertEqual(row['identity_certainty'], 'unverified')
        self.assertEqual(row['user_role'], '')             # never the live role
        self.assertIsNone(row['user_id_number'])

    def test_system_row_is_still_system(self):
        log = AuditLog.objects.create(user=None, action='UPDATE', module='P3', description='sys')
        row = self._row(log)
        self.assertEqual((row['user_name'], row['user_role']), ('System', 'system'))

    def test_existing_keys_are_kept(self):
        row = self._row(self._log(self.staff))
        for k in ('id', 'user_name', 'user_email', 'user_role', 'action', 'module', 'description',
                  'status', 'timestamp', 'target_label', 'client_summary'):
            self.assertIn(k, row)

    def test_search_matches_the_event_time_name(self):
        self._log(self.enforcer_a, desc='needle-p3')
        mutate(self.enforcer_a, name='Totally Different')
        data = self.get(self.admin, self.URL + '?search=Enforcer 1')
        self.assertTrue(any(r['module'] == 'P3' for r in self.rows(data)))

    def test_adapter(self):
        log = self._log(self.admin)
        mutate(self.admin, name='Zed')
        self.assertEqual(audit_actor_identity(log)['name'], 'Admin 1')


# ─── Violation / Assessment serializers ──────────────────────────────────────

class ViolationHistoricalTests(P3Base):
    LIST = '/api/violations/'

    def _item(self, v):
        data = self.get(self.admin, self.LIST + '?page_size=100')
        return next(r for r in self.rows(data) if r['id'] == v.id)

    def test_enforcer_name_is_event_time_after_rename(self):
        v = self.filed(self.enforcer_a, 'OVR-P3-1')
        mutate(self.enforcer_a, name='Renamed Enf')
        item = self._item(v)
        self.assertEqual(item['enforcer_name'], 'Enforcer 1')
        self.assertTrue(item['enforcer_historical'])

    def test_assumed_legacy_enforcer_gets_live_name_flagged_not_historical(self):
        v = self._make_violation(self.enforcer_a, 'OVR-P3-2')
        Violation.objects.filter(pk=v.pk).update(enforcer_role_snapshot='enforcer',
                                                 enforcer_snapshot_source='assumed')
        mutate(self.enforcer_a, name='Live Enf')
        item = self._item(v)
        self.assertEqual(item['enforcer_name'], 'Live Enf')
        self.assertFalse(item['enforcer_historical'])

    def test_deleted_enforcer_account_keeps_the_snapshot_name(self):
        v = self.filed(self.enforcer_b, 'OVR-P3-3')
        Violation.objects.filter(pk=v.pk).update(enforcer=None)
        item = self._item(v)
        self.assertEqual(item['enforcer_name'], 'Enforcer 2')

    def test_assessor_and_confirmer_are_separate_and_historical(self):
        v = self.filed(self.enforcer_a, 'OVR-P3-4')
        a = Assessment.objects.create(
            violation=v, assessed_by=self.staff, payment_confirmed_by=self.admin,
            **snapshot_fields(self.staff, 'assessor'), **snapshot_fields(self.admin, 'payment_confirmer'))
        mutate(self.staff, name='Staff Renamed')
        mutate(self.admin, name='Admin Renamed')
        body = self.get(self.admin, f'/api/violations/{v.id}/')['assessment']
        self.assertEqual(body['assessed_by_name'], 'Staff 1')
        self.assertEqual(body['payment_confirmed_by_name'], 'Admin 1')
        self.assertTrue(body['assessor_historical'])
        self.assertTrue(body['payment_confirmer_historical'])
        listed = self._item(v)
        self.assertEqual(listed['assessed_by_name'], 'Staff 1')

    def test_unprovable_legacy_assessor_is_null_not_the_fk_name(self):
        v = self.filed(self.enforcer_a, 'OVR-P3-5', status='paid')
        Assessment.objects.create(violation=v, assessed_by=self.admin)      # legacy: no snapshot
        body = self.get(self.admin, f'/api/violations/{v.id}/')['assessment']
        self.assertIsNone(body['assessed_by_name'])
        self.assertFalse(body['assessor_historical'])
        self.assertEqual(body['assessed_by'], self.admin.id)                # FK itself untouched
        self.assertIsNone(self._item(v)['assessed_by_name'])
        self.assertIsNone(assessor_identity(Assessment.objects.get(violation=v))['name'])

    def test_violation_without_assessment_has_no_assessor(self):
        item = self._item(self.filed(self.enforcer_a, 'OVR-P3-6'))
        self.assertIsNone(item['assessed_by_name'])
        self.assertFalse(item['assessed_by_historical'])

    def test_adapter(self):
        v = self.filed(self.enforcer_a, 'OVR-P3-7')
        mutate(self.enforcer_a, name='Q')
        v.refresh_from_db()
        ident = enforcer_identity(v)
        self.assertEqual((ident['name'], ident['badge']), ('Enforcer 1', None))


# ─── Notifications ───────────────────────────────────────────────────────────

class NotificationHistoricalTests(P3Base):

    def _notif(self, **kw):
        return Notification.objects.create(
            recipient_role='admin', notif_type='violation', title='t', message='m', **kw)

    def _api(self):
        return next(n for n in self.get(self.admin, '/api/notifications/')['notifications']
                    if n['title'] == 't')

    def test_actor_is_event_time(self):
        self._notif(related_user=self.enforcer_a)
        mutate(self.enforcer_a, name='Renamed', role='admin')
        n = self._api()
        self.assertEqual((n['actor_name'], n['actor_role'], n['actor_certainty']),
                         ('Enforcer 1', 'enforcer', 'event'))

    def test_legacy_actor_live_name_only(self):
        n = self._notif(related_user=self.staff)
        Notification.objects.filter(pk=n.pk).update(actor_snapshot_source='unknown',
                                                    actor_name_snapshot=None, actor_role_snapshot=None)
        mutate(self.staff, name='Live Staff', role='admin')
        out = self._api()
        self.assertEqual((out['actor_name'], out['actor_role'], out['actor_certainty']),
                         ('Live Staff', None, 'unverified'))

    def test_no_actor(self):
        self._notif()
        out = self._api()
        self.assertEqual((out['actor_name'], out['actor_role']), (None, None))
        self.assertEqual(out['actor_certainty'], 'unknown')

    def test_adapter(self):
        n = self._notif(related_user=self.admin)
        mutate(self.admin, name='Z')
        self.assertEqual(notification_actor_identity(n)['name'], 'Admin 1')


# ─── Grouped identity helpers ────────────────────────────────────────────────

class GroupedHelpers(P3Base):

    def test_latest_label_is_the_most_recent_event_time_name(self):
        now = timezone.now()
        self.filed(self.enforcer_a, 'G-1', when=now - timedelta(days=3))
        mutate(self.enforcer_a, name='Second Name', role='enforcer', id_number='X', badge='B-2')
        self.filed(self.enforcer_a, 'G-2', when=now - timedelta(days=1))
        self.assertEqual(latest_enforcer_labels([self.enforcer_a.id])[self.enforcer_a.id], 'Second Name')
        self.assertEqual(latest_enforcer_snapshots()[self.enforcer_a.id]['badge'], 'B-2')

    def test_one_label_per_stable_user(self):
        now = timezone.now()
        self.filed(self.enforcer_a, 'G-3', when=now - timedelta(days=2))
        self.filed(self.enforcer_b, 'G-4', when=now - timedelta(days=2))
        self.assertEqual(set(latest_enforcer_labels()), {self.enforcer_a.id, self.enforcer_b.id})

    def test_assumed_snapshots_do_not_produce_a_label(self):
        v = self._make_violation(self.enforcer_a, 'G-5')
        Violation.objects.filter(pk=v.pk).update(enforcer_name_snapshot='Guess',
                                                 enforcer_snapshot_source='assumed')
        self.assertNotIn(self.enforcer_a.id, latest_enforcer_labels())

    def test_badge_never_comes_from_live_account(self):
        mutate(self.enforcer_a, badge='LIVE-BADGE')
        g = grouped_enforcer_identity(self.enforcer_a.id, 'Live', {})
        self.assertEqual((g['name'], g['badge'], g['historical']), ('Live', '', False))


# ─── Dashboard / Year comparison / Analytics ─────────────────────────────────

class DashboardAndAnalyticsTests(P3Base):

    def _two_names_for_one_person(self):
        now = timezone.now()
        CustomUser.objects.filter(pk=self.enforcer_a.pk).update(badge_number='OLD-B')
        self.enforcer_a.refresh_from_db()
        self.filed(self.enforcer_a, 'D-1', when=now - timedelta(hours=5))
        mutate(self.enforcer_a, name='Newer Name', role='enforcer', id_number='NEW-ID', badge='NEW-B')
        self.filed(self.enforcer_a, 'D-2', when=now - timedelta(hours=1))
        mutate(self.enforcer_a, name='Live Name Now', role='staff', id_number='LIVE-ID', badge='LIVE-B')

    def test_dashboard_groups_on_stable_id_with_latest_event_time_name(self):
        self._two_names_for_one_person()
        top = self.get(self.admin, '/api/violations/stats/')['top_enforcers']
        mine = [e for e in top if e['id'] == self.enforcer_a.id]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]['tickets'], 2)
        self.assertEqual(mine[0]['name'], 'Newer Name')       # not 'Live Name Now'
        self.assertEqual(mine[0]['badge'], 'NEW-B')           # snapshot, not 'LIVE-B'

    def test_dashboard_badge_blank_without_snapshot_badge(self):
        v = self._make_violation(self.enforcer_b, 'D-3')
        Violation.objects.filter(pk=v.pk).update(enforcer_name_snapshot='Enforcer 2',
                                                 enforcer_snapshot_source='event')
        mutate(self.enforcer_b, badge='LIVE-B2', role='enforcer')
        top = self.get(self.admin, '/api/violations/stats/')['top_enforcers']
        e = next(e for e in top if e['id'] == self.enforcer_b.id)
        self.assertEqual(e['badge'], '')

    def test_year_comparison_has_one_label_per_person(self):
        self._two_names_for_one_person()
        data = self.get(self.admin, '/api/violations/analytics/year_comparison/?breakdown=enforcer')
        text = str(data)
        self.assertIn('Newer Name', text)
        self.assertNotIn('Live Name Now', text)
        self.assertNotIn('Enforcer 1', text)                  # the older name is not a second row

    def test_analytics_top_enforcers(self):
        self._two_names_for_one_person()
        top = self.get(self.admin, '/api/violations/analytics/?period=year')['top_enforcers']
        mine = [e for e in top if e['enforcer__id'] == self.enforcer_a.id]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]['count'], 2)
        self.assertEqual(mine[0]['enforcer__full_name'], 'Newer Name')
        self.assertEqual(mine[0]['enforcer__badge_number'], 'NEW-B')

    def _archive(self, oid, name, uid=None, snap=None, badge=None, when=None):
        batch = ArchiveBatch.objects.create(status='success', archived_count=1, active_count_before=1)
        data = {'status': 'Paid', 'penalty_amount': 500.0, 'enforcer_name': name,
                'source': 'enforcer_ovr', 'location': 'X', 'vehicle_type': 'Cars', 'items': []}
        if uid:
            data['enforcer_user_id'] = uid
        if snap:
            data.update(enforcer_name_snapshot=snap, enforcer_badge_snapshot=badge,
                        enforcer_snapshot_source='event')
        when = when or timezone.now() - timedelta(hours=1)
        return ArchivedViolation.objects.create(
            batch=batch, original_violation_id=oid, violation_year=when.year, date_issued=when,
            settlement_status='settled', violator_name='A', plate_number='P', license_number='', data=data)

    def test_archived_row_with_user_id_merges_with_active_person(self):
        self._two_names_for_one_person()
        self._archive(9101, 'Stale Archive Name', uid=self.enforcer_a.id)
        top = self.get(self.admin, '/api/violations/analytics/?period=year')['top_enforcers']
        mine = [e for e in top if e['enforcer__id'] == self.enforcer_a.id]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]['count'], 3)

    def test_legacy_archive_without_id_matches_only_a_unique_name(self):
        self._two_names_for_one_person()
        self._archive(9102, 'Newer Name')                          # unique -> merges
        self._archive(9103, 'Nobody Known')                        # no match -> own row
        top = self.get(self.admin, '/api/violations/analytics/?period=year')['top_enforcers']
        by_name = {e['enforcer__full_name']: e for e in top}
        self.assertEqual(by_name['Newer Name']['count'], 3)
        self.assertIsNone(by_name['Nobody Known']['enforcer__id'])


# ─── Reports ─────────────────────────────────────────────────────────────────

class ReportsHistoricalTests(P3Base):

    def _report(self):
        res = self.as_user(self.admin).get('/api/reports/generate/?type=enforcer')
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_enforcer_activity_label_and_badge_are_event_time(self):
        now = timezone.now()
        self.filed(self.enforcer_a, 'R-1', when=now - timedelta(days=2))
        mutate(self.enforcer_a, name='Newest Name', role='enforcer', badge='B-NEW')
        self.filed(self.enforcer_a, 'R-2', when=now - timedelta(days=1))
        mutate(self.enforcer_a, name='Live Later', role='staff', badge='LIVE-B')
        rows = {r['enforcer']: r for r in self._report()['rows']}
        self.assertIn('Newest Name', rows)
        self.assertNotIn('Live Later', rows)
        self.assertEqual(rows['Newest Name']['tickets_issued'], 2)
        self.assertEqual(rows['Newest Name']['badge_number'], 'B-NEW')

    def test_badge_is_snapshot_only_never_live(self):
        v = self._make_violation(self.enforcer_b, 'R-3')
        Violation.objects.filter(pk=v.pk).update(
            enforcer_name_snapshot='Enforcer 2', enforcer_snapshot_source='event', source='enforcer_ovr')
        mutate(self.enforcer_b, role='enforcer', badge='LIVE-ONLY')
        row = next(r for r in self._report()['rows'] if r['enforcer'] == 'Enforcer 2')
        self.assertIsNone(row['badge_number'])

    def test_legacy_archive_matches_only_unique_name(self):
        self.filed(self.enforcer_a, 'R-4', when=timezone.now() - timedelta(days=1))
        batch = ArchiveBatch.objects.create(status='success', archived_count=2, active_count_before=2)
        for oid, name in ((9201, 'Enforcer 1'), (9202, 'Ghost Officer')):
            ArchivedViolation.objects.create(
                batch=batch, original_violation_id=oid, violation_year=timezone.now().year,
                date_issued=timezone.now() - timedelta(hours=2), settlement_status='settled',
                violator_name='A', plate_number='P', license_number='',
                data={'status': 'Paid', 'penalty_amount': 500.0, 'enforcer_name': name,
                      'source': 'enforcer_ovr', 'items': []})
        rows = {r['enforcer']: r for r in self._report()['rows']}
        self.assertEqual(rows['Enforcer 1']['tickets_issued'], 2)
        self.assertEqual(rows['Ghost Officer']['tickets_issued'], 1)

    def test_top_enforcers_endpoint(self):
        now = timezone.now()
        self.filed(self.enforcer_a, 'R-5', when=now)
        mutate(self.enforcer_a, name='Live Renamed', role='enforcer', badge='LIVE-B')
        data = self.get(self.admin, '/api/reports/top-enforcers/')
        mine = next(e for e in data if e['id'] == self.enforcer_a.id)
        self.assertEqual(mine['name'], 'Enforcer 1')
        self.assertNotEqual(mine['badge_number'], 'LIVE-B')       # snapshot-only, never live


# ─── Archive snapshot / Archive API / exports ────────────────────────────────

class ArchiveAndExportTests(P3Base):

    def _paid_with_assessor_and_confirmer(self, ovr='A-1'):
        v = self.filed(self.enforcer_a, ovr, status='paid')
        Assessment.objects.create(
            violation=v, assessed_by=self.staff, payment_confirmed_by=self.admin,
            or_number='OR-1', amount_paid=500,
            **snapshot_fields(self.staff, 'assessor'), **snapshot_fields(self.admin, 'payment_confirmer'))
        return Violation.objects.select_related('enforcer', 'assessed_by', 'assessment').get(pk=v.pk)

    def _archived(self, v):
        batch = ArchiveBatch.objects.create(status='success', archived_count=1, active_count_before=1)
        archived = ArchivedViolation.objects.create(
            batch=batch, original_violation_id=v.id, violation_year=v.date_issued.year,
            date_issued=v.date_issued, settlement_status='settled', violator_name='A',
            plate_number='P', license_number='', data=_snapshot_violation(v))
        # Checkpoint 2: a real archive MOVES the ticket (the active row is deleted).
        # Archive browsing/exports now exclude a snapshot whose original is still
        # active (same identity) as a duplicate, so mimic the real archive here.
        # filter().delete() leaves the `v` instance untouched for the caller.
        Violation.objects.filter(pk=v.pk).delete()
        return archived

    def _sheet(self, wb):
        ws = wb.active
        header = [c.value for c in ws[1]]
        return header, [dict(zip(header, [c.value for c in r])) for r in ws.iter_rows(min_row=2)]

    def test_archive_snapshot_carries_stable_enforcer_id(self):
        v = self._paid_with_assessor_and_confirmer()
        self.assertEqual(_snapshot_violation(v)['enforcer_user_id'], self.enforcer_a.id)

    def test_archive_api_strips_every_assessor_key_but_keeps_confirmer(self):
        a = self._archived(self._paid_with_assessor_and_confirmer())
        res = self.get(self.admin, '/api/database/archive/records/')
        row = next(r for r in self.rows(res) if r['id'] == a.id)
        d = row['data']
        self.assertNotIn('assessed_by_name', d)
        for k in ('assessed_by_name', 'assessor_name_snapshot', 'assessor_role_snapshot',
                  'assessor_id_number_snapshot', 'assessor_snapshot_source'):
            self.assertNotIn(k, d['assessment'])
        self.assertEqual(d['assessment']['payment_confirmer_name_snapshot'], 'Admin 1')
        # stored data is untouched
        a.refresh_from_db()
        self.assertEqual(a.data['assessment']['assessor_name_snapshot'], 'Staff 1')

    def test_archived_export_payment_processed_by_is_the_confirmer_never_the_assessor(self):
        self._archived(self._paid_with_assessor_and_confirmer())
        wb, n = build_archived_export_workbook()
        header, rows = self._sheet(wb)
        self.assertEqual(n, 1)
        self.assertEqual(rows[0]['Payment Processed By'], 'Admin 1')
        self.assertNotIn('Assessed By', header)
        self.assertNotIn('Staff 1', [str(v) for v in rows[0].values()])

    def test_archived_export_legacy_without_confirmer_is_blank_not_the_assessor(self):
        v = self.filed(self.enforcer_a, 'A-2', status='paid')
        Assessment.objects.create(violation=v, assessed_by=self.admin, or_number='OR-2')
        self._archived(Violation.objects.select_related('enforcer', 'assessed_by', 'assessment').get(pk=v.pk))
        _, rows = self._sheet(build_archived_export_workbook()[0])
        self.assertEqual(rows[0]['Payment Processed By'] or '', '')

    def test_archived_export_enforcer_is_event_time(self):
        v = self._paid_with_assessor_and_confirmer('A-3')
        self._archived(v)
        mutate(self.enforcer_a, name='Renamed')
        _, rows = self._sheet(build_archived_export_workbook()[0])
        self.assertEqual(rows[0]['Filed By (Enforcer)'], 'Enforcer 1')

    def test_full_export_filed_by_and_assessed_by_are_historical(self):
        self._paid_with_assessor_and_confirmer('A-4')
        mutate(self.enforcer_a, name='Renamed Enf')
        mutate(self.staff, name='Renamed Staff')
        _, rows = self._sheet(build_full_export_workbook()[0])
        row = next(r for r in rows if r['Filed By (Enforcer)'] == 'Enforcer 1')
        self.assertEqual(row['Assessed By'], 'Staff 1')

    def test_full_export_unprovable_assessor_is_blank(self):
        v = self.filed(self.enforcer_a, 'A-5', status='paid')
        Assessment.objects.create(violation=v, assessed_by=self.admin)
        Violation.objects.filter(pk=v.pk).update(assessed_by=self.admin)
        _, rows = self._sheet(build_full_export_workbook()[0])
        self.assertTrue(all((r['Assessed By'] or '') != 'Admin 1' for r in rows))


# ─── Staff dashboard / pending queue ─────────────────────────────────────────

class StaffDashboardHistoricalTests(P3Base):
    """Who FILED and who ASSESSED are historical events -> snapshot-first.
    locked_by_name is the CURRENT lock holder (present state) and stays live."""

    def _dash(self):
        return self.get(self.staff, '/api/violations/staff-dashboard/')

    def test_recent_actions_use_event_time_names(self):
        v = self.filed(self.enforcer_a, 'SD-1', status='processing')
        Assessment.objects.create(violation=v, assessed_by=self.staff,
                                  **snapshot_fields(self.staff, 'assessor'))
        Violation.objects.filter(pk=v.pk).update(assessed_by=self.staff)
        mutate(self.enforcer_a, name='Renamed Enf')
        mutate(self.staff, name='Renamed Staff')
        row = next(r for r in self._dash()['recent_actions'] if r['id'] == v.id)
        self.assertEqual(row['enforcer_name'], 'Enforcer 1')
        self.assertEqual(row['assessed_by_name'], 'Staff 1')

    def test_unprovable_legacy_assessor_is_null_on_dashboard(self):
        v = self.filed(self.enforcer_a, 'SD-2', status='paid')
        Assessment.objects.create(violation=v, assessed_by=self.admin)       # legacy, no snapshot
        Violation.objects.filter(pk=v.pk).update(assessed_by=self.admin)
        row = next(r for r in self._dash()['recent_actions'] if r['id'] == v.id)
        self.assertIsNone(row['assessed_by_name'])

    def test_no_assessment_means_no_assessor(self):
        v = self.filed(self.enforcer_a, 'SD-3', status='pending')
        row = next(r for r in self._dash()['recent_actions'] if r['id'] == v.id)
        self.assertIsNone(row['assessed_by_name'])

    def test_pending_queue_enforcer_is_event_time(self):
        v = self.filed(self.enforcer_a, 'SD-4', status='pending')
        mutate(self.enforcer_a, name='Renamed Enf')
        row = next(r for r in self._dash()['pending_queue'] if r['id'] == v.id)
        self.assertEqual(row['enforcer_name'], 'Enforcer 1')

    def test_pending_list_enforcer_is_event_time_and_dash_when_unknown(self):
        v = self.filed(self.enforcer_a, 'SD-5', status='pending')
        mutate(self.enforcer_a, name='Renamed Enf')
        body = self.get(self.staff, '/api/violations/pending/?page_size=50')
        rows = body['results']
        self.assertEqual(next(r for r in rows if r['id'] == v.id)['enforcer_name'], 'Enforcer 1')
        w = self._make_violation(self.enforcer_b, 'SD-6')
        Violation.objects.filter(pk=w.pk).update(enforcer=None, status='pending')
        body = self.get(self.staff, '/api/violations/pending/?page_size=50')
        self.assertEqual(next(r for r in body['results'] if r['id'] == w.id)['enforcer_name'], '—')

    def test_lock_holder_stays_current(self):
        v = self.filed(self.enforcer_a, 'SD-7', status='processing')
        Violation.objects.filter(pk=v.pk).update(locked_by=self.staff)
        mutate(self.staff, name='Staff Now')
        row = next(r for r in self._dash()['pending_queue'] + self._dash()['recent_actions']
                   if r['id'] == v.id)
        self.assertEqual(row['locked_by_name'], 'Staff Now')


# ─── Guardrails ──────────────────────────────────────────────────────────────

class GuardrailTests(P3Base):

    def test_no_migration_is_needed(self):
        call_command('makemigrations', '--check', '--dry-run', verbosity=0)

    def test_read_side_never_writes_snapshots(self):
        v = self.filed(self.enforcer_a, 'GR-1')
        before = list(Violation.objects.filter(pk=v.pk).values())
        self.get(self.admin, '/api/violations/')
        self.assertEqual(list(Violation.objects.filter(pk=v.pk).values()), before)