"""
Stage B - environment parsing helpers in core/settings.py.

A typo in a Render environment variable must produce a clear error or be tolerated;
it must not abort `migrate` (which start.sh runs on every boot) with an obscure traceback.

Run with:  python manage.py test core.test_env_parsing --settings=core.test_settings
"""
import os
from unittest import mock

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from core.settings import _int_env, _origin_list


class IntEnv(SimpleTestCase):

    def test_unset_returns_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('X_TEST_INT', None)
            self.assertEqual(_int_env('X_TEST_INT', 7), 7)
            self.assertIsNone(_int_env('X_TEST_INT'))

    def test_empty_and_blank_return_default(self):
        for raw in ('', '   '):
            with mock.patch.dict(os.environ, {'X_TEST_INT': raw}):
                self.assertEqual(_int_env('X_TEST_INT', 3), 3)

    def test_valid_values(self):
        with mock.patch.dict(os.environ, {'X_TEST_INT': ' 60 '}):
            self.assertEqual(_int_env('X_TEST_INT', 0), 60)
        with mock.patch.dict(os.environ, {'X_TEST_INT': '0'}):
            self.assertEqual(_int_env('X_TEST_INT', 5), 0)      # explicit 0 is not "unset"

    def test_junk_raises_clear_error_naming_the_variable(self):
        with mock.patch.dict(os.environ, {'X_TEST_INT': 'None'}):
            with self.assertRaisesMessage(ImproperlyConfigured, 'X_TEST_INT'):
                _int_env('X_TEST_INT', 0)


class OriginList(SimpleTestCase):

    def test_clean_input_is_unchanged(self):
        self.assertEqual(_origin_list('https://a.example,http://localhost:5173'),
                         ['https://a.example', 'http://localhost:5173'])

    def test_missing_scheme_gets_https_and_trailing_slash_is_removed(self):
        self.assertEqual(_origin_list(' tmeo.vercel.app/ , https://b.example/ '),
                         ['https://tmeo.vercel.app', 'https://b.example'])

    def test_empty_values_ignored(self):
        self.assertEqual(_origin_list(''), [])
        self.assertEqual(_origin_list(' , ,'), [])