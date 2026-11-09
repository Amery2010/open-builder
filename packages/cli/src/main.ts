import { runCli } from "./cli.js";

const controller = new AbortController();
function stop(): void {
  controller.abort();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    {
      out: (text) => {
        process.stdout.write(text);
      },
      err: (text) => {
        process.stderr.write(text);
      },
    },
    controller.signal,
  );
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
