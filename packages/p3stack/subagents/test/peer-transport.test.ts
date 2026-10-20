import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { test } from "node:test";
import { PeerClient, servePeer } from "../extensions/subagents/src/peer-transport.js";
import { RpcChild, type Packet } from "../extensions/subagents/src/rpc.js";

async function pair() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const accept = once(server, "connection");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = connect(address.port, "127.0.0.1");
  const [remote] = await accept as [Socket];
  return { client, remote, close: () => { client.destroy(); remote.destroy(); server.close(); } };
}

test("peer wire rejects sender spoofing and duplicate IDs; bounds frames", async () => {
  const p = await pair(); let calls = 0;
  try {
    servePeer(p.remote, async () => { calls++; return {}; });
    const response = once(p.client, "data");
    p.client.write(JSON.stringify({ id: 1, recipient: "B", message: "hello", sender: "C" }) + "\n");
    assert.equal(JSON.parse(String((await response)[0])).success, false); assert.equal(calls, 0);
    const closed = once(p.client, "close");
    p.client.write(JSON.stringify({ id: 1, recipient: "B", message: "replay" }) + "\n");
    await closed; assert.equal(calls, 0);
  } finally { p.close(); }
  const q = await pair();
  try {
    servePeer(q.remote, async () => { throw new Error("must not deliver"); });
    const closed = once(q.client, "close"); q.client.write("x".repeat(65537)); await closed;
  } finally { q.close(); }
});

test("client correlation, Unicode framing, timeout/cancellation and pending cap", async () => {
  const p = await pair(); const client = new PeerClient(p.client);
  try {
    servePeer(p.remote, async packet => {
      if (packet.message === "hold") return new Promise(() => {});
      return { recipient: packet.recipient, message: packet.message };
    });
    assert.deepEqual(await client.send("B", "a\u2028b\u2029c"), { recipient: "B", message: "a\u2028b\u2029c" });
    await assert.rejects(client.send("B", "hold", undefined, 10), /acceptance may be unknown/);
    const controller = new AbortController();
    const waiting = client.send("B", "hold", controller.signal); controller.abort();
    await assert.rejects(waiting, /acceptance may be unknown/);
    const pending = Array.from({ length: 8 }, () => client.send("B", "hold").catch(error => error));
    assert.throws(() => client.send("B", "over cap"), /Too many/);
    client.close(); await Promise.all(pending);
  } finally { client.close(); p.close(); }
});

test("peer-enabled executable launch failure remains cleanly stoppable", async () => {
  const child = new RpcChild({ executable: "/definitely-missing-peer-test-program", args: [], cwd: process.cwd(), env: {},
    event: () => {}, stderr: () => {}, exit: () => {}, peerRequest: async () => ({}) });
  await assert.rejects(child.request({ type: "get_state" }));
  await child.stop(); await child.closed;
});

test("actual inherited pipe is independent of Pi stdout RPC and identity comes from owner", async () => {
  const events: Packet[] = [], requests: Packet[] = [];
  const script = `
    const {Socket}=require('node:net');
    const peer=new Socket({fd:Number(process.env.PI_SUBAGENT_PEER_FD),readable:true,writable:true});
    peer.setEncoding('utf8');
    peer.on('data', data=>process.stdout.write(JSON.stringify({type:'peer_result',data:JSON.parse(data)})+'\\n'));
    process.stdin.setEncoding('utf8'); let buffer='';
    process.stdin.on('data', chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){
      const p=JSON.parse(buffer.slice(0,n)); buffer=buffer.slice(n+1);
      if(p.type==='sendPeer')peer.write(JSON.stringify({id:1,recipient:'B',message:'hello'})+'\\n');
      process.stdout.write(JSON.stringify({type:'response',id:p.id,success:true,data:{fd:process.env.PI_SUBAGENT_PEER_FD}})+'\\n');
    }});
  `;
  const child = new RpcChild({ executable: process.execPath, args: ["-e", script], cwd: process.cwd(), env: { ...process.env, PI_SUBAGENT_PEER_FD: "999" },
    event: e => events.push(e), stderr: () => {}, exit: () => {}, peerRequest: async packet => { requests.push(packet); return { sender: "owner-A", remaining: 1 }; } });
  try {
    assert.deepEqual(await child.request({ type: "sendPeer" }), { fd: "3" });
    for (let i = 0; i < 100 && !events.some(e => e.type === "peer_result"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(requests, [{ id: 1, recipient: "B", message: "hello" }]);
    assert.equal(events.find(e => e.type === "peer_result")?.data.data.sender, "owner-A");
  } finally { await child.stop(); }
});
