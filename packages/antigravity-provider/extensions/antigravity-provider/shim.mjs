import { createConnection } from "node:net";

const path = process.env.PI_ANTIGRAVITY_BRIDGE;
if (!path) throw new Error("Pi's Antigravity bridge socket was not provided.");
const socket = createConnection(path);
socket.once("error", error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
socket.once("close", () => {
  process.stdin.unpipe(socket);
  process.stdin.pause();
});
process.stdout.once("error", () => socket.destroy());
process.stdin.pipe(socket).pipe(process.stdout);
