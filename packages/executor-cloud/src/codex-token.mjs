const token = process.env.STELLA_CODEX_TURN_TOKEN?.trim();

if (!token) {
  process.stderr.write("STELLA_CODEX_TURN_TOKEN is not set.\n");
  process.exit(1);
}

process.stdout.write(`${token}\n`);
