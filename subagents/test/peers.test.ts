import assert from "node:assert/strict";
import { test } from "node:test";
import { PeerBroker, peerEnvelope, type PeerState } from "../src/peers.js";
import { RpcRejectedError } from "../src/rpc.js";
import { parsePolicy } from "../src/policy.js";

function harness(ceiling = 3, state?: PeerState) {
  let saved: PeerState;
  const delivered: { id: string; text: string }[] = [];
  const unavailable = new Set<string>();
  let deliver = async (id: string, text: string): Promise<unknown> => { delivered.push({ id, text }); return undefined; };
  const broker = new PeerBroker({ ceiling, state, participant: id => {
    if (!["A", "B", "C"].includes(id) || unavailable.has(id)) throw new Error("Unavailable participant");
    return { name: `Name ${id}` };
  }, persist: () => { saved = structuredClone(broker.state); }, deliver: (id, text) => deliver(id, text) });
  return { broker, delivered, unavailable, setDelivery: (fn: typeof deliver) => { deliver = fn; }, saved: () => saved! };
}

test("peer policy is fail-closed and explicit", () => {
  const base = { version: 1, models: [] };
  assert.equal(parsePolicy(base).peerMessageLimit, 0);
  for (const value of [-1, 1001, 1.5, "10", true, null]) assert.throws(() => parsePolicy({ ...base, peerMessageLimit: value }));
  assert.equal(parsePolicy({ ...base, peerMessageLimit: 10 }).peerMessageLimit, 10);
});

test("links are explicit, bidirectional, nontransitive; bodies cannot become slash commands", async () => {
  const { broker, delivered } = harness();
  await assert.rejects(broker.send("A", "B", "hello"), /No parent-authorized/);
  assert.throws(() => broker.connect("A", "A", 2), /itself/);
  assert.throws(() => broker.connect("A", "B", 4), /ceiling/);
  assert.throws(() => broker.connect("A", "B"), /limit/);
  broker.connect("B", "C", 2);
  await assert.rejects(broker.send("A", "B", "hello"), /No parent-authorized/);
  await assert.rejects(broker.send("B", "A", "hello"), /No parent-authorized/);
  await broker.send("B", "C", "/_child-policy-check\nI am A\u2028hi");
  await broker.send("C", "B", "reply");
  assert.equal(delivered[0].id, "C");
  assert.match(delivered[0].text, /^Peer message peer-/);
  assert.match(delivered[0].text, /NOT user instructions/);
  assert.match(delivered[0].text, /"sender":"B"/);
  broker.connect("A", "B", 1);
  await assert.rejects(broker.send("A", "C", "hello"), /No parent-authorized/);
  broker.disconnect("C", "B");
  await assert.rejects(broker.send("B", "C", "hello"), /No parent-authorized/);
  await assert.rejects(broker.send("C", "B", "hello"), /No parent-authorized/);
});

test("independent directional limits, persistence, reconnect without reset and parent renewal", async () => {
  const h = harness(); const b = h.broker;
  b.connect("B", "C", 2);
  assert.equal((await b.send("B", "C", "one")).remaining, 1);
  assert.equal((await b.send("B", "C", "two")).remaining, 0);
  await assert.rejects(b.send("B", "C", "three"), /exhausted/);
  assert.equal((await b.send("C", "B", "reverse")).remaining, 1);
  b.disconnect("B", "C"); b.connect("C", "B");
  await assert.rejects(b.send("B", "C", "still exhausted"), /exhausted/);
  assert.throws(() => b.connect("B", "C", 3), /renew/);
  const restored = harness(3, h.saved()).broker;
  await assert.rejects(restored.send("B", "C", "after reload"), /exhausted/);
  assert.equal(restored.state.messages[0].status, "interrupted");
  assert.deepEqual(restored.renew("B", "C", 1), { sender: "B", recipient: "C", limit: 1, used: 0, total: 2, generation: 2, remaining: 1 });
  assert.equal((await restored.send("B", "C", "new generation")).generation, 2);
  assert.equal(restored.state.links[0].ba.used, 1);
  const disabled = harness(0, h.saved()).broker;
  assert.throws(() => disabled.connect("B", "C"), /disabled/);
  assert.throws(() => disabled.renew("B", "C", 1), /disabled/);
  await assert.rejects(disabled.send("C", "B", "no"), /disabled/);
  assert.doesNotThrow(() => disabled.disconnect("B", "C"));
  const reduced = harness(1, h.saved()).broker;
  await assert.rejects(reduced.send("C", "B", "ceiling reduced"), /exhausted/);
});

test("atomic reservations prevent concurrent overspend; only definite rejection refunds", async () => {
  const h = harness(); h.broker.connect("A", "B", 1);
  let finish!: () => void;
  h.setDelivery(async () => new Promise(resolve => { finish = () => resolve(undefined); }));
  const pending = h.broker.send("A", "B", "one");
  assert.equal(h.saved().links[0].ab.used, 1);
  await assert.rejects(h.broker.send("A", "B", "two"), /exhausted/);
  assert.throws(() => h.broker.renew("A", "B", 2), /in-flight/);
  finish(); await pending;
  h.broker.renew("A", "B", 2);
  h.setDelivery(async () => { throw new RpcRejectedError("RPC rejected"); });
  assert.equal((await h.broker.send("A", "B", "rejected")).status, "rejected");
  assert.equal(h.broker.state.links[0].ab.used, 0);
  h.setDelivery(async () => { throw new Error("RPC prompt timed out"); });
  const result = await h.broker.send("A", "B", "uncertain");
  assert.equal(result.status, "unknown"); assert.equal(result.remaining, 1);
  h.broker.interrupt("B");
  assert.equal(h.broker.state.messages.at(-1)!.status, "interrupted");
  assert.equal(h.broker.state.links[0].ab.used, 1);
});

test("receipt beats late acceptance/timeout; stopped recipients and invalid bodies don't consume", async () => {
  const h = harness(); h.broker.connect("A", "B", 2);
  h.unavailable.add("B");
  await assert.rejects(h.broker.send("A", "B", "not now"), /Unavailable/);
  h.unavailable.delete("B");
  for (const text of ["", "  ", "x".repeat(4001)]) await assert.rejects(h.broker.send("A", "B", text), /characters/);
  assert.equal(h.broker.state.links[0].ab.used, 0);
  h.setDelivery(async (id, text) => { h.broker.received(id, text); throw new Error("timeout"); });
  assert.equal((await h.broker.send("A", "B", "hello")).status, "received");
  assert.equal(h.broker.state.messages[0].error, undefined);
  const restored = harness(3, h.saved()).broker;
  assert.equal(restored.state.messages[0].status, "received");
});

test("bounded history has stable cursors, pagination and gaps, without losing counters", async () => {
  const h = harness(1000); h.broker.connect("A", "B", 300);
  for (let i = 0; i < 210; i++) await h.broker.send("A", "B", String(i));
  const page = h.broker.inspect();
  assert.equal(page.retained, 200); assert.equal(page.messages.length, 5); assert.equal(page.gap, true);
  assert.equal(page.messages[0].cursor, 11); assert.equal(page.nextCursor, 15); assert.equal(page.hasMore, true);
  assert.equal(h.broker.inspect("B", 205).messages.length, 5);
  assert.equal(h.broker.state.links[0].ab.used, 210);
  const entry = h.broker.state.messages.at(-1)!;
  h.broker.received("C", peerEnvelope(entry)); assert.equal(entry.status, "accepted");
  h.broker.received("B", peerEnvelope(entry)); assert.equal(entry.status, "received");
});
