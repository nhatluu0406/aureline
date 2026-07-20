setInterval(() => {}, 1_000);

process.on("SIGTERM", () => {
  // The fixture intentionally stays alive. Its owner must terminate the tree.
});
