"""Portable manager checks; never touch the user's real installation."""
import contextlib
import io
import json
import os
from pathlib import Path
import plistlib
import shlex
import stat
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import manage


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mac-manager-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        for name in manage.RUNTIME_FILES:
            (self.source / name).write_text('{}' if name.endswith('.json') else '// test source\n')
        (self.source / 'package.json').write_text(json.dumps({'dependencies': {'ws': '8.18.3'}}))
        (self.source / 'extension').mkdir()
        (self.source / 'extension/manifest.json').write_text('{}')
        (self.source / 'node_modules/ws').mkdir(parents=True)
        (self.source / 'node_modules/ws/package.json').write_text(json.dumps({'version': '8.18.3'}))
        (self.source / 'node_modules/ws/index.js').write_text('// dependency\n')
        # Spaces, quotes and dollar signs verify shell argument quoting.
        self.home = self.base / "Home with 'quote' and $cash"
        self.manager = manage.Manager(self.source, self.home)
        self.output = io.StringIO()

    def setup_runtime(self):
        with patch.object(manage.sys, 'platform', 'darwin'), \
             patch.object(manage.shutil, 'which', side_effect=lambda name: '/fake tools/' + name), \
             patch.object(self.manager, 'command', return_value=subprocess.CompletedProcess([], 0, 'v22.1.0\n', '')), \
             contextlib.redirect_stdout(self.output):
            self.manager.setup()

    def snapshot(self, expiry=None):
        expiry = expiry if expiry is not None else (time.time() + 3600) * 1000
        manage.atomic_write(self.manager.state / 'session.json', manage.json_bytes({
            'log': {'entries': [{'_expiresAt': expiry}, {'_expiresAt': expiry}]},
        }))

    def healthy(self, route, **kwargs):
        if route == '/healthz':
            return {'status': 'ok', 'reloadError': None, 'tokenExpiresAt': (time.time() + 3600) * 1000}
        return {'data': [{'id': manage.OPUS}, {'id': manage.FABLE}]}

    def test_setup_is_private_portable_and_does_not_register_or_start(self):
        self.setup_runtime()
        config = self.manager.installed()
        self.assertEqual(config['stateDir'], str(self.manager.state))
        self.assertEqual(config['capture'], str(self.manager.state / 'session.json'))
        self.assertFalse(self.manager.host.exists())
        self.assertFalse(self.manager.plist.exists())
        self.assertFalse(self.manager.settings.exists())
        self.assertRegex(self.manager.key(), r'^[a-f0-9]{64}$')
        self.assertEqual(stat.S_IMODE(self.manager.state.stat().st_mode), 0o700)
        for name in ('gateway-key', 'launch-agent.plist', 'native-host.json'):
            self.assertEqual(stat.S_IMODE((self.manager.state / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.manager.root / 'config.json').stat().st_mode), 0o600)
        launcher = (self.manager.root / 'native-host.command').read_text().splitlines()
        self.assertEqual(shlex.split(launcher[1]), ['exec', '/fake tools/node', str(self.manager.root / 'native-host.mjs'), '$@'])
        plist = plistlib.loads((self.manager.state / 'launch-agent.plist').read_bytes())
        self.assertEqual(plist['WorkingDirectory'], str(self.manager.root))
        self.assertEqual(plist['ProgramArguments'], ['/fake tools/node', str(self.manager.root / 'bridge.mjs')])
        self.assertNotIn(self.manager.key(), self.output.getvalue())

    def test_setup_refuses_existing_installation_and_missing_dependencies(self):
        self.setup_runtime()
        key = self.manager.key()
        with patch.object(manage.sys, 'platform', 'darwin'), self.assertRaises(manage.ManagerError):
            self.manager.setup()
        self.assertEqual(self.manager.key(), key)
        other = manage.Manager(self.source, self.base / 'another-home')
        (self.source / 'node_modules/ws/package.json').unlink()
        with patch.object(manage.sys, 'platform', 'darwin'), \
             patch.object(manage.shutil, 'which', return_value='/fake/node'), \
             patch.object(other, 'command', return_value=subprocess.CompletedProcess([], 0, 'v22.1.0\n', '')), \
             self.assertRaisesRegex(manage.ManagerError, 'npm ci'):
            other.setup()
        self.assertFalse(other.root.exists())

    def test_host_registration_is_idempotent_and_refuses_other_installation(self):
        self.setup_runtime()
        with contextlib.redirect_stdout(self.output):
            self.manager.register_host()
            self.manager.register_host()
        self.assertEqual(manage.read_json(self.manager.host), self.manager.host_manifest())
        different = self.manager.host_manifest()
        different['path'] = '/different/local/native-host.command'
        manage.atomic_write(self.manager.host, manage.json_bytes(different))
        with self.assertRaisesRegex(manage.ManagerError, 'not overwritten'):
            self.manager.register_host()
        self.assertEqual(manage.read_json(self.manager.host), different)

    def test_configure_and_restore_preserve_unrelated_changes_and_first_backup(self):
        self.setup_runtime()
        self.snapshot()
        self.manager.settings.parent.mkdir()
        before = {'model': 'previous-model', 'env': {'ANTHROPIC_BASE_URL': 'https://previous.example', 'KEEP': 'before'}, 'theme': 'dark'}
        manage.atomic_write(self.manager.settings, manage.json_bytes(before))
        with patch.object(self.manager, 'request', side_effect=self.healthy), contextlib.redirect_stdout(self.output):
            self.manager.configure_claude()
        current = manage.read_json(self.manager.settings)
        self.assertEqual(current['env']['ANTHROPIC_DEFAULT_FABLE_MODEL'], manage.FABLE)
        self.assertEqual(current['env']['ANTHROPIC_AUTH_TOKEN'], self.manager.key())
        self.assertEqual(current['theme'], 'dark')
        backup = (self.manager.state / 'claude-settings.before.json').read_bytes()
        current['env']['KEEP'] = 'later'
        current['newSetting'] = True
        manage.atomic_write(self.manager.settings, manage.json_bytes(current))
        with patch.object(self.manager, 'request', side_effect=self.healthy), contextlib.redirect_stdout(self.output):
            self.manager.configure_claude()
        self.assertEqual((self.manager.state / 'claude-settings.before.json').read_bytes(), backup)
        with patch.object(self.manager, 'stop') as stop, contextlib.redirect_stdout(self.output):
            self.manager.restore()
        stop.assert_called_once()
        restored = manage.read_json(self.manager.settings)
        self.assertEqual(restored['model'], 'previous-model')
        self.assertEqual(restored['env'], {'ANTHROPIC_BASE_URL': 'https://previous.example', 'KEEP': 'later'})
        self.assertTrue(restored['newSetting'])
        self.assertNotIn(self.manager.key(), self.output.getvalue())

    def test_expired_session_refuses_settings_changes(self):
        self.setup_runtime()
        self.snapshot(expiry=1)
        with self.assertRaisesRegex(manage.ManagerError, 'expired'):
            self.manager.configure_claude()
        self.assertFalse(self.manager.settings.exists())
        self.assertFalse((self.manager.state / 'claude-settings.before.json').exists())

    def test_start_and_stop_manage_only_matching_launch_agent(self):
        self.setup_runtime()
        def commands(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1 if argv[1] == 'print' else 0, '', '')
        with patch.object(self.manager, 'port_in_use', return_value=False), \
             patch.object(self.manager, 'request', side_effect=self.healthy), \
             patch.object(self.manager, 'command', side_effect=commands) as command, contextlib.redirect_stdout(self.output):
            self.manager.start()
            self.assertTrue(self.manager.plist.exists())
            self.assertTrue(any(c.args[0][1] == 'bootstrap' for c in command.call_args_list))
            self.manager.stop()
        self.assertFalse(self.manager.plist.exists())
        self.manager.plist.write_text('different agent')
        with patch.object(self.manager, 'command') as command, self.assertRaises(manage.ManagerError):
            self.manager.stop()
        command.assert_not_called()
        self.assertEqual(self.manager.plist.read_text(), 'different agent')

    def test_port_conflict_is_checked_before_creating_launch_agent(self):
        self.setup_runtime()
        with patch.object(self.manager, 'port_in_use', return_value=True), \
             patch.object(self.manager, 'request', side_effect=manage.ManagerError('conflict')), \
             self.assertRaises(manage.ManagerError):
            self.manager.start()
        self.assertFalse(self.manager.plist.exists())

    def test_import_passes_paths_as_arguments_and_keeps_source(self):
        self.setup_runtime()
        capture = self.base / "capture 'quote'.har"
        capture.write_text('{}')
        with patch.object(self.manager, 'port_in_use', return_value=False), \
             patch.object(self.manager, 'command', return_value=subprocess.CompletedProcess([], 0, 'ignored', '')) as command, \
             contextlib.redirect_stdout(self.output):
            self.manager.import_har(capture)
        self.assertEqual(command.call_args.args[0][-2:], [str(capture), str(self.manager.state / 'session.json')])
        self.assertEqual(stat.S_IMODE(capture.stat().st_mode), 0o600)
        self.assertEqual(capture.read_text(), '{}')

    def test_linked_files_and_redirects_are_rejected(self):
        self.setup_runtime()
        target = self.base / 'target'
        target.write_text('{}')
        linked = self.base / 'linked'
        linked.symlink_to(target)
        with self.assertRaises(manage.ManagerError):
            manage.read_json(linked)
        self.assertIsNone(manage.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.example'))

    def run_upgrade(self):
        def commands(argv, **kwargs):
            if argv[0] == 'launchctl':
                return subprocess.CompletedProcess(argv, 1, '', '')
            return subprocess.CompletedProcess(argv, 0, 'v22.1.0\n', '')
        with patch.object(manage.sys, 'platform', 'darwin'), \
             patch.object(manage.shutil, 'which', return_value='/fake/npm'), \
             patch.object(self.manager, 'port_in_use', return_value=False), \
             patch.object(self.manager, 'command', side_effect=commands), \
             contextlib.redirect_stdout(self.output):
            self.manager.upgrade()

    def test_upgrade_preserves_state_settings_registration_and_code_backup(self):
        self.setup_runtime()
        self.snapshot()
        self.manager.settings.parent.mkdir()
        manage.atomic_write(self.manager.settings, manage.json_bytes({'keep': True}))
        with contextlib.redirect_stdout(self.output):
            self.manager.register_host()
        preserved = {path: path.read_bytes() for path in [
            self.manager.root / 'config.json', self.manager.root / 'native-host.command',
            self.manager.state / 'gateway-key', self.manager.state / 'session.json',
            self.manager.state / 'launch-agent.plist', self.manager.state / 'native-host.json',
            self.manager.settings, self.manager.host,
        ]}
        old = (self.manager.root / 'native-host.mjs').read_bytes()
        (self.source / 'native-host.mjs').write_text('// upgraded host\n')
        (self.source / 'extension/popup.html').write_text('<p>new popup</p>')
        self.run_upgrade()
        self.assertEqual((self.manager.root / 'native-host.mjs').read_text(), '// upgraded host\n')
        self.assertTrue((self.manager.root / 'extension/popup.html').is_file())
        backups = list(self.manager.state.glob('code-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o700)
        self.assertEqual((backups[0] / 'native-host.mjs').read_bytes(), old)
        for path, content in preserved.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertFalse(self.manager.plist.exists())
        self.run_upgrade()
        self.assertEqual(len(list(self.manager.state.glob('code-backup-*'))), 2)
        self.assertEqual((backups[0] / 'native-host.mjs').read_bytes(), old)

    def test_upgrade_refuses_a_loaded_service_before_writing(self):
        self.setup_runtime()
        old = (self.manager.root / 'native-host.mjs').read_bytes()
        with patch.object(manage.sys, 'platform', 'darwin'), \
             patch.object(self.manager, 'command', return_value=subprocess.CompletedProcess([], 0, '', '')), \
             self.assertRaisesRegex(manage.ManagerError, 'stop'):
            self.manager.upgrade()
        self.assertEqual((self.manager.root / 'native-host.mjs').read_bytes(), old)
        self.assertEqual(list(self.manager.state.glob('code-backup-*')), [])

    def test_upgrade_rolls_back_partial_code_replacement(self):
        self.setup_runtime()
        self.snapshot()
        original = {name: (self.manager.root / name).read_bytes() for name in manage.RUNTIME_FILES}
        private_before = (self.manager.state / 'session.json').read_bytes()
        for name in ('bridge.mjs', 'native-host.mjs'):
            (self.source / name).write_text('// replacement\n')
        rename = Path.rename

        def fail_once(path, target):
            if path.name == 'native-host.mjs' and path.parent.name.startswith('.code-upgrade-'):
                raise OSError('synthetic file replacement failure')
            return rename(path, target)

        with patch.object(Path, 'rename', fail_once), self.assertRaisesRegex(manage.ManagerError, 'restored'):
            self.run_upgrade()
        for name, content in original.items():
            self.assertEqual((self.manager.root / name).read_bytes(), content)
        self.assertEqual((self.manager.state / 'session.json').read_bytes(), private_before)
        self.assertEqual(list(self.manager.state.glob('.code-upgrade-*')), [])
        self.assertFalse(self.manager.plist.exists())


if __name__ == '__main__':
    unittest.main()
