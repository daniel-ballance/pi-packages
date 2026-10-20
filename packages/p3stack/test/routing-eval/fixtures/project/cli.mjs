const [command = "help"] = process.argv.slice(2);
if (command === "export") console.log("[]");
else console.log("Usage: cli.mjs export");
