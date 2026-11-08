import { expect, test } from "vitest";
import { mean } from "../src/mean";

test("mean", () => expect(mean([1, 2, 3])).toBe(2));
