import json
import unittest
from pathlib import Path

GLOBAL = Path(__file__).resolve().parents[1]
# The owner's choice: Anthropic and Grok models stop at high thinking; GPT models are uncapped.
CAPPED_PROVIDERS = {"anthropic", "claude-subscription", "xai"}
ABOVE_HIGH = {"xhigh", "max"}


def above_cap(ids):
    return [
        model
        for model in ids
        if model.split("/", 1)[0] in CAPPED_PROVIDERS
        and model.rsplit(":", 1)[-1] in ABOVE_HIGH
    ]


class ModelPolicyTest(unittest.TestCase):
    def test_subagent_menu_caps_anthropic_and_grok_at_high(self):
        models = json.loads((GLOBAL / "subagents.json").read_text())["models"]
        self.assertEqual(above_cap(model["id"] for model in models), [])

    def test_p3stack_roles_are_on_the_menu_and_within_the_cap(self):
        menu = {
            model["id"]
            for model in json.loads((GLOBAL / "subagents.json").read_text())["models"]
        }
        roles = json.loads((GLOBAL / "p3stack.json").read_text())["roles"]
        ids = {
            model
            for value in roles.values()
            for model in ([value] if isinstance(value, str) else value)
        }
        self.assertEqual(above_cap(ids), [])
        self.assertLessEqual(ids, menu)


if __name__ == "__main__":
    unittest.main()
