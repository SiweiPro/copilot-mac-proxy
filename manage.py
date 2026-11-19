#!/usr/bin/env python3
"""Install and manage the local macOS bridge without printing credentials."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

APP_NAME = 'CopilotMacProxy'
LABEL = 'local.codex.copilot-mac-proxy'
NATIVE_HOST = 'local.codex.copilot_session_relay'
EXTENSION_ID = 'gldnemhkpddiifjfgkhppbkciakggkoc'
PORT = 19324
OPUS = 'copilot-claude-opus-5.5'
FABLE = 'copilot-claude-fable-5.1'
RUNTIME_FILES = (
    'bridge.mjs', 'envelope.mjs', 'streamhub.mjs', 'session-store.mjs',
    'native-host.mjs', 'package.json', 'package-lock.json',
)


class ManagerError(Exception):
    """A fixed, safe diagnostic that never contains request or credential data."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require_regular(path: Path, private: bool = False) -> None:
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise ManagerError('Refusing a linked or non-regular local file.')
    if hasattr(os, 'getuid') and st.st_uid != os.getuid():
        raise ManagerError('Local file must belong to the current user.')
    if private and st.st_mode & 0o077:
        raise ManagerError('Private local file must have mode 0600.')


def read_json(path: Path, private: bool = False) -> dict:
    require_regular(path, private)
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ManagerError('Local JSON file is too large.')
    try:
        value = json.loads(path.read_text())
    except (ValueError, UnicodeError):
        raise ManagerError('Invalid local JSON file.') from None
    if not isinstance(value, dict):
        raise ManagerError('Local JSON must be an object.')
    return value


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or (hasattr(os, 'getuid') and st.st_uid != os.getuid()):
        raise ManagerError('Refusing an unsafe local directory.')
    path.chmod(0o700)


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    if path.exists() or path.is_symlink():
        require_regular(path)
    fd, temporary = tempfile.mkstemp(prefix='.copilot-write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def exclusive_json(path: Path, value: dict) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(json_bytes(value))
        stream.flush()
        os.fsync(stream.fileno())


def claude_environment(key: str) -> dict:
    return {
        'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{PORT}',
        'ANTHROPIC_AUTH_TOKEN': key,
        # Empty values prevent a settings-level alternate credential/header.
        'ANTHROPIC_API_KEY': '',
        'ANTHROPIC_CUSTOM_HEADERS': '',
        'ANTHROPIC_MODEL': OPUS,
        'ANTHROPIC_DEFAULT_OPUS_MODEL': OPUS,
        'ANTHROPIC_DEFAULT_FABLE_MODEL': FABLE,
        'ANTHROPIC_DEFAULT_SONNET_MODEL': OPUS,
        'ANTHROPIC_DEFAULT_HAIKU_MODEL': OPUS,
        'ANTHROPIC_SMALL_FAST_MODEL': OPUS,
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
        'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS': '1',
        'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY': '1',
        'CLAUDE_CODE_MAX_CONTEXT_TOKENS': '48000',
        'DISABLE_PROMPT_CACHING': '1',
    }


class Manager:
    def __init__(self, source: Path, home: Path | None = None):
        self.source = source.resolve()
        self.home = Path.home() if home is None else home
        self.root = self.home / 'Library/Application Support' / APP_NAME
        self.state = self.root / '.local'
        self.plist = self.home / 'Library/LaunchAgents' / (LABEL + '.plist')
        self.host = self.home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts' / (NATIVE_HOST + '.json')
        self.settings = self.home / '.claude/settings.json'
        self.target = 'gui/' + str(os.getuid())

    def command(self, argv: list[str], **kwargs) -> subprocess.CompletedProcess:
        return subprocess.run(argv, capture_output=True, text=True, **kwargs)

    def installed(self) -> dict:
        config = read_json(self.root / 'config.json', private=True)
        expected = {
            'port': PORT, 'stateDir': str(self.state),
            'capture': str(self.state / 'session.json'), 'extensionId': EXTENSION_ID,
        }
        if config != expected:
            raise ManagerError('Installed configuration does not match this manager.')
        st = self.state.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o077 or st.st_uid != os.getuid():
            raise ManagerError('Private state directory is unsafe.')
        return config

    def key(self) -> str:
        path = self.state / 'gateway-key'
        require_regular(path, private=True)
        value = path.read_text().strip()
        if not re.fullmatch(r'[a-f0-9]{64}', value):
            raise ManagerError('Invalid local gateway key.')
        return value

    def validate_payload(self, node: str | None = None) -> str:
        node = node or shutil.which('node')
        if not node or not shutil.which('npm'):
            raise ManagerError('Install Node.js 22 or later with npm first.')
        result = self.command([node, '--version'], timeout=10)
        match = re.fullmatch(r'v(\d+)\.\d+\.\d+\s*', result.stdout)
        if result.returncode or not match or int(match.group(1)) < 22:
            raise ManagerError('Node.js 22 or later is required.')
        package = read_json(self.source / 'package.json')
        dependency = self.source / 'node_modules/ws/package.json'
        if not dependency.is_file():
            raise ManagerError('Run npm ci in the repository before setup or upgrade.')
        if set(package.get('dependencies', {})) != {'ws'} or read_json(dependency).get('version') != package['dependencies']['ws']:
            raise ManagerError('Installed dependencies do not match package.json; run npm ci.')
        required = [self.source / name for name in RUNTIME_FILES]
        required.extend([self.source / 'extension', self.source / 'node_modules/ws'])
        required.extend((self.source / 'extension').rglob('*'))
        required.extend((self.source / 'node_modules/ws').rglob('*'))
        if any(p.is_symlink() for p in required):
            raise ManagerError('Refusing linked source files in the installation payload.')
        for p in required:
            if not p.is_dir():
                require_regular(p)
        return node

    def setup(self) -> None:
        if sys.platform != 'darwin':
            raise ManagerError('Setup is supported on macOS only.')
        if self.root.exists() or self.root.is_symlink():
            raise ManagerError('Runtime already exists; setup never overwrites an installation.')
        node = self.validate_payload()
        self.root.parent.mkdir(parents=True, exist_ok=True)
        # Assemble in a sibling temporary directory, then rename into place.
        staging = Path(tempfile.mkdtemp(prefix='.copilot-mac-install-', dir=self.root.parent))
        try:
            for name in RUNTIME_FILES:
                shutil.copyfile(self.source / name, staging / name)
            shutil.copytree(self.source / 'extension', staging / 'extension')
            shutil.copytree(self.source / 'node_modules/ws', staging / 'node_modules/ws')
            private_dir(staging / '.local')
            config = {'port': PORT, 'stateDir': str(self.state),
                      'capture': str(self.state / 'session.json'), 'extensionId': EXTENSION_ID}
            atomic_write(staging / 'config.json', json_bytes(config))
            atomic_write(staging / '.local/gateway-key', secrets.token_hex(32).encode())
            launcher = '#!/bin/sh\nexec ' + shlex.quote(node) + ' ' + shlex.quote(str(self.root / 'native-host.mjs')) + ' "$@"\n'
            atomic_write(staging / 'native-host.command', launcher.encode(), 0o700)
            agent = {
                'Label': LABEL, 'ProgramArguments': [node, str(self.root / 'bridge.mjs')],
                'WorkingDirectory': str(self.root), 'RunAtLoad': True,
                'KeepAlive': True, 'ThrottleInterval': 10, 'Umask': 0o077,
                'StandardOutPath': str(self.state / 'service.log'),
                'StandardErrorPath': str(self.state / 'service-error.log'),
            }
            atomic_write(staging / '.local/launch-agent.plist', plistlib.dumps(agent))
            atomic_write(staging / '.local/native-host.json', json_bytes(self.host_manifest()))
            staging.rename(self.root)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        print('Installed runtime. Import a capture, register the host, then start the bridge.')

    def upgrade(self) -> None:
        if sys.platform != 'darwin':
            raise ManagerError('Upgrade is supported on macOS only.')
        self.installed()
        if self.source == self.root.resolve():
            raise ManagerError('Run upgrade from a separate repository checkout.')
        loaded = self.command(['launchctl', 'print', self.target + '/' + LABEL])
        if loaded.returncode == 0 or self.plist.exists() or self.plist.is_symlink() or self.port_in_use():
            raise ManagerError('Run manage.py stop and stop any process on the bridge port before upgrading.')
        self.validate_payload(self.node())
        names = (*RUNTIME_FILES, 'extension', 'node_modules/ws')
        for directory in (self.root, self.root / 'node_modules'):
            st = directory.lstat()
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
                raise ManagerError('Refusing an unsafe installation directory.')
        for name in names:
            destination = self.root / name
            paths = [destination, *destination.rglob('*')] if destination.is_dir() else [destination]
            for path in paths:
                if path.is_symlink():
                    raise ManagerError('Refusing linked files in the installed payload.')
                if not path.is_dir():
                    require_regular(path)
        staging = Path(tempfile.mkdtemp(prefix='.code-upgrade-', dir=self.state))
        backup = None
        moved = []
        installed = []
        try:
            for name in names:
                source, destination = self.source / name, staging / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, destination)
                else:
                    shutil.copyfile(source, destination)
            # Keep each previous code version in a distinct private directory.
            backup = Path(tempfile.mkdtemp(prefix='code-backup-', dir=self.state))
            for name in names:
                old, saved = self.root / name, backup / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                old.rename(saved)
                moved.append(name)
                (staging / name).rename(old)
                installed.append(name)
        except Exception:
            # Roll back only code; private state and configuration are untouched.
            try:
                for name in reversed(installed):
                    destination = self.root / name
                    if destination.is_dir():
                        shutil.rmtree(destination)
                    else:
                        destination.unlink()
                for name in reversed(moved):
                    (backup / name).rename(self.root / name)
            except OSError:
                raise ManagerError('Upgrade failed and rollback was incomplete. Keep the service stopped and recover code from the private code-backup directory.') from None
            raise ManagerError('Upgrade failed; previous code was restored and the service remains stopped.') from None
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        print('Code upgraded with a private backup. Start the bridge and reload the extension in Chrome.')

    def host_manifest(self) -> dict:
        return {
            'name': NATIVE_HOST, 'description': 'Local Copilot session relay for macOS',
            'path': str(self.root / 'native-host.command'), 'type': 'stdio',
            'allowed_origins': [f'chrome-extension://{EXTENSION_ID}/'],
        }

    def register_host(self) -> None:
        self.installed()
        expected = self.host_manifest()
        if self.host.exists() or self.host.is_symlink():
            if read_json(self.host) != expected:
                raise ManagerError('Another native host registration exists; it was not overwritten.')
            print('Native host is already registered for this installation.')
            return
        self.host.parent.mkdir(parents=True, exist_ok=True)
        exclusive_json(self.host, expected)
        print('Native host registered. Load the installed extension directory in Chrome.')

    def request(self, route: str, *, authenticate: bool = False, method: str = 'GET') -> dict:
        headers = {'Authorization': 'Bearer ' + self.key()} if authenticate else {}
        request = urllib.request.Request(f'http://127.0.0.1:{PORT}' + route,
                                         headers=headers, method=method,
                                         data=b'' if method == 'POST' else None)
        # Never route a loopback credential through ambient proxy settings.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=5) as response:
                value = json.load(response)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (urllib.error.URLError, OSError, ValueError):
            raise ManagerError('Local bridge request failed; check start/status and port conflicts.') from None

    def port_in_use(self) -> bool:
        with socket.socket() as sock:
            sock.settimeout(1)
            return sock.connect_ex(('127.0.0.1', PORT)) == 0

    def start(self) -> None:
        self.installed()
        if self.port_in_use():
            # Authentication must succeed with THIS installation's private key.
            self.request('/v1/models', authenticate=True)
        template = self.state / 'launch-agent.plist'
        require_regular(template, private=True)
        if self.plist.exists() or self.plist.is_symlink():
            require_regular(self.plist)
            if self.plist.read_bytes() != template.read_bytes():
                raise ManagerError('A different LaunchAgent already uses this label.')
        else:
            self.plist.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(self.plist, template.read_bytes())
        target = self.target + '/' + LABEL
        loaded = self.command(['launchctl', 'print', target])
        if loaded.returncode:
            result = self.command(['launchctl', 'bootstrap', self.target, str(self.plist)])
            if result.returncode:
                raise ManagerError('Could not load the LaunchAgent.')
        if self.command(['launchctl', 'kickstart', target]).returncode:
            raise ManagerError('Could not start the LaunchAgent.')
        for attempt in range(25):
            try:
                self.request('/v1/models', authenticate=True)
                break
            except ManagerError:
                if attempt == 24:
                    raise ManagerError('LaunchAgent loaded, but the bridge is not responding. Check status and the local service logs.') from None
                time.sleep(0.2)
        print('Bridge started; it will also start after user login.')

    def stop(self) -> None:
        self.installed()
        if self.plist.exists() or self.plist.is_symlink():
            require_regular(self.plist)
            if self.plist.read_bytes() != (self.state / 'launch-agent.plist').read_bytes():
                raise ManagerError('Refusing to remove a different LaunchAgent.')
        target = self.target + '/' + LABEL
        loaded = self.command(['launchctl', 'print', target])
        if loaded.returncode == 0 and self.command(['launchctl', 'bootout', target]).returncode:
            raise ManagerError('Could not stop the LaunchAgent.')
        if self.plist.exists():
            self.plist.unlink()
        print('Bridge stopped and login startup disabled.')

    def status(self) -> None:
        self.installed()
        self.request('/v1/models', authenticate=True)
        data = self.request('/healthz')
        # Explicit allowlist prevents accidental output of future sensitive fields.
        result = {k: data.get(k) for k in ('status', 'bridge', 'nativeAnthropic', 'tokenExpiresAt', 'reloadError', 'active')}
        expiry = data.get('tokenExpiresAt')
        result['sessionFresh'] = isinstance(expiry, (int, float)) and expiry > time.time() * 1000
        print(json.dumps(result, indent=2))

    def node(self) -> str:
        require_regular(self.state / 'launch-agent.plist', private=True)
        agent = plistlib.loads((self.state / 'launch-agent.plist').read_bytes())
        return agent['ProgramArguments'][0]

    def import_har(self, capture: Path) -> None:
        self.installed()
        capture = capture.expanduser().absolute()
        require_regular(capture)
        if capture == self.state / 'session.json':
            raise ManagerError('Use the original capture file as the source.')
        capture.chmod(0o600)
        result = self.command([self.node(), str(self.root / 'session-store.mjs'), 'import',
                               str(capture), str(self.state / 'session.json')], timeout=30)
        if result.returncode:
            raise ManagerError('Capture import failed. Use a fresh private HAR containing both verified model requests.')
        if self.port_in_use():
            self.request('/_internal/reload', authenticate=True, method='POST')
            print('Minimal session saved and running bridge reloaded. The source HAR was left untouched.')
        else:
            print('Minimal session saved. Start the bridge next. The source HAR was left untouched.')

    def fresh_session(self) -> None:
        snapshot = read_json(self.state / 'session.json', private=True)
        log = snapshot.get('log')
        entries = log.get('entries', []) if isinstance(log, dict) else []
        if not isinstance(entries, list) or len(entries) != 2:
            raise ManagerError('Import both verified models before configuring Claude.')
        for entry in entries:
            expiry = entry.get('_expiresAt') if isinstance(entry, dict) else None
            if not isinstance(expiry, (int, float)) or expiry <= time.time() * 1000:
                raise ManagerError('Refresh the expired Copilot session first.')

    def configure_claude(self) -> None:
        self.installed()
        self.fresh_session()
        self.request('/v1/models', authenticate=True)
        health = self.request('/healthz')
        if health.get('reloadError') or not isinstance(health.get('tokenExpiresAt'), (int, float)) or health['tokenExpiresAt'] <= time.time() * 1000:
            raise ManagerError('The running bridge needs a fresh session before Claude can be configured.')
        private_dir(self.settings.parent)
        exists = self.settings.exists() or self.settings.is_symlink()
        current = read_json(self.settings) if exists else {}
        if not isinstance(current.get('env', {}), dict):
            raise ManagerError('Claude env settings must be an object.')
        backup = self.state / 'claude-settings.before.json'
        if backup.exists() or backup.is_symlink():
            saved = read_json(backup, private=True)
            if not isinstance(saved.get('settings'), dict) or not isinstance(saved.get('existed'), bool):
                raise ManagerError('Invalid Claude settings backup; no settings changed.')
        else:
            exclusive_json(backup, {'existed': exists, 'settings': current})
        current.setdefault('env', {}).update(claude_environment(self.key()))
        current['model'] = OPUS
        atomic_write(self.settings, json_bytes(current))
        print('Claude CLI configured. Restart Claude Code; use --model opus or --model fable.')

    def restore(self) -> None:
        self.installed()
        backup = self.state / 'claude-settings.before.json'
        if backup.exists():
            saved = read_json(backup, private=True)
            before = saved.get('settings')
            if not isinstance(before, dict) or not isinstance(before.get('env', {}), dict):
                raise ManagerError('Invalid Claude settings backup.')
            if self.settings.exists() or self.settings.is_symlink():
                current = read_json(self.settings)
                if not isinstance(current.get('env', {}), dict):
                    raise ManagerError('Claude env settings must be an object.')
                env = current.setdefault('env', {})
                for name in claude_environment(''):
                    if name in before.get('env', {}):
                        env[name] = before['env'][name]
                    else:
                        env.pop(name, None)
                if not env and 'env' not in before:
                    current.pop('env', None)
                if 'model' in before:
                    current['model'] = before['model']
                else:
                    current.pop('model', None)
                atomic_write(self.settings, json_bytes(current))
        self.stop()
        print('Previous Claude routing restored; unrelated settings and the Chrome relay are retained.')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('setup', 'upgrade', 'start', 'stop', 'status', 'register-host', 'configure-claude', 'restore'):
        sub.add_parser(name)
    sub.add_parser('import-har').add_argument('capture', type=Path)
    args = parser.parse_args(argv)
    manager = Manager(Path(__file__).parent)
    try:
        if args.command == 'import-har':
            manager.import_har(args.capture)
        else:
            getattr(manager, args.command.replace('-', '_'))()
    except ManagerError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Never echo low-level paths, commands, headers, or file contents.
        print('Local operation failed; check prerequisites and private file permissions.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
