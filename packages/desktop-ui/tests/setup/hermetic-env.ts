for (const key of Object.keys(process.env)) {
  if (key.startsWith("STELLA_")) {
    delete process.env[key];
  }
}
