import { UpgradoorEngine } from "./engine.js";
import { UpgradoorError } from "./errors.js";
import type { Verdict } from "./types.js";

const EXIT_CODES: Record<Verdict, number> = {
  SAFE: 0,
  UNSAFE: 1,
  REVIEW_REQUIRED: 3,
  INCOMPLETE: 4,
};

// Refine UNSAFE exit code based on highest severity
function getExitCode(verdict: Verdict, highestSeverity: string | null): number {
  if (verdict === "UNSAFE") {
    if (highestSeverity === "CRITICAL") return 1;
    if (highestSeverity === "HIGH") return 2;
  }
  return EXIT_CODES[verdict];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const proxyAddress = get("--proxy");
  const oldImpl = get("--old");
  const newImpl = get("--new");
  const rpcUrl = get("--rpc");

  if (!proxyAddress || !oldImpl || !newImpl || !rpcUrl) {
    console.error(
      JSON.stringify({
        error: "INPUT_ERROR",
        message: "Usage: check.js --proxy <addr> --old <path> --new <path> --rpc <url>",
      }),
    );
    process.exit(10);
  }

  try {
    const engine = new UpgradoorEngine();
    const result = await engine.analyze({
      proxyAddress,
      oldImplementationPath: oldImpl,
      newImplementationPath: newImpl,
      rpcUrl,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(getExitCode(result.verdict, result.highestSeverity));
  } catch (err) {
    if (err instanceof UpgradoorError) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exit(10);
    }
    console.error(JSON.stringify({ error: "RUNTIME_ERROR", message: String(err) }));
    process.exit(12);
  }
}

main();
