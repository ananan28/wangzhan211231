import tempfile
import unittest
from pathlib import Path

from nanfu_environments import batch_create, load_environments, new_environment, save_environments, validate_proxy


class EnvironmentTests(unittest.TestCase):
    def test_batch_is_independent_and_defaults_are_safe(self):
        items = batch_create("账号", 5, "socks5://127.0.0.1:1080")
        self.assertEqual(len({item["id"] for item in items}), 5)
        self.assertTrue(all(item["proxy_mode"] == "fixed" for item in items))
        self.assertTrue(all(not item["rotate_fingerprint_on_reload"] for item in items))

    def test_proxy_validation(self):
        self.assertEqual(validate_proxy("http://example.com:8080"), "http://example.com:8080")
        for value in ("socks5://host", "http://user:pass@host:8080",
                      "ftp://host:21", "http://host:99999"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_proxy(value)

    def test_round_trip_and_invalid_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "environments.json"
            items = [new_environment("测试", "http://127.0.0.1:8080")]
            save_environments(path, items)
            self.assertEqual(load_environments(path), items)
            path.write_text('{"version": 1, "environments": [{}]}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_environments(path)

    def test_batch_limit(self):
        for count in (0, 1001, True):
            with self.subTest(count=count), self.assertRaises(ValueError):
                batch_create("环境", count)


if __name__ == "__main__":
    unittest.main()
