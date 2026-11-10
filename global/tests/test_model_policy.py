import json
import unittest
from pathlib import Path

GLOBAL = Path(__file__).resolve().parents[1]
EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
# The owner's realm, kept in step with Pareto's .pi/model-selection.json. The first matching
# rule decides; a model no rule matches is outside the realm.
REALM_EXCLUDE = ("claude-subscription/claude-haiku", "anthropic/claude-haiku")
REALM_EFFORTS = (
    ("openai-codex/gpt-6-luna", "medium", "max"),
    ("openai-codex/", "low", "xhigh"),
    ("openai/", "low", "xhigh"),
    ("claude-subscription/", "low", "high"),
    ("anthropic/", "low", "high"),
    ("xai/", "low", "high"),
)
PARENT_ONLY = ("claude-fable", "gpt-6-astra")


def rule_for(model):
    if model.startswith(REALM_EXCLUDE):
        return None
    return next((rule for rule in REALM_EFFORTS if model.startswith(rule[0])), None)


def outside_realm(ids):
    outside = []
    for configuration in ids:
        model, effort = configuration.rsplit(":", 1)
        rule = rule_for(model)
        inside = rule is not None and EFFORTS.index(rule[1]) <= EFFORTS.index(effort) <= EFFORTS.index(rule[2])
        if not inside or any(name in model for name in PARENT_ONLY):
            outside.append(configuration)
    return outside


def read(name):
    return json.loads((GLOBAL / name).read_text())


class ModelPolicyTest(unittest.TestCase):
    def test_rules_cap_floor_exclude_and_reserve(self):
        self.assertEqual(
            outside_realm([
                "openai-codex/gpt-6-luna:max", "openai-codex/gpt-6.1-sol:xhigh", "xai/grok-4.7:low",
                "openai-codex/gpt-6.1-sol:max", "openai-codex/gpt-6-luna:low", "claude-subscription/claude-opus-5-5:xhigh",
                "claude-subscription/claude-haiku-5-5:high", "claude-subscription/claude-fable-5-2:low", "google/gemini-3.1-pro:high",
            ]),
            [
                "openai-codex/gpt-6.1-sol:max", "openai-codex/gpt-6-luna:low", "claude-subscription/claude-opus-5-5:xhigh",
                "claude-subscription/claude-haiku-5-5:high", "claude-subscription/claude-fable-5-2:low", "google/gemini-3.1-pro:high",
            ],
        )

    def test_subagent_menu_is_inside_the_realm(self):
        self.assertEqual(outside_realm(model["id"] for model in read("subagents.json")["models"]), [])

    def test_p3stack_roles_are_on_the_menu(self):
        menu = {model["id"] for model in read("subagents.json")["models"]}
        ids = {
            model
            for value in read("p3stack.json")["roles"].values()
            for model in ([value] if isinstance(value, str) else value)
        }
        self.assertLessEqual(ids, menu)

    def test_scoped_models_are_realm_families(self):
        self.assertEqual([model for model in read("settings.json")["enabledModels"] if rule_for(model) is None], [])


if __name__ == "__main__":
    unittest.main()
