"""Offline link/repair tests. Every test uses a disposable HOME and repo."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]
FILES = ("settings.json", "models.json", "mcp.json", "subagents.json")


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.repo = self.root / "repo" / "pi"
        self.repo.mkdir(parents=True)
        shutil.copy2(SOURCE / "link.sh", self.repo / "link.sh")
        (self.repo / "hooks").mkdir()
        shutil.copy2(SOURCE / "hooks/theme-set-relink-pi-config", self.repo / "hooks/theme-set-relink-pi-config")
        for name in FILES:
            (self.repo / name).write_text(json.dumps({"source": name}))
        self.agent = self.home / ".pi/agent"
        self.env = {k: v for k, v in os.environ.items() if k not in ("PI_AGENT_DIR", "PI_CODING_AGENT_DIR")}
        self.env["HOME"] = str(self.home)

    def run_link(self, *args, **env):
        return subprocess.run(["bash", str(self.repo / "link.sh"), *args], env=self.env | env,
                              text=True, capture_output=True)

    def assert_links(self, directory=None):
        for name in FILES:
            target = (directory or self.agent) / name
            self.assertTrue(target.is_symlink(), target)
            # macOS puts temp dirs under /var, a symlink to /private/var.
            self.assertEqual(target.resolve(), (self.repo / name).resolve())

    def test_check_is_read_only_and_link_is_idempotent(self):
        self.assertNotEqual(self.run_link("--check").returncode, 0)
        self.assertFalse(self.agent.exists())
        self.assertEqual(self.run_link().returncode, 0)
        self.assert_links()
        self.assertEqual(self.run_link("--check").returncode, 0)
        self.assertEqual(self.run_link().returncode, 0)
        self.assertEqual(list(self.agent.glob("pi-config-backup.*")), [])

    def test_existing_file_and_broken_symlink_are_preserved(self):
        self.agent.mkdir(parents=True)
        (self.agent / "settings.json").write_text('{"keep": true}')
        (self.agent / "models.json").symlink_to("missing.json")
        self.assertEqual(self.run_link().returncode, 0)
        self.assert_links()
        copies = list(self.agent.glob("pi-config-backup.*/settings.json"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_text(), '{"keep": true}')
        links = list(self.agent.glob("pi-config-backup.*/models.json"))
        self.assertEqual(len(links), 1)
        self.assertEqual(os.readlink(links[0]), "missing.json")
        self.assertEqual(list(self.agent.glob(".pi-link.*")), [])

    def test_invalid_source_does_not_partially_link(self):
        for value in ('{"broken":', '[]', '{} {}'):
            with self.subTest(value=value):
                (self.repo / "subagents.json").write_text(value)
                self.assertNotEqual(self.run_link().returncode, 0)
                self.assertFalse(self.agent.exists())

    def test_missing_source_or_directory_target_refuses_before_changes(self):
        (self.repo / "subagents.json").unlink()
        self.assertNotEqual(self.run_link().returncode, 0)
        self.assertFalse(self.agent.exists())
        (self.repo / "subagents.json").write_text("{}")
        (self.agent / "subagents.json").mkdir(parents=True)
        self.assertNotEqual(self.run_link().returncode, 0)
        self.assertFalse((self.agent / "settings.json").exists())

    def test_custom_directory_and_legacy_alias(self):
        custom = self.root / "custom"
        legacy = self.root / "legacy"
        result = self.run_link(PI_CODING_AGENT_DIR=str(custom), PI_AGENT_DIR=str(legacy))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_links(custom)
        self.assertFalse(legacy.exists())
        self.assertFalse(self.agent.exists())
        self.assertEqual(self.run_link(PI_AGENT_DIR=str(legacy)).returncode, 0)
        self.assert_links(legacy)

    def test_invalid_arguments_do_not_write(self):
        for args in (("--bogus",), ("--check", "extra"), ("",)):
            self.assertEqual(self.run_link(*args).returncode, 2)
        self.assertFalse(self.agent.exists())

    def test_hook_repairs_omarchy_home_not_custom_pi_directory(self):
        custom = self.root / "custom"
        result = subprocess.run(["bash", str(self.repo / "hooks/theme-set-relink-pi-config")],
                                env=self.env | {"PI_CODING_AGENT_DIR": str(custom)}, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_links()
        self.assertFalse(custom.exists())


if __name__ == "__main__":
    unittest.main()
